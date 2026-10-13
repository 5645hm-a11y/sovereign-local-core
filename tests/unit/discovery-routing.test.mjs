import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { DiscoveryRouting, normalizeDiscoveryRouting } from "../../dist/discovery-routing.js";
import { discoveryToken } from "../../dist/discovery-crypto.js";
import { NostrDiscovery } from "../../dist/nostr-discovery.js";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

async function wait(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await pause(10); }
  throw new Error("Routing condition timed out");
}

test("routing addresses are deterministic and project separated; bounded samples cover every bucket", async () => {
  const topic = discoveryToken(), id = discoveryToken();
  for (const bucketCount of [2, 4, 64, 1024, 4096]) {
    const directory = await DiscoveryRouting.create(topic, id, { bucketCount });
    const copy = await DiscoveryRouting.create(topic, id, { bucketCount });
    assert.equal(directory.inbox, copy.inbox); assert.equal(directory.presence, copy.presence);
    assert.notEqual(directory.inbox, topic); assert.notEqual(directory.presence, topic);
    const seen = new Set();
    for (let round = 0; round < Math.ceil((bucketCount - 1) / directory.config.sampleBuckets); round++) {
      const indices = directory.sampleIndices(round);
      assert.equal(new Set(indices).size, directory.config.sampleBuckets);
      assert.ok(!indices.includes(directory.ownBucket)); indices.forEach(index => seen.add(index));
    }
    assert.equal(seen.size, bucketCount - 1);
    assert.equal(await copy.target(id), directory.inbox);
    assert.equal(await copy.target(null), directory.presence);
    const foreign = await DiscoveryRouting.create(discoveryToken(), id, { bucketCount });
    assert.notEqual(foreign.inbox, directory.inbox); assert.notEqual(foreign.presence, directory.presence);
  }
  const other = await DiscoveryRouting.create(topic, discoveryToken(), {});
  const first = await DiscoveryRouting.create(topic, id, {});
  assert.notEqual(first.inbox, other.inbox);
  assert.throws(() => first.sampleIndices(-1)); assert.throws(() => first.sampleIndices(Number.MAX_SAFE_INTEGER));
  assert.throws(() => first.target("invalid"));
});

test("routing refuses incompatible or unbounded configuration before opening sockets", () => {
  for (const routing of [{ bucketCount: 1 }, { bucketCount: 3 }, { bucketCount: 8192 }, { sampleBuckets: 0 },
    { sampleBuckets: 9 }, { bucketCount: 4, sampleBuckets: 4 }, { rotationIntervalMs: 99 }, { rotationIntervalMs: Infinity },
    { rotationIntervalMs: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => normalizeDiscoveryRouting(routing)); assert.throws(() => new NostrDiscovery({ routing }));
  }
  assert.equal(new NostrDiscovery().supportsRouting, false);
  assert.equal(new NostrDiscovery({ routing: {} }).supportsRouting, true);
});

test("routed Nostr targets one inbox, rotates bounded subscriptions, rejects wrong/stale routes and reconnects", async () => {
  const relay = await startMockNostrRelay(), topic = discoveryToken(), ids = [discoveryToken(), discoveryToken(), discoveryToken()];
  const packets = ids.map(() => []), errors = [];
  const providers = ids.map((_, i) => new NostrDiscovery({ relays: [`${relay.url}/peer-${i}`], timeoutMs: 5000,
    routing: { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 150 }, onError: e => errors.push(e.message) }));
  const start = () => Promise.all(providers.map((provider, i) => provider.startRouted(topic, ids[i], p => packets[i].push([...p]))));
  try {
    await start(); await wait(() => relay.activeSubscriptions === 6);
    await providers[0].publishRouted(new Uint8Array([1, 2, 3]), ids[1]);
    await wait(() => packets[1].length === 1);
    assert.deepEqual(packets.map(p => p.length), [0, 1, 0]);
    assert.equal(relay.deliveries.filter(d => d.id === relay.events[0].id).length, 1);
    const initialInbox = relay.requests.find(r => r.address === "/peer-1" && r.topics.length === 2);
    const initialSample = relay.requests.filter(r => r.address === "/peer-1")[1];
    await wait(() => relay.requests.filter(r => r.address === "/peer-1").length >= 3);
    assert.equal(relay.activeSubscriptions, 6);
    // Inbox stays subscribed while only sample IDs are replaced.
    assert.equal(relay.requests.filter(r => r.id === initialInbox.id).length, 1);
    const rejected = providers[2].stats.rejected;
    relay.broadcast(relay.events[0]); await wait(() => providers[2].stats.rejected > rejected);
    assert.deepEqual(packets.map(p => p.length), [0, 1, 0]);
    const beforeStale = providers[1].stats.rejected;
    relay.inject("/peer-1", initialSample.id, { nonsense: true });
    await pause(40); assert.equal(providers[1].stats.rejected, beforeStale);
    await providers[0].publishRouted(new Uint8Array([4]), ids[1]); await wait(() => packets[1].length === 2);
    assert.ok(relay.events.every(e => !e.tags.some(t => t[1] === topic)));
    assert.ok(relay.requests.every(r => r.topics.length <= 2 && !r.topics.includes(topic)));
    await assert.rejects(providers[0].publish(new Uint8Array([8])), /recipient/);
    relay.disconnect(); await wait(() => providers.every(p => p.stats.reconnects > 0));
    // Server-side REQs can arrive before the clients process EOSE; wait for usable sockets too.
    await wait(() => relay.activeSubscriptions === 6 && providers.every(p =>
      [...p.relays.values()].some(r => r.ready && r.socket.readyState === WebSocket.OPEN)));
    await providers[0].publishRouted(new Uint8Array([5]), ids[1]); await wait(() => packets[1].length === 3);
    assert.deepEqual(packets[1], [[1, 2, 3], [4], [5]]);
    providers.forEach(p => p.stop()); await wait(() => relay.activeSubscriptions === 0);
    const requests = relay.requests.length; await pause(200); assert.equal(relay.requests.length, requests);
  } finally { providers.forEach(p => p.stop()); await relay.close(); }
});

test("rotating presence discovers other buckets; routed startup cancellation cannot resurrect sockets", async () => {
  const relay = await startMockNostrRelay(), topic = discoveryToken(), aId = discoveryToken(), bId = discoveryToken();
  // Parallel crypto/large-history test workers can delay localhost startup beyond one second.
  const options = { relays: [relay.url], timeoutMs: 5000, routing: { bucketCount: 8, sampleBuckets: 1, rotationIntervalMs: 100 } };
  const a = new NostrDiscovery(options), b = new NostrDiscovery(options), received = [];
  let timer;
  try {
    const starting = a.startRouted(topic, aId, () => {}); a.stop(); await assert.rejects(starting, /cancelled/);
    assert.equal(relay.requests.length, 0);
    await Promise.all([a.startRouted(topic, aId, () => {}), b.startRouted(topic, bId, p => received.push([...p]))]);
    timer = setInterval(() => { void a.publishRouted(new Uint8Array([9]), null).catch(() => {}); }, 50);
    await wait(() => received.length > 0); assert.deepEqual(received[0], [9]);
    assert.ok(relay.activeSubscriptions <= 4);
  } finally { clearInterval(timer); a.stop(); b.stop(); await relay.close(); }
});

test("concurrent routed delivery from multiple relays is deduplicated after signature verification", async () => {
  const relays = await Promise.all([startMockNostrRelay(), startMockNostrRelay()]);
  const options = { relays: relays.map(r => r.url), timeoutMs: 5000, routing: { bucketCount: 4, sampleBuckets: 1 } };
  const a = new NostrDiscovery(options), b = new NostrDiscovery(options), packets = [], topic = discoveryToken(), id = discoveryToken();
  try {
    await Promise.all([a.startRouted(topic, discoveryToken(), () => {}), b.startRouted(topic, id, p => packets.push([...p]))]);
    await wait(() => relays.every(r => r.activeSubscriptions === 4));
    await a.publishRouted(new Uint8Array([6]), id); await wait(() => packets.length > 0); await pause(50);
    assert.deepEqual(packets, [[6]]); assert.equal(b.stats.received, 1);
    assert.equal(relays[0].events[0].id, relays[1].events[0].id);
  } finally { a.stop(); b.stop(); await Promise.all(relays.map(r => r.close())); }
});

test("stopping a queued routed publish prevents its emission into a restarted project", async () => {
  const relay = await startMockNostrRelay(), provider = new NostrDiscovery({ relays: [relay.url], timeoutMs: 1000, routing: {} });
  try {
    await provider.startRouted(discoveryToken(), discoveryToken(), () => {});
    const publishing = provider.publishRouted(new Uint8Array([7]), discoveryToken()); provider.stop();
    await assert.rejects(publishing, /replaced/);
    await provider.startRouted(discoveryToken(), discoveryToken(), () => {});
    assert.equal(relay.events.length, 0);
    await provider.publishRouted(new Uint8Array([8]), null); assert.equal(relay.events.length, 1);
  } finally { provider.stop(); await relay.close(); }
});
