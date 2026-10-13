import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { epochFixture, newIdentity } from "../helpers/epoch-fixtures.mjs";
import { alice, bob, Device, store, projectId } from "../helpers/core-fixtures.mjs";
import { LocalCore } from "../../dist/engine.js";
import { ProjectContext } from "../../dist/project.js";
import { DiscoveryRecovery } from "../../dist/discovery-recovery.js";
import { deriveRecoveryMaterial, openRecoveryResponse, openRecoveryRequest, sealRecoveryResponse, sealRecoveryRequest,
  RECOVERY_FRAGMENT_BYTES } from "../../dist/discovery-recovery-crypto.js";
import { discoveryToken } from "../../dist/discovery-crypto.js";
import { encodeWire } from "../../dist/binary-events.js";
import { issueCertificate } from "../../dist/certificates.js";

const hello = () => ({ kind: "hello", from: discoveryToken(), to: null, session: null, challenge: null, response: null, description: null, candidate: null });
async function recover(client, server) {
  let request = await client.createDiscoveryRecoveryRequest(), packets = 0;
  while (request) {
    assert.ok(request.length <= 32768);
    const reply = await server.handleDiscoveryRecoveryRequest(request); assert.ok(reply && reply.length <= 32768); packets++;
    const result = await client.acceptDiscoveryRecoveryResponse(reply); assert.ok(result);
    request = result.request;
    if (result.complete) return { packets, keyId: result.keyId };
    assert.ok(packets < 2000);
  }
  throw new Error("Recovery ended without completion");
}

test("cold member recovers fragmented paged epochs from another Member with the Root offline; no data travels on recovery", async () => {
  const f = await epochFixture(), survivorId = await newIdentity(); let survivor;
  try {
    const grant = await f.a.inviteMember(survivorId.actorId);
    const context = await ProjectContext.open(grant.invitation, survivorId, projectId);
    survivor = await LocalCore.open(await store(new Device(), survivorId), survivorId, context);
    for (let i = 0; i < 160; i++) {
      const { event } = await f.b.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { version: i } });
      await f.a.ingestEvents([event]);
    }
    const before = await f.c.getDiscoveryInfo(), stable = await f.c.getDiscoveryRecoveryInfo();
    const rev = await f.a.revokeMember(bob.actorId, { paged: true });
    const controls = (await f.a.readEvents()).filter(e => !e.type.startsWith("ITEM_"));
    await survivor.ingestEvents(controls);
    const future = (await f.a.dispatch({ type: "ITEM_ADDED", itemId: "private-data", fields: { text: "not a relay payload" } })).event;
    await f.a.close();
    const result = await recover(f.c, survivor);
    assert.ok(result.packets > controls.length + 1, "a witness page must need multiple fragments");
    assert.notEqual(result.keyId, before.keyId); assert.equal((await f.c.getDiscoveryInfo()).topic, (await survivor.getDiscoveryInfo()).topic);
    assert.deepEqual(await f.c.getDiscoveryRecoveryInfo(), stable);
    assert.deepEqual((await f.c.snapshot()).items, []);
    assert.ok((await f.c.readEvents()).every(e => !e.type.startsWith("ITEM_")));
    await survivor.openDiscovery(await f.c.sealDiscovery(hello()));
    await f.c.ingestEvents([future]); assert.equal((await f.c.snapshot()).items[0].fields.text, "not a relay payload");
    await f.reopenReader(); assert.equal((await f.c.getDiscoveryInfo()).keyId, result.keyId);
  } finally { await survivor?.close(); await f.close(); }
});

test("old-key holders cannot recover after revocation, including delegated descendants; replay and forged request signatures fail", async () => {
  const f = await epochFixture({ delegatedReader: true });
  try {
    const revokedRequest = await f.b.createDiscoveryRecoveryRequest(), descendantRequest = await f.c.createDiscoveryRecoveryRequest();
    await f.a.revokeMember(bob.actorId, { paged: true });
    await assert.rejects(f.a.handleDiscoveryRecoveryRequest(revokedRequest), /revoked/);
    await assert.rejects(f.a.handleDiscoveryRecoveryRequest(descendantRequest), /revoked/);
  } finally { await f.close(); }
  const g = await epochFixture();
  try {
    await g.a.revokeMember(bob.actorId, { paged: true });
    const packet = await g.c.createDiscoveryRecoveryRequest(); await g.a.handleDiscoveryRecoveryRequest(packet);
    await assert.rejects(g.a.handleDiscoveryRecoveryRequest(packet), { name: "DiscoveryReplayError" });
    const material = await deriveRecoveryMaterial(g.project.descriptor, (await g.project.evaluate([])).keys.get(g.project.descriptor.genesisKeyId));
    const value = (await openRecoveryRequest(await g.c.createDiscoveryRecoveryRequest(), material)).payload;
    const forged = await sealRecoveryRequest(value, material, { ...bob, actorId: value.actorId });
    await assert.rejects(g.a.handleDiscoveryRecoveryRequest(forged), /signature/);
    const outsider = await newIdentity(), certificate = await issueCertificate(outsider, projectId, outsider.actorId, "Admin", 0, null);
    const outsiderPacket = await sealRecoveryRequest({ ...value, actorId: outsider.actorId, certificate, nonce: discoveryToken() }, material, outsider);
    await assert.rejects(g.a.handleDiscoveryRecoveryRequest(outsiderPacket), /root|Root|trust/);
    const expired = await sealRecoveryRequest({ ...value, nonce: discoveryToken(), issuedAt: Date.now() - 180000, expiresAt: Date.now() - 120000 }, material, g.readerIdentity);
    await assert.rejects(g.a.handleDiscoveryRecoveryRequest(expired), /Expired/);
    const changed = forged.slice(); changed[changed.length - 1] ^= 1;
    await assert.rejects(g.a.handleDiscoveryRecoveryRequest(changed));
    await assert.rejects(g.a.handleDiscoveryRecoveryRequest(new Uint8Array(32769)), /size/);
    const fresh = await g.c.createDiscoveryRecoveryRequest(), copied = g.a.handleDiscoveryRecoveryRequest(fresh); fresh.fill(0);
    assert.ok(await copied);
  } finally { await g.close(); }
});

test("recipient encryption, request correlation and control-only validation prevent cross-wallet replay and signed application injection", async () => {
  const f = await epochFixture();
  try {
    await f.a.revokeMember(bob.actorId, { paged: true });
    const request = await f.c.createDiscoveryRecoveryRequest(), reply = await f.a.handleDiscoveryRecoveryRequest(request);
    const material = await deriveRecoveryMaterial(f.project.descriptor, (await f.project.evaluate([])).keys.get(f.project.descriptor.genesisKeyId));
    assert.equal(await openRecoveryResponse(reply, material, bob), null, "genesis secret alone cannot open the addressed box");
    const response = (await openRecoveryResponse(reply, material, f.readerIdentity)).payload;
    assert.ok(response.bytes.length <= RECOVERY_FRAGMENT_BYTES);
    const event = (await f.a.dispatch({ type: "ITEM_ADDED", itemId: "injection", fields: {} })).event, bytes = encodeWire(event);
    const hostile = await sealRecoveryResponse({ ...response, bytes, totalBytes: bytes.length }, material, alice);
    const before = f.devices[2].durable.slice();
    await assert.rejects(f.c.acceptDiscoveryRecoveryResponse(hostile), /rejects application/);
    assert.deepEqual(f.devices[2].durable, before);
    await f.c.createDiscoveryRecoveryRequest(); assert.equal(await f.c.acceptDiscoveryRecoveryResponse(reply), null);
    const changed = reply.slice(); changed[changed.length - 1] ^= 1;
    await assert.rejects(f.c.acceptDiscoveryRecoveryResponse(changed));
    await recover(f.c, f.a);
    assert.equal(await f.c.acceptDiscoveryRecoveryResponse(reply), null);
  } finally { await f.close(); }
});

test("incomplete manifest recovery restores durable pages; interrupted fragments and changed governance restart safely", async () => {
  const f = await epochFixture();
  try {
    const old = (await f.b.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { text: "witness" } })).event;
    await f.a.ingestEvents([old]); const rev = await f.a.revokeMember(bob.actorId, { paged: true });
    await f.c.ingestEvents([rev.event]); await f.reopenReader();
    await assert.rejects(f.c.getDiscoveryInfo(), { name: "EpochIncompleteError" });
    const reply = await f.a.handleDiscoveryRecoveryRequest(await f.c.createDiscoveryRecoveryRequest());
    const next = (await f.c.acceptDiscoveryRecoveryResponse(reply)).request;
    await f.a.inviteMember(f.readerIdentity.actorId);
    await assert.rejects(f.a.handleDiscoveryRecoveryRequest(next), /cursor changed/);
    await f.c.cancelDiscoveryRecovery(); await f.reopenReader(); await recover(f.c, f.a);
    assert.deepEqual((await f.c.getProjectInfo()).pendingEpochs, []);
    await f.c.ingestEvents([old]); assert.equal((await f.c.snapshot()).items[0].fields.text, "witness");
  } finally { await f.close(); }
});

test("recovery serving cursors are bounded, clear on cancellation and ignore packets from another project", async () => {
  const f = await epochFixture(); let foreign;
  try {
    await f.a.revokeMember(bob.actorId, { paged: true });
    for (let i = 0; i < 8; i++) await f.a.handleDiscoveryRecoveryRequest(await f.c.createDiscoveryRecoveryRequest());
    await assert.rejects(f.a.handleDiscoveryRecoveryRequest(await f.c.createDiscoveryRecoveryRequest()), /capacity/);
    await f.a.cancelDiscoveryRecovery(); await recover(f.c, f.a);
    const context = await ProjectContext.create(alice, "foreign-project");
    const device = new Device(); const otherStore = await import("../../dist/local-store.js");
    foreign = await LocalCore.open(await otherStore.LocalEventStore.open(device.open(), { actorId: alice.actorId, projectId: "foreign-project" }), alice, context);
    await assert.rejects(f.a.handleDiscoveryRecoveryRequest(await foreign.createDiscoveryRecoveryRequest()));
  } finally { await foreign?.close(); await f.close(); }
});

test("blind recovery providers make progress, restart after interruption and release subscriptions on stop", async () => {
  const f = await epochFixture(), bus = new Set();
  const provider = () => ({ receiver: null, topic: null, async start(topic, receiver) { this.topic = topic; this.receiver = receiver; bus.add(this); },
    async publish(packet) { for (const p of bus) if (p.topic === this.topic) p.receiver(packet.slice()); }, stop() { bus.delete(this); this.receiver = null; } });
  const left = new DiscoveryRecovery(f.a, { discovery: provider(), intervalMs: 300, responseTimeoutMs: 2000 });
  const right = new DiscoveryRecovery(f.c, { discovery: provider(), intervalMs: 300, responseTimeoutMs: 2000 });
  try {
    await f.a.revokeMember(bob.actorId, { paged: true }); await left.start(); await right.start();
    for (let i = 0; i < 500 && !right.stats.completed; i++) await pause(10);
    assert.ok(right.stats.completed); assert.equal((await f.c.getDiscoveryInfo()).keyId, (await f.a.getDiscoveryInfo()).keyId);
    right.stop(); assert.equal(bus.size, 1); await right.start();
    for (let i = 0; i < 500 && right.stats.completed < 2; i++) await pause(10);
    assert.ok(right.stats.completed >= 2);
  } finally { left.stop(); right.stop(); assert.equal(bus.size, 0); await f.close(); }
});

test("stopping during provider startup cannot resurrect recovery, and oversized packets are rejected before copying", async () => {
  const f = await epochFixture(); let release, receive;
  const started = new Promise(resolve => { release = resolve; });
  const provider = { running: false, publishes: 0,
    async start(topic, callback) { this.running = true; receive = callback; await started; },
    async publish() { this.publishes++; }, stop() { this.running = false; } };
  const controller = new DiscoveryRecovery(f.c, { discovery: provider, intervalMs: 1000 });
  try {
    const pending = controller.start();
    while (!receive) await pause(1);
    receive(new Uint8Array(32769)); assert.equal(controller.stats.rejected, 1);
    controller.stop(); release(); await assert.rejects(pending, /replaced/);
    receive(new Uint8Array(4)); await pause(5);
    assert.equal(provider.running, false); assert.equal(provider.publishes, 0);
  } finally { controller.stop(); await f.close(); }
});
