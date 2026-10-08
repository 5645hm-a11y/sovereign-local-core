import { encryptFields, fieldsAAD } from "../../dist/project-crypto.js";
import { signEvent } from "../../dist/identity.js";
import { toBase64Url } from "../../dist/crypto-codec.js";
import { inspectFrames, encodeFrame } from "../../dist/framed-log.js";
import { normalizeEvent } from "../../dist/validation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { BinaryProjection, WasmProjection } from "../../dist/wasm-loader.js";
import { encodeCommands } from "../../dist/binary-command.js";
import { encodeBinary, decodeBinary } from "../../dist/binary-codec.js";
import { encodeWire, decodeWire } from "../../dist/binary-events.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { LWWMerge, projectItemsReference } from "../../dist/crdt.js";
import { alice, bob, project, projectId, event, Device, concat } from "../helpers/core-fixtures.mjs";

const plain = (sequence, type, fields = {}, lamport = sequence, actorId = "actor-a", itemId = "item-1") =>
  ({ id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId, ...(type === "ITEM_DELETED" ? {} : { fields }) });

test("producer ABI-1 bytes match the existing kernel; persistent checkpoints preserve hidden registers and tombstones", async () => {
  const session = await BinaryProjection.create(), old = await WasmProjection.create();
  const before = [plain(1, "ITEM_ADDED", { text: "שלום\ud800🚀", n: 0 }), plain(2, "ITEM_DELETED"), plain(3, "ITEM_UPDATED", { text: "hidden" }),
    plain(1, "ITEM_UPDATED", { future: true }, 9, "actor-z", "unborn")];
  let saved;
  try {
    const prepared = old.prepareBinary(encodeCommands(before));
    try { prepared.runKernel(); assert.deepEqual(prepared.snapshot(9), projectItemsReference(before, 9)); } finally { prepared.dispose(); }
    session.apply(encodeCommands(before)); saved = session.checkpoint();
    session.reset(); session.restore(saved);
    const delta = [plain(4, "ITEM_ADDED", { restored: true }), plain(2, "ITEM_ADDED", {}, 10, "actor-z", "unborn"),
      plain(5, "ITEM_UPDATED", { text: "loser" }, 2)];
    session.applyAll(delta.map(e => encodeCommands([e])));
    assert.deepEqual(session.snapshot(10), projectItemsReference([...before, ...delta], 10));
    const baseline = session.snapshot(10), malformed = encodeCommands([plain(10, "ITEM_UPDATED", { bad: true })]);
    new DataView(malformed.buffer).setUint32(68, 99, true);
    assert.throws(() => session.apply(malformed), /Invalid WASM/);
    assert.deepEqual(session.snapshot(10), baseline);
    const truncated = saved.subarray(0, saved.length - 1); assert.throws(() => session.restore(truncated), /Invalid WASM/);
    assert.deepEqual(session.snapshot(10), baseline);
  } finally { saved?.fill(0); session.close(); old.close(); }
});

test("binary codec is deterministic, bounded, preserves Unicode and rejects duplicate/trailing data", () => {
  assert.deepEqual(encodeBinary({ b: 2, a: "\ud800" }), encodeBinary({ a: "\ud800", b: 2 }));
  assert.equal(decodeBinary(encodeBinary("\ufeff\ud800")), "\ufeff\ud800");
  assert.throws(() => decodeBinary(concat(encodeBinary({ a: 1 }), new Uint8Array([0]))), /Trailing/);
  assert.throws(() => decodeBinary(new Uint8Array([1, 2, 3])), /Truncated/);
  assert.throws(() => encodeBinary({ n: Infinity }), /Unsupported/);
});

test("dispatch, cryptographic signing, append and replay need no JSON in the event pipeline", async () => {
  const device = new Device(), context = await ProjectContext.open(project.invitation, alice, projectId);
  const store = await LocalEventStore.open(device.open(), { actorId: alice.actorId, projectId });
  const core = await LocalCore.open(store, alice, context);
  const stringify = JSON.stringify, parse = JSON.parse;
  try {
    JSON.stringify = JSON.parse = () => { throw new Error("JSON reached binary event pipeline"); };
    const result = await core.dispatch({ type: "ITEM_ADDED", itemId: "binary", fields: { secret: "BINARY_SENTINEL_473", n: 4 } });
    const wire = encodeWire(result.event);
    assert.deepEqual(normalizeEvent(decodeWire(wire)), result.event);
    assert.deepEqual((await core.snapshot()).items[0].fields, { n: 4, secret: "BINARY_SENTINEL_473" });
    assert.equal(new DataView(device.durable.buffer).getUint32(0, true), 0x32434c53);
    const events = await core.readEvents(); assert.equal(events[0].signature, result.event.signature);
    assert.equal(new TextDecoder().decode(device.durable).includes("BINARY_SENTINEL_473"), false);
  } finally { JSON.stringify = stringify; JSON.parse = parse; await core.close(); }
});

async function open(devices, interval = 3) {
  const context = await ProjectContext.open(project.invitation, alice, projectId);
  const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], context);
  const store = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, async (events, cp) => {
    let state;
    if (cp && events.every(e => e.type.startsWith("ITEM_"))) state = await context.extend(await context.restorePolicy(cp.controls, cp.certificates), events);
    else {
      const history = [];
      if (cp) { const file = devices[0].open(); try { inspectFrames(file, v => { if (v.kind === "event") history.push(v.event); }); } finally { file.close(); } }
      state = await context.evaluateBinary(cp ? history : events);
    }
    const native = await BinaryProjection.create();
    try { if (cp && events.every(e => e.type.startsWith("ITEM_"))) native.restore(cp.native); native.applyAll(state.blocks); }
    finally { state.blocks.forEach(b => b.fill(0)); native.close(); }
  }, journal);
  return { context, core: await LocalCore.open(store, alice, context, { checkpointInterval: interval }) };
}

test("encrypted double-slot checkpoint restores only delta, counters, deduplication and sequence holes", async () => {
  const devices = [new Device(), new Device(), new Device()];
  let opened = await open(devices);
  await opened.core.ingestEvents([await event(3, "ITEM_ADDED", { remote: true }, bob, 3, "remote")]);
  await opened.core.dispatch({ type: "ITEM_ADDED", itemId: "local", fields: { secret: "CHECKPOINT_PRIVATE_778" } });
  await opened.core.dispatch({ type: "ITEM_DELETED", itemId: "local" }); // Checkpoint at event 3.
  const envelope = decodeBinary(devices[1].durable), key = (await project.evaluate([])).keys.get(project.descriptor.genesisKeyId);
  const aad = encodeBinary(["sovereign-local-core/checkpoint/v1", projectId, project.descriptor.rootActorId, project.descriptor.genesisKeyId, alice.actorId]);
  await assert.rejects(crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.iv, additionalData: aad }, key.key, envelope.ciphertext), { name: "OperationError" });
  await opened.core.dispatch({ type: "ITEM_UPDATED", itemId: "local", fields: { hidden: true } });
  const before = await opened.core.snapshot(); await opened.core.close();
  opened = await open(devices);
  assert.deepEqual(await opened.core.snapshot(), before);
  assert.equal(opened.core.recovery.checkpointEvents, 3); assert.equal(opened.core.recovery.replayedEvents, 1);
  assert.equal((await opened.core.getSyncSummary())[bob.actorId], 0);
  await opened.core.ingestEvents([await event(1, "ITEM_UPDATED", { earlier: true }, bob, 1, "remote"), await event(2, "ITEM_UPDATED", {}, bob, 2, "remote")]);
  assert.equal((await opened.core.getSyncSummary())[bob.actorId], 3);
  const next = await opened.core.dispatch({ type: "ITEM_ADDED", itemId: "local", fields: {} });
  assert.equal(next.event.sequence, 4); assert.equal(next.snapshot.items.find(i => i.id === "local").fields.hidden, true);
  const all = await opened.core.readEvents();
  assert.deepEqual(await new LWWMerge(opened.context).materialize(all), await opened.core.snapshot());
  assert.equal((await opened.core.ingestEvents(all)).applied, 0);
  for (const device of devices.slice(1)) for (const encoding of ["utf-8", "utf-16le"]) assert.equal(new TextDecoder(encoding).decode(device.durable).includes("CHECKPOINT_PRIVATE_778"), false);
  await opened.core.close();
});

test("torn latest checkpoint and failed checkpoint flush preserve acknowledged log writes", async () => {
  const devices = [new Device(), new Device(), new Device()]; let opened = await open(devices, 2);
  for (let i = 0; i < 4; i++) await opened.core.dispatch({ type: "ITEM_ADDED", itemId: `item-${i}`, fields: { n: i } });
  const before = await opened.core.snapshot(); await opened.core.close();
  devices[2].durable = devices[2].durable.subarray(0, Math.floor(devices[2].durable.length / 2)); // Latest slot.
  opened = await open(devices, 2);
  assert.equal(opened.core.recovery.checkpointEvents, 2); assert.equal(opened.core.recovery.replayedEvents, 2);
  assert.deepEqual(await opened.core.snapshot(), before);
  devices[1].flushFailure = devices[2].flushFailure = true;
  await opened.core.dispatch({ type: "ITEM_UPDATED", itemId: "item-0", fields: { after: true } });
  const last = await opened.core.dispatch({ type: "ITEM_UPDATED", itemId: "item-0", fields: { durable: true } });
  await opened.core.close(); devices[1].flushFailure = devices[2].flushFailure = false;
  opened = await open(devices, 2); assert.deepEqual(await opened.core.snapshot(), last.snapshot); await opened.core.close();
});

test("checkpoint prefix tampering stops recovery and preserves incomplete tail bytes", async () => {
  const devices = [new Device(), new Device(), new Device()]; const opened = await open(devices, 2);
  for (let i = 0; i < 2; i++) await opened.core.dispatch({ type: "ITEM_ADDED", itemId: `item-${i}`, fields: { n: i } });
  await opened.core.close(); devices[0].durable[20] ^= 1;
  devices[0].durable = concat(devices[0].durable, new Uint8Array([1, 2, 3])); const bytes = devices[0].durable.slice();
  await assert.rejects(open(devices, 2), /checkpoint prefix digest mismatch/); assert.deepEqual(devices[0].durable, bytes);
});

test("an arbitrary storage adapter cannot inject an unsigned checkpoint", async () => {
  const context = await ProjectContext.open(project.invitation, alice, projectId);
  let closed = false;
  const store = { actorId: alice.actorId, projectId, recovery: { eventCount: 0, discardedTailBytes: 0 },
    checkpoint: { native: new Uint8Array(16) }, readEvents: async () => [], append: async () => ({ appended: true }), close: async () => { closed = true; } };
  await assert.rejects(LocalCore.open(store, alice, context), /Authenticated checkpoint proof required/);
  assert.equal(closed, true); context.close();
});
test("a signed malformed binary payload rejects an entire batch before any durable append", async () => {
  const device = new Device(), context = await ProjectContext.open(project.invitation, alice, projectId);
  const core = await LocalCore.open(await LocalEventStore.open(device.open(), { actorId: alice.actorId, projectId }), alice, context);
  const good = await event(1, "ITEM_ADDED", { good: true }, bob, 1, "good");
  const metadata = { schemaVersion: 3, projectId, id: `${bob.actorId}:2`, actorId: bob.actorId, sequence: 2, lamport: 2, certificate: (await import("../helpers/core-fixtures.mjs")).bobProject.certificate };
  const state = await context.evaluateBinary([]), key = state.keys.get(state.currentKeyId);
  const block = encodeCommands([{ ...metadata, type: "ITEM_ADDED", itemId: "bad", fields: { value: true } }]);
  new DataView(block.buffer).setUint32(68, 99, true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: fieldsAAD(metadata, "ITEM_ADDED", "bad", key.id) }, key.key, block);
  const bad = await signEvent({ ...metadata, type: "ITEM_ADDED", itemId: "bad", keyId: key.id, encryptedFields: { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) } }, bob);
  const before = device.durable.slice();
  await assert.rejects(core.ingestEvents([good, bad]), /Invalid WASM/); assert.deepEqual(device.durable, before);
  assert.deepEqual((await core.snapshot()).items, []);
  await core.ingestEvents([good]); assert.equal((await core.snapshot()).items[0].id, "good");
  await core.close();
});

test("revocation after a checkpoint rebuilds witnessed history and enforces future imports after reopen", async () => {
  const devices = [new Device(), new Device(), new Device()]; let opened = await open(devices, 2);
  const historical = await event(1, "ITEM_ADDED", { witnessed: true }, bob, 1, "member-item");
  await opened.core.ingestEvents([historical]);
  await opened.core.dispatch({ type: "ITEM_ADDED", itemId: "root-item", fields: { n: 1 } });
  await opened.core.close(); opened = await open(devices, 2);
  assert.equal(opened.core.recovery.checkpointEvents, 2);
  const revoked = await opened.core.revokeMember(bob.actorId);
  const late = await event(2, "ITEM_UPDATED", { witnessed: false }, bob, revoked.event.lamport + 1, "member-item");
  await assert.rejects(opened.core.ingestEvents([late]), { name: "AuthorizationError" });
  const before = await opened.core.snapshot(); await opened.core.close();
  opened = await open(devices, 2);
  assert.deepEqual(await opened.core.snapshot(), before); // Governance delta forces full authoritative replay.
  await assert.rejects(opened.core.ingestEvents([late]), { name: "AuthorizationError" });
  await opened.core.dispatch({ type: "ITEM_UPDATED", itemId: "root-item", fields: { n: 2 } }); // New epoch, second checkpoint.
  await opened.core.close(); opened = await open(devices, 2);
  assert.equal(opened.core.recovery.checkpointEvents, 4);
  assert.equal((await opened.core.snapshot()).items.find(i => i.id === "member-item").fields.witnessed, true);
  await assert.rejects(opened.core.ingestEvents([late]), { name: "AuthorizationError" });
  await opened.core.close();
});

test("forged checkpoint tail record is rejected before incomplete-tail repair", async () => {
  const devices = [new Device(), new Device(), new Device()]; const opened = await open(devices, 2);
  const signed = (await opened.core.dispatch({ type: "ITEM_ADDED", itemId: "signed", fields: {} })).event;
  await opened.core.dispatch({ type: "ITEM_UPDATED", itemId: "signed", fields: { n: 1 } });
  await opened.core.close();
  const forged = { ...signed, id: `${signed.actorId}:3`, sequence: 3, lamport: 3 };
  devices[0].durable = concat(devices[0].durable, encodeFrame({ kind: "event", event: forged }), new Uint8Array([1, 2, 3]));
  const before = devices[0].durable.slice(); await assert.rejects(open(devices, 2), { name: "InvalidEventSignatureError" });
  assert.deepEqual(devices[0].durable, before);
});

