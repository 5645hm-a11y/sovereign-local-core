import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { epochFixture } from "../helpers/epoch-fixtures.mjs";
import { alice, bob } from "../helpers/core-fixtures.mjs";
import { DiscoveryRecovery } from "../../dist/discovery-recovery.js";
import { NostrDiscovery } from "../../dist/nostr-discovery.js";
import { DiscoveryRouting } from "../../dist/discovery-routing.js";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";
import { deriveRecoveryMaterial, openRecoveryResponse, sealRecoveryResponse, openRecoveryRequest, sealRecoveryRequest, recoveryPacketKind } from "../../dist/discovery-recovery-crypto.js";
import { discoveryToken } from "../../dist/discovery-crypto.js";

async function channel(f) {
  const state = await f.project.evaluate([]);
  return deriveRecoveryMaterial(f.project.descriptor, state.keys.get(f.project.descriptor.genesisKeyId));
}
async function complete(client, server, first = null) {
  let request = first ?? await client.createRoutedDiscoveryRecoveryRequest();
  for (let i = 0; i < 1000; i++) {
    const response = await server.handleRoutedDiscoveryRecoveryRequest(request); assert.ok(response?.recipient);
    const progress = await client.acceptDiscoveryRecoveryResponse(response.packet); assert.ok(progress);
    if (progress.complete) return progress;
    assert.equal(progress.recipient, (await server.getDiscoveryRecoveryInfo()).instanceId);
    request = progress.request;
  }
  throw new Error("Routed recovery did not complete");
}
async function wait(predicate) { for (let i = 0; i < 1000; i++) { if (await predicate()) return; await pause(10); } throw new Error("Timed out"); }

test("routed probes return authenticated small offers without allocating cursors; selection and all subsequent fragments use pinned inboxes", async () => {
  const f = await epochFixture();
  try {
    await f.a.revokeMember(bob.actorId, { paged: true });
    const material = await channel(f), clientInfo = await f.c.getDiscoveryRecoveryInfo(), serverInfo = await f.a.getDiscoveryRecoveryInfo();
    for (let i = 0; i < 24; i++) {
      const response = await f.a.handleRoutedDiscoveryRecoveryRequest(await f.c.createRoutedDiscoveryRecoveryRequest());
      const value = (await openRecoveryResponse(response.packet, material, f.readerIdentity)).payload;
      assert.equal(response.recipient, clientInfo.instanceId); assert.equal(value.replyTo, serverInfo.instanceId);
      assert.equal(value.offer, true); assert.equal(value.cursor, null); assert.equal(value.bytes.length, 0);
      assert.ok(response.packet.length < 4096);
    }
    assert.equal(f.a.recoveryEngine.serving.size, 0);
    const request = await f.c.createRoutedDiscoveryRecoveryRequest(), offer = await f.a.handleRoutedDiscoveryRecoveryRequest(request);
    const selection = await f.c.acceptDiscoveryRecoveryResponse(offer.packet);
    assert.equal(selection.recipient, serverInfo.instanceId);
    const decoded = (await openRecoveryRequest(selection.request, material)).payload;
    assert.equal(decoded.responder, f.a.actorId); assert.equal(decoded.cursor, null); assert.equal(decoded.replyTo, clientInfo.instanceId);
    await complete(f.c, f.a, selection.request);
    assert.equal((await f.c.getDiscoveryInfo()).keyId, (await f.a.getDiscoveryInfo()).keyId);
    assert.equal(f.a.recoveryEngine.serving.size, 0);
  } finally { await f.close(); }
});

test("return inboxes are signature-bound, responder routes cannot change mid-transfer and mode mismatch never downgrades to broadcast", async () => {
  const f = await epochFixture();
  try {
    await f.a.revokeMember(bob.actorId, { paged: true });
    const material = await channel(f), request = await f.c.createRoutedDiscoveryRecoveryRequest();
    await assert.rejects(f.a.handleDiscoveryRecoveryRequest(request), /mode mismatch/);
    await assert.rejects(f.a.handleRoutedDiscoveryRecoveryRequest(await f.c.createDiscoveryRecoveryRequest()), /mode mismatch/);
    const offer = await f.a.handleRoutedDiscoveryRecoveryRequest(await f.c.createRoutedDiscoveryRecoveryRequest());
    const selection = await f.c.acceptDiscoveryRecoveryResponse(offer.packet);
    const response = await f.a.handleRoutedDiscoveryRecoveryRequest(selection.request);
    const value = (await openRecoveryResponse(response.packet, material, f.readerIdentity)).payload;
    const changed = await sealRecoveryResponse({ ...value, replyTo: discoveryToken() }, material, alice);
    await assert.rejects(f.c.acceptDiscoveryRecoveryResponse(changed), /inbox changed/);
    const query = (await openRecoveryRequest(selection.request, material)).payload;
    const shifted = await sealRecoveryRequest({ ...query, nonce: discoveryToken(), replyTo: discoveryToken(), cursor: value.cursor,
      index: 1, offset: 0 }, material, f.readerIdentity);
    await assert.rejects(f.a.handleRoutedDiscoveryRecoveryRequest(shifted), /invalid range/);
    await complete(f.c, f.a);
  } finally { await f.close(); }
  const missingCore = { getDiscoveryRecoveryInfo() {}, createDiscoveryRecoveryRequest() {}, handleDiscoveryRecoveryRequest() {}, acceptDiscoveryRecoveryResponse() {}, cancelDiscoveryRecovery() {} };
  assert.throws(() => new DiscoveryRecovery(missingCore, { discovery: { supportsRouting: true } }), /no broadcast fallback/);
  assert.throws(() => new DiscoveryRecovery(missingCore, { discovery: { supportsRouting: true, startRouted() {}, publishRouted() {} } }), /no broadcast fallback/);
});

test("a same-epoch routed offer completes without a serving cursor; known old epochs and expired offers cannot select a responder", async () => {
  const f = await epochFixture();
  try {
    const request = await f.c.createRoutedDiscoveryRecoveryRequest(), reply = await f.a.handleRoutedDiscoveryRecoveryRequest(request);
    assert.equal((await f.c.acceptDiscoveryRecoveryResponse(reply.packet)).complete, true);
    assert.equal(f.a.recoveryEngine.serving.size, 0);
    await f.a.revokeMember(bob.actorId, { paged: true }); await complete(f.c, f.a);
    // The revoked node's local view is stale, but the new key is not downgraded by a signed old-epoch offer.
    const staleReply = await f.b.handleRoutedDiscoveryRecoveryRequest(await f.c.createRoutedDiscoveryRecoveryRequest());
    await assert.rejects(f.c.acceptDiscoveryRecoveryResponse(staleReply.packet), /revoked/);
    const fresh = await f.a.handleRoutedDiscoveryRecoveryRequest(await f.c.createRoutedDiscoveryRecoveryRequest());
    const material = await channel(f), value = (await openRecoveryResponse(fresh.packet, material, f.readerIdentity)).payload;
    const stale = await sealRecoveryResponse({ ...value, keyId: f.project.descriptor.genesisKeyId }, material, alice);
    await assert.rejects(f.c.acceptDiscoveryRecoveryResponse(stale), /older known epoch/);
    const expired = await sealRecoveryResponse({ ...value, issuedAt: Date.now() - 180000, expiresAt: Date.now() - 120000 }, material, alice);
    await assert.rejects(f.c.acceptDiscoveryRecoveryResponse(expired), /Expired/);
  } finally { await f.close(); }
});

test("routed Nostr recovery samples probe buckets, uses addressed pulls/replies across sample rotations and releases relay subscriptions", async () => {
  const f = await epochFixture(), relay = await startMockNostrRelay(), errors = [];
  const routing = { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 100 };
  const providers = ["server", "requester"].map(name => new NostrDiscovery({ relays: [`${relay.url}/${name}`], timeoutMs: 5000, routing }));
  const controllers = [f.a, f.c].map((core, i) => new DiscoveryRecovery(core, { discovery: providers[i], intervalMs: 1000, responseTimeoutMs: 1500, onError: e => errors.push(e.name) }));
  const observer = new NostrDiscovery({ relays: [`${relay.url}/observer`], timeoutMs: 5000, routing }), observed = [];
  const send = providers[1].publishRouted.bind(providers[1]); let paused = false;
  providers[1].publishRouted = async (packet, recipient) => { if (recipient && !paused) { paused = true; await pause(350); } return send(packet, recipient); };
  try {
    await f.a.revokeMember(bob.actorId, { paged: true });
    await observer.startRouted((await f.a.getDiscoveryRecoveryInfo()).topic, discoveryToken(), packet => observed.push(recoveryPacketKind(packet)));
    await controllers[0].start(); await controllers[1].start();
    await wait(() => controllers[1].stats.completed > 0);
    const infos = await Promise.all([f.a, f.c].map(c => c.getDiscoveryRecoveryInfo()));
    const directories = await Promise.all(infos.map(info => DiscoveryRouting.create(info.topic, info.instanceId, routing)));
    const tags = relay.events.map(e => e.tags.find(t => t[0] === "t")[1]);
    assert.ok(tags.includes(directories[0].inbox)); assert.ok(tags.includes(directories[1].inbox));
    assert.ok(tags.includes(directories[1].presence)); assert.ok(!tags.includes(infos[0].topic));
    assert.equal(relay.activeSubscriptions, 6); assert.ok(relay.requests.length > 6); assert.ok(paused);
    await wait(() => observed.length > 0); assert.ok(observed.every(kind => kind === "request"), "unrelated inbox must see no directed offers or replies");
    assert.equal((await f.c.getDiscoveryInfo()).keyId, (await f.a.getDiscoveryInfo()).keyId);
  } finally { controllers.forEach(c => c.stop()); observer.stop(); await wait(() => relay.activeSubscriptions === 0); await relay.close(); await f.close(); }
});
