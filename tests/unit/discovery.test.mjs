import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Device, alice, bob, projectId, store } from "../helpers/core-fixtures.mjs";
import { LocalCore } from "../../dist/engine.js";
import { ProjectContext } from "../../dist/project.js";
import { SyncSession } from "../../dist/sync-session.js";
import { discoveryToken, deriveDiscoveryMaterial, discoveryPayload, sealDiscoveryPayload, DiscoveryReplayWindow } from "../../dist/discovery-crypto.js";
import { NostrDiscovery } from "../../dist/nostr-discovery.js";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

async function pair() {
  const project = await ProjectContext.create(alice, projectId), state = await project.evaluate([]);
  const invitation = await project.invite(bob.actorId, "Member", 0, state);
  const bobProject = await ProjectContext.open(invitation, bob, projectId);
  const a = await LocalCore.open(await store(new Device()), alice, project);
  const b = await LocalCore.open(await store(new Device(), bob), bob, bobProject);
  return { a, b, project, bobProject };
}

const hello = () => ({ kind: "hello", from: discoveryToken(), to: null, session: null, challenge: null, response: null, description: null, candidate: null });
async function wait(predicate) { for (let i = 0; i < 400; i++) { if (await predicate()) return; await pause(10); } throw new Error("Condition timed out"); }

test("Worker-compatible discovery derives the same opaque topic, seals IPs and rejects replay, tamper and foreign projects", async () => {
  const { a, b, project } = await pair();
  try {
    const [left, right] = await Promise.all([a.getDiscoveryInfo(), b.getDiscoveryInfo()]);
    assert.equal(left.topic, right.topic); assert.notEqual(left.actorId, right.actorId);
    assert.match(left.topic, /^[A-Za-z0-9_-]{43}$/); assert.ok(!left.topic.includes("test-project"));
    const signal = { ...hello(), kind: "offer", to: discoveryToken(), session: discoveryToken(), challenge: discoveryToken(), response: discoveryToken(),
      description: { type: "offer", sdp: "v=0\r\nc=IN IP4 203.0.113.42\r\na=fingerprint:sha-256 test\r\n" } };
    const packet = await a.sealDiscovery(signal);
    assert.ok(!new TextDecoder().decode(packet).includes("203.0.113.42"));
    const opened = await b.openDiscovery(packet); assert.deepEqual(opened.signal, signal); assert.equal(opened.actorId, alice.actorId);
    await assert.rejects(b.openDiscovery(packet), { name: "DiscoveryReplayError" });
    const changed = packet.slice(); changed[changed.length - 1] ^= 1;
    await assert.rejects(b.openDiscovery(changed));
    const state = await project.evaluate([]), key = state.keys.get(state.currentKeyId);
    const wrongProject = { ...project.descriptor, projectId: "different-project" };
    const wrongPacket = await sealDiscoveryPayload(discoveryPayload(wrongProject, key.id, alice.actorId, project.certificate, hello()), await deriveDiscoveryMaterial(wrongProject, key), alice.privateKey);
    await assert.rejects(b.openDiscovery(wrongPacket));
  } finally { await a.close(); await b.close(); }
});

test("a key holder cannot impersonate another actor; forged certificates and stale signed discovery are rejected", async () => {
  const { a, b, project, bobProject } = await pair();
  const state = await project.evaluate([]), key = state.keys.get(state.currentKeyId), material = await deriveDiscoveryMaterial(project.descriptor, key);
  try {
    const payload = discoveryPayload(project.descriptor, key.id, alice.actorId, project.certificate, hello());
    await assert.rejects(b.openDiscovery(await sealDiscoveryPayload(payload, material, bob.privateKey)), /signature/);
    const stale = { ...payload, nonce: discoveryToken(), issuedAt: Date.now() - 180000, expiresAt: Date.now() - 120000 };
    await assert.rejects(b.openDiscovery(await sealDiscoveryPayload(stale, material, alice.privateKey)), /time window/);
    const fake = { ...payload, certificate: { ...bobProject.certificate, subject: alice.actorId } };
    await assert.rejects(b.openDiscovery(await sealDiscoveryPayload(fake, material, alice.privateKey)));
    assert.equal((await b.readEvents()).length, 0);
  } finally { await a.close(); await b.close(); }
});

test("revocation rotates rendezvous material, rejects old epoch packets and removes discovery authority", async () => {
  const { a, b } = await pair();
  try {
    await a.inviteMember(bob.actorId);
    const previous = await a.getDiscoveryInfo(), oldPacket = await b.sealDiscovery(hello());
    const { event } = await a.revokeMember(bob.actorId);
    assert.notEqual((await a.getDiscoveryInfo()).topic, previous.topic);
    await assert.rejects(a.openDiscovery(oldPacket));
    await b.ingestEvents([event]);
    await assert.rejects(b.sealDiscovery(hello()), /revoked/);
    await assert.rejects(b.getDiscoveryInfo(), /revoked/);
  } finally { await a.close(); await b.close(); }
});

test("replay cache never evicts a still-valid nonce to admit more traffic", () => {
  const window = new DiscoveryReplayWindow(), now = 100000;
  const payload = { actorId: alice.actorId, nonce: "first", issuedAt: now, expiresAt: now + 60000 };
  window.accept(payload, now);
  for (let i = 1; i < 4096; i++) window.accept({ ...payload, nonce: String(i) }, now);
  assert.throws(() => window.accept({ ...payload, nonce: "overflow" }, now), /full/);
  assert.throws(() => window.accept(payload, now), { name: "DiscoveryReplayError" });
  assert.throws(() => window.accept(payload, now + 90001), /time window/);
});

test("stream sync handles split/coalesced frame prefixes, bidirectional edits and bounded frames", async () => {
  const { a, b } = await pair(), writes = [];
  const stream = () => new TransformStream({ transform(bytes, controller) {
    writes.push(bytes.length);
    for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
  } });
  const ab = stream(), ba = stream();
  const sa = new SyncSession(a), sb = new SyncSession(b);
  try {
    await a.dispatch({ type: "ITEM_ADDED", itemId: "streamed", fields: { text: "initial" } });
    sa.connect({ readable: ba.readable, writable: ab.writable, maxFrameBytes: 73, close() {} });
    sb.connect({ readable: ab.readable, writable: ba.writable, maxFrameBytes: 73, close() {} });
    await wait(() => sa.state === "online" && sb.state === "online");
    const text = "🙂שלום".repeat(400);
    await b.dispatch({ type: "ITEM_UPDATED", itemId: "streamed", fields: { text } });
    await wait(async () => (await a.snapshot()).items[0]?.fields.text === text);
    assert.deepEqual((await a.snapshot()).items, (await b.snapshot()).items);
    assert.ok(writes.length > 100); assert.ok(writes.every(n => n <= 77));
  } finally { sa.stop(); sb.stop(); await a.close(); await b.close(); }
});

test("Nostr uses canonical signed NIP-01 events, subscribes before publishing and deduplicates relays", async () => {
  const relay = await startMockNostrRelay();
  const a = new NostrDiscovery({ relays: [relay.url], timeoutMs: 1000 }), b = new NostrDiscovery({ relays: [relay.url], timeoutMs: 1000 });
  const topic = discoveryToken(), packets = [];
  try {
    await Promise.all([a.start(topic, () => {}), b.start(topic, packet => packets.push(packet))]);
    const packet = crypto.getRandomValues(new Uint8Array(64)); await a.publish(packet); await wait(() => packets.length === 1);
    assert.deepEqual(packets[0], packet);
    const e = relay.events[0];
    assert.equal(e.id, createHash("sha256").update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest("hex"));
    assert.match(e.sig, /^[a-f0-9]{128}$/); assert.equal(e.kind, 20000);
    relay.broadcast(e); await pause(30); assert.equal(packets.length, 1);
    relay.broadcast({ ...e, id: "f".repeat(64), content: "tampered" }); await wait(() => b.stats.rejected > 0); assert.equal(packets.length, 1);
    relay.disconnect(); await wait(() => b.stats.reconnects > 0); await pause(800);
    await a.publish(new Uint8Array([4, 5, 6])); await wait(() => packets.length === 2);
    assert.deepEqual(packets[1], new Uint8Array([4, 5, 6]));
  } finally { a.stop(); b.stop(); await relay.close(); }
});

test("stopping discovery cancels an unacknowledged startup immediately and releases sockets", async () => {
  const relay = await startMockNostrRelay();
  const provider = new NostrDiscovery({ relays: [relay.url], timeoutMs: 10000 });
  try {
    const starting = provider.start(discoveryToken(), () => {});
    provider.stop();
    await assert.rejects(starting, /cancelled/);
    await assert.rejects(provider.publish(new Uint8Array([1])), /stopped/);
  } finally { provider.stop(); await relay.close(); }
});
