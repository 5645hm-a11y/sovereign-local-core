import test from "node:test";
import assert from "node:assert/strict";
import { LWWMerge, EventMaterializer } from "../../dist/crdt.js";
import { encodeFrame, LogCorruptionError, UncertainCommitError } from "../../dist/framed-log.js";
import { InvalidEventSignatureError, EventProjectMismatchError, verifySignature, signEvent } from "../../dist/identity.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { event, store, core, Device, concat, permutations, alice, bob, projectId, project } from "../helpers/core-fixtures.mjs";
import { getWasmDiagnostics } from "../../dist/wasm-loader.js";

test.after(() => {
  const native = getWasmDiagnostics();
  assert.equal(native.backend, "wasm");
  assert.ok(native.mergeCalls > 50, "Existing core regressions must execute the real WASM projection");
});

test("signed merge converges for every permutation and duplicate delivery", async () => {
  const events = [await event(1, "ITEM_ADDED", { title: "initial", done: false }),
    await event(2, "ITEM_UPDATED", { title: "A" }), await event(1, "ITEM_UPDATED", { title: "B" }, bob, 2),
    await event(3, "ITEM_UPDATED", { done: true })];
  const merger = new LWWMerge(project), expected = await merger.materialize(events);
  assert.deepEqual(expected.items, [{ id: "item-1", fields: { done: true, title: alice.actorId > bob.actorId ? "A" : "B" } }]);
  for (const order of permutations(events)) assert.deepEqual(await merger.materialize([...order, ...order]), expected);
});
test("updates do not resurrect deletion; a later explicit signed add does", async () => {
  const events = [await event(1, "ITEM_ADDED", { title: "initial" }), await event(2, "ITEM_DELETED"), await event(3, "ITEM_UPDATED", { title: "late" })];
  const merger = new LWWMerge(project);
  for (const order of permutations(events)) assert.deepEqual((await merger.materialize(order)).items, []);
  assert.equal((await merger.materialize([...events, await event(4, "ITEM_ADDED", { title: "restored" })])).items[0].fields.title, "restored");
});
test("two valid signatures over conflicting contents for one event ID fail", async () => {
  await assert.rejects(new LWWMerge(project).materialize([
    await event(1, "ITEM_ADDED", { title: "A" }), await event(1, "ITEM_ADDED", { title: "B" }),
  ]), /Conflicting content/);
});
test("async signature checks copy caller input and snapshots are immutable", async () => {
  const reducer = new EventMaterializer(project), signed = await event(1, "ITEM_ADDED", { title: "original" });
  const input = { ...signed, encryptedFields: { ...signed.encryptedFields } };
  const applying = reducer.apply(input); input.encryptedFields.iv = "A".repeat(16); await applying;
  assert.throws(() => { reducer.snapshot().items[0].fields.title = "other"; }, TypeError);
  assert.equal(reducer.snapshot().items[0].fields.title, "original");
});
test("invalid scalar, unsafe clock or legacy schema cannot enter the log", async () => {
  const device = new Device(), log = await store(device), valid = await event(1, "ITEM_ADDED", {}), before = device.durable.slice();
  for (const invalid of [{ ...valid, fields: { n: NaN } }, { ...valid, fields: { nested: {} } },
    { ...valid, lamport: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, schemaVersion: 1 }]) await assert.rejects(log.append(invalid), TypeError);
  assert.deepEqual(device.durable, before);
});
test("short I/O, per-event flush, signed disk read and exact recovery", async () => {
  const device = new Device(); device.maxChunk = 7; const db = await core(device);
  const added = await db.dispatch({ type: "ITEM_ADDED", itemId: "item-1", fields: { title: "שלום", done: false } });
  assert.equal(await verifySignature(added.event), true);
  await db.dispatch({ type: "ITEM_UPDATED", itemId: "item-1", fields: { done: true } }); assert.equal(device.flushCount, 3);
  const before = await db.snapshot(); assert.deepEqual(await new LWWMerge(project).materialize(await db.readEvents()), before);
  const reopened = await core(device); assert.equal(reopened.actorId, alice.actorId); assert.deepEqual(await reopened.snapshot(), before);
  const next = await reopened.dispatch({ type: "ITEM_UPDATED", itemId: "item-1", fields: { title: "next" } });
  assert.equal(next.event.sequence, 3); assert.equal(next.event.lamport, 3);
});
test("parallel dispatches allocate distinct durable signed counters", async () => {
  const device = new Device(), db = await core(device);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => db.dispatch({ type: "ITEM_ADDED", itemId: `item-${i}`, fields: { n: i } })));
  assert.deepEqual(results.map(result => result.event.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(await (await core(device)).snapshot(), await db.snapshot());
});
test("every incomplete final frame is discarded without losing its verified prefix", async () => {
  const prefixDevice = new Device(), log = await store(prefixDevice), first = await event(1, "ITEM_ADDED", { title: "saved" });
  await log.append(first); const prefix = prefixDevice.durable.slice();
  const final = encodeFrame({ kind: "event", event: await event(2, "ITEM_UPDATED", { title: "pending" }) });
  const retry = await event(2, "ITEM_UPDATED", { title: "retry" });
  for (let cut = 1; cut < final.length; cut++) {
    const device = new Device(); device.durable = concat(prefix, final.subarray(0, cut)); const opened = await store(device);
    assert.equal(opened.recovery.discardedTailBytes, cut); assert.deepEqual(await opened.readEvents(), [first]); assert.deepEqual(device.durable, prefix);
    await opened.append(retry); assert.equal((await (await store(device)).readEvents()).length, 2);
  }
});
test("complete checksum corruption is preserved and reported", async () => {
  const device = new Device(), log = await store(device); await log.append(await event(1, "ITEM_ADDED", { title: "saved" }));
  device.durable[device.durable.length - 2] ^= 1; const damaged = device.durable.slice();
  await assert.rejects(store(device), LogCorruptionError); assert.deepEqual(device.durable, damaged);
});
test("invalid complete record before an incomplete tail is never silently truncated", async () => {
  const device = new Device(); device.durable = concat(encodeFrame({ kind: "identity", version: 3, actorId: alice.actorId, projectId }),
    encodeFrame({ kind: "event", event: { ...await event(1, "ITEM_ADDED", {}), schemaVersion: 9 } }), new Uint8Array([1, 2, 3]));
  const damaged = device.durable.slice(); await assert.rejects(store(device), LogCorruptionError); assert.deepEqual(device.durable, damaged);
});
test("flush failure freezes the core without acknowledging a new view", async () => {
  const device = new Device(), db = await core(device); await db.dispatch({ type: "ITEM_ADDED", itemId: "item-1", fields: { title: "saved" } });
  device.flushFailure = true;
  await assert.rejects(db.dispatch({ type: "ITEM_UPDATED", itemId: "item-1", fields: { title: "unsaved" } }), UncertainCommitError);
  await assert.rejects(db.snapshot(), /faulted/); await assert.rejects(db.dispatch({ type: "ITEM_DELETED", itemId: "item-1" }), /faulted/);
  device.flushFailure = false; assert.equal((await (await core(device)).snapshot()).items[0].fields.title, "saved");
});
test("partial write failure freezes writer; confirmed events remain recoverable", async () => {
  const device = new Device(), log = await store(device); await log.append(await event(1, "ITEM_ADDED", { title: "saved" })); device.failAfter = 20;
  await assert.rejects(log.append(await event(2, "ITEM_UPDATED", { title: "pending" })), UncertainCommitError);
  await assert.rejects(log.append(await event(3, "ITEM_DELETED")), /faulted/); device.failAfter = Infinity;
  assert.equal((await (await store(device)).readEvents()).length, 1);
});
test("unacknowledged persisted event recovers and exact retry is idempotent", async () => {
  const device = new Device(), log = await store(device), pending = await event(1, "ITEM_ADDED", { title: "survived" });
  device.durable = concat(device.durable, encodeFrame({ kind: "event", event: pending }));
  const reopened = await store(device), before = device.durable.slice();
  assert.deepEqual(await reopened.append(pending), { appended: false }); assert.deepEqual(device.durable, before); await log.close();
});
test("commands are copied before entering asynchronous signing queue", async () => {
  const db = await core(new Device()), command = { type: "ITEM_ADDED", itemId: "item-1", fields: { title: "original" } };
  const result = db.dispatch(command); command.fields.title = "mutated"; assert.equal((await result).snapshot.items[0].fields.title, "original");
});
test("verified imports persist and advance Lamport without consuming local sequence", async () => {
  const device = new Device(), db = await core(device), notifications = []; db.onCommit(notification => notifications.push(notification));
  await db.ingestEvents([await event(1, "ITEM_ADDED", { title: "remote" }, bob, 100)]);
  const local = await db.dispatch({ type: "ITEM_UPDATED", itemId: "item-1", fields: { title: "local" } });
  assert.equal(local.event.sequence, 1); assert.equal(local.event.lamport, 101); assert.deepEqual(notifications.map(commit => commit.source), ["remote", "local"]);
  const recovered = await core(device); assert.deepEqual(await recovered.snapshot(), await db.snapshot());
  assert.deepEqual(await recovered.getSyncSummary(), { [alice.actorId]: 1, [bob.actorId]: 1 });
});
test("signed watermarks never skip holes and catch-up returns missing suffix", async () => {
  const db = await core(new Device()); await db.ingestEvents([await event(3, "ITEM_UPDATED", { title: "third" }, bob)]);
  assert.deepEqual(await db.getSyncSummary(), { [bob.actorId]: 0 });
  await db.ingestEvents([await event(1, "ITEM_ADDED", { title: "first" }, bob)]); assert.deepEqual(await db.getSyncSummary(), { [bob.actorId]: 1 });
  await db.ingestEvents([await event(2, "ITEM_UPDATED", { title: "second" }, bob)]); assert.deepEqual(await db.getSyncSummary(), { [bob.actorId]: 3 });
  assert.deepEqual((await db.readMissingEvents({ [bob.actorId]: 1 })).map(event => event.sequence), [3, 2]); assert.deepEqual(await db.readMissingEvents({ [bob.actorId]: 3 }), []);
});
test("duplicate verified imports neither grow file nor emit echo commits", async () => {
  const device = new Device(), db = await core(device), notifications = []; db.onCommit(notification => notifications.push(notification));
  const imported = await event(1, "ITEM_ADDED", { title: "remote" }, bob); assert.equal((await db.ingestEvents([imported])).applied, 1);
  const size = device.durable.length; assert.equal((await db.ingestEvents([imported, imported])).applied, 0);
  assert.equal(device.durable.length, size); assert.equal(notifications.length, 1);
});
test("invalid signatures and signed equivocations reject whole batch before writing", async () => {
  const device = new Device(), db = await core(device), original = device.durable.slice(), first = await event(1, "ITEM_ADDED", { title: "A" }, bob);
  const conflict = await event(1, "ITEM_ADDED", { title: "different" }, bob);
  await assert.rejects(db.ingestEvents([first, { ...first, encryptedFields: { ...first.encryptedFields, iv: "A".repeat(16) } }]), InvalidEventSignatureError);
  await assert.rejects(db.ingestEvents([first, conflict]), /Conflicting content/); assert.deepEqual(device.durable, original);
  await db.ingestEvents([first]); const committed = device.durable.slice();
  await assert.rejects(db.ingestEvents([await event(2, "ITEM_UPDATED", {}, bob), conflict]), /Conflicting content/); assert.deepEqual(device.durable, committed);
});
test("mid-batch storage failure recovers signed prefix and retries remainder", async () => {
  const device = new Device(), db = await core(device), first = await event(1, "ITEM_ADDED", { title: "first" }, bob), second = await event(2, "ITEM_UPDATED", { title: "second" }, bob);
  device.failAfter = encodeFrame({ kind: "event", event: first }).length + 20;
  await assert.rejects(db.ingestEvents([first, second]), UncertainCommitError); device.failAfter = Infinity; const recovered = await core(device);
  assert.deepEqual(await recovered.getSyncSummary(), { [bob.actorId]: 1 }); assert.equal((await recovered.ingestEvents([first, second])).applied, 1);
  assert.deepEqual(await recovered.getSyncSummary(), { [bob.actorId]: 2 });
});
test("a new valid ECDSA signature over identical content is a duplicate", async () => {
  const device = new Device(), db = await core(device), first = await event(1, "ITEM_ADDED", { title: "same" }, bob);
  const { signature: _, ...unsigned } = first;
  const resigned = await signEvent(unsigned, bob);
  assert.notEqual(first.signature, resigned.signature); await db.ingestEvents([first]); const before = device.durable.slice();
  assert.equal((await db.ingestEvents([resigned])).applied, 0); assert.deepEqual(device.durable, before);
  await assert.rejects(db.ingestEvents([{ ...resigned, signature: "A".repeat(86) }]), InvalidEventSignatureError);
});
test("forged disk record with correct CRC is rejected before tail repair", async () => {
  const device = new Device(), log = await store(device), signed = await event(1, "ITEM_ADDED", { title: "real" }, bob);
  device.durable = concat(device.durable, encodeFrame({ kind: "event", event: { ...signed, encryptedFields: { ...signed.encryptedFields, iv: "A".repeat(16) } } }), new Uint8Array([1, 2, 3]));
  const damaged = device.durable.slice(); await assert.rejects(core(device), InvalidEventSignatureError); assert.deepEqual(device.durable, damaged); await log.close();
});
test("correctly signed foreign-project event cannot enter log or CRDT", async () => {
  const device = new Device(), db = await core(device), before = device.durable.slice(), foreign = await event(1, "ITEM_ADDED", { title: "foreign" }, bob, 1, "item-1", "other-project");
  assert.equal(await verifySignature(foreign), true); await assert.rejects(db.ingestEvents([foreign]), EventProjectMismatchError);
  await assert.rejects(new LWWMerge(project).materialize([foreign]), EventProjectMismatchError); assert.deepEqual(device.durable, before);
});
test("unsigned legacy log is preserved and needs explicit migration", async () => {
  const device = new Device(); device.durable = encodeFrame({ kind: "identity", version: 1, actorId: "old-uuid" }); const before = device.durable.slice();
  await assert.rejects(store(device), /legacy log requires explicit migration/); assert.deepEqual(device.durable, before);
});
test("another vault cannot take over an existing actor database", async () => {
  const device = new Device(); await store(device); const before = device.durable.slice();
  await assert.rejects(LocalEventStore.open(device.open(), { actorId: bob.actorId, projectId }), /does not match database owner/); assert.deepEqual(device.durable, before);
});

test("revocation projection is arrival-order independent and keeps only witnessed historical payloads", async () => {
  const db = await core(new Device());
  const old = await event(1, "ITEM_ADDED", { title: "witnessed" }, bob, 1);
  await db.ingestEvents([old]);
  const revocation = (await db.revokeMember(bob.actorId)).event;
  const late = await event(2, "ITEM_UPDATED", { title: "revoked late" }, bob, revocation.lamport + 1);
  const merger = new LWWMerge(project);
  const expected = await merger.materialize([old, revocation, late]);
  assert.equal(expected.items[0].fields.title, "witnessed");
  for (const order of permutations([old, revocation, late])) assert.deepEqual(await merger.materialize(order), expected);
  await assert.rejects(db.ingestEvents([late]), { name: "AuthorizationError" });
});
