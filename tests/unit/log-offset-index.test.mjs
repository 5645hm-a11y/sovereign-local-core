import test from "node:test";
import assert from "node:assert/strict";
import { LogOffsetIndex } from "../../dist/log-offset-index.js";
import { seedCursorCore, drainCursor, ReadTrackedDevice } from "../helpers/sync-cursor-fixtures.mjs";
import { Device, alice, bob, projectId, concat } from "../helpers/core-fixtures.mjs";
import { LocalCore } from "../../dist/engine.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { ProjectContext } from "../../dist/project.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { encodeFrame } from "../../dist/framed-log.js";

test("indexed tail exports seek only missing signed frames, tolerate short reads and preserve exact bulk parity", async () => {
  const f = await seedCursorCore(300, 1024);
  try {
    const summary = { [alice.actorId]: 280 }, expected = await f.core.readMissingEventsPaged(summary);
    f.device.resetReads(); f.device.maxChunk = 37;
    f.store.readEvents = async () => { throw new Error("Bulk read forbidden"); };
    f.store.log.readPage = () => { throw new Error("Sequential scan forbidden"); };
    f.store.readEventPage = undefined; // A custom store may provide only indexed reads.
    const { events, pages } = await drainCursor(f.core, summary);
    assert.deepEqual(events, expected);
    assert.equal(f.device.stats.bytes, expected.reduce((n, e) => n + encodeFrame({ kind: "event", event: e }).length, 0));
    assert.ok(f.device.stats.bytes < f.device.durable.length / 10);
    assert.equal(pages.reduce((n, p) => n + p.scannedRecords, 0), 20);
    f.device.resetReads();
    assert.equal((await drainCursor(f.core, { [alice.actorId]: 300 })).events.length, 0);
    assert.equal(f.device.stats.bytes, 0, "Complete peer knowledge reads no event frames");
  } finally { await f.core.close(); }
});

test("location scans preserve sequence holes, fence out late writes and survive inserts before/after their position", () => {
  const index = new LogOffsetIndex(); let offset = 100;
  for (let seq = 130; seq >= 1; seq--) { index.add({ id: `${alice.actorId}:${seq}`, offset, length: 32 }); offset += 32; }
  index.add({ id: `${bob.actorId}:3`, offset, length: 32 }); offset += 32;
  const scan = index.scan({ [alice.actorId]: 5, [bob.actorId]: 0 }, offset);
  let page = scan.next(); const ids = page.entries.map(e => e.id);
  index.add({ id: `${alice.actorId}:131`, offset, length: 32 }); offset += 32;
  index.add({ id: `${bob.actorId}:1`, offset, length: 32 }); offset += 32;
  index.add({ id: `${bob.actorId}:2`, offset, length: 32 }); offset += 32;
  index.add({ id: `${bob.actorId}:4`, offset, length: 32 });
  while (!page.done) { page = scan.next(); ids.push(...page.entries.map(e => e.id)); }
  assert.deepEqual(new Set(ids), new Set([...Array.from({ length: 125 }, (_, i) => `${alice.actorId}:${i + 6}`), `${bob.actorId}:3`]));
  assert.equal(ids.length, 126); assert.throws(() => scan.next(), /closed/);
  const fresh = index.scan({ [alice.actorId]: 130, [bob.actorId]: 0 }, offset + 32);
  assert.equal(fresh.next().entries.length, 5);
});

test("compact checkpoint addresses preserve 64-bit offsets and reject omission, ordinals, overlap, unsafe ranges and invalid identities", () => {
  const entries = [{ id: `${alice.actorId}:1`, offset: 100, length: 50 }, { id: `${alice.actorId}:2`, offset: 4294967423, length: 50 }];
  const ids = entries.map(e => ({ id: e.id })).reverse(), index = new LogOffsetIndex(); entries.forEach(e => index.add(e));
  const bytes = index.encode(ids), end = entries[1].offset + entries[1].length;
  assert.equal(bytes.length, 8 + 16 * 2);
  assert.deepEqual(LogOffsetIndex.decode(bytes, ids, end).export().entries, entries);
  assert.throws(() => index.encode(ids.slice(1)), /coverage/);
  for (const mutate of [
    v => v.setUint32(0, 0, true), v => v.setUint32(4, 1, true),
    v => v.setUint32(24, v.getUint32(8, true), true), // duplicate ordinal
    v => v.setUint32(8, 2, true), // outside ID list
    v => { v.setUint32(28, 120, true); v.setUint32(32, 0, true); }, // overlap
    v => v.setUint32(20, 0, true), // invalid length
    v => v.setUint32(16, 0xffffffff, true), // unsafe high offset word
  ]) { const bad = bytes.slice(); mutate(new DataView(bad.buffer)); assert.throws(() => LogOffsetIndex.decode(bad, ids, end)); }
  assert.throws(() => LogOffsetIndex.decode(bytes.subarray(0, -1), ids, end));
  assert.throws(() => LogOffsetIndex.decode(bytes, [{ id: "forged" }, ids[1]], end));
  assert.throws(() => LogOffsetIndex.decode(bytes, ids, NaN));
});

test("a corrupted address cannot substitute a different signed event; failure freezes the core and preserves disk bytes", async () => {
  const f = await seedCursorCore(2, 32);
  try {
    const entries = f.store.locations.export().entries, bad = new LogOffsetIndex();
    bad.add({ ...entries[1], id: entries[0].id }); f.store.locations = bad;
    const before = f.device.durable.slice(), cursor = await f.core.openSyncCursor({});
    await f.core.readSyncCursor(cursor.id);
    await assert.rejects(f.core.readSyncCursor(cursor.id), /indexed event identity mismatch/);
    await assert.rejects(f.core.dispatch({ type: "ITEM_ADDED", itemId: "future", fields: {} }), /faulted/);
    assert.deepEqual(f.device.durable, before);
  } finally { await f.core.close(); }
});

test("signed checkpoint addresses restore directly, include only flushed deltas and recover an incomplete tail", async () => {
  const devices = [new ReadTrackedDevice(), new Device(), new Device()];
  const context = await ProjectContext.create(alice, projectId), invitation = context.invitation; context.close();
  async function open() {
    const project = await ProjectContext.open(invitation, alice, projectId);
    const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], project);
    const store = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
    return { store, core: await LocalCore.open(store, alice, project, { checkpointInterval: 20 }) };
  }
  let db = await open();
  try {
    for (let i = 0; i < 23; i++) await db.core.dispatch({ type: "ITEM_ADDED", itemId: `row_${i}`, fields: { i } });
    const snapshot = await db.core.snapshot(); await db.core.close();
    const bytes = devices[0].durable.slice(); devices[0].durable = new Uint8Array(bytes.length + 7); devices[0].durable.set(bytes);
    db = await open(); assert.equal(db.store.checkpoint.logLocations.length, 8 + 20 * 16);
    assert.equal(db.core.recovery.replayedEvents, 3); assert.equal(db.core.recovery.discardedTailBytes, 7);
    db.store.log.readPage = () => { throw new Error("Checkpoint addresses should not require rebuilding"); };
    db.store.readEvents = async () => { throw new Error("Bulk read forbidden"); }; devices[0].resetReads();
    const { events } = await drainCursor(db.core, { [alice.actorId]: 21 });
    assert.equal(events.length, 2);
    assert.equal(devices[0].stats.bytes, events.reduce((n, e) => n + encodeFrame({ kind: "event", event: e }).length, 0));
    assert.deepEqual(await db.core.snapshot(), snapshot);
  } finally { await db.core.close(); }
});

test("old checkpoints rebuild addresses once without bulk arrays and seal them into the next checkpoint", async () => {
  const devices = [new ReadTrackedDevice(), new Device(), new Device()];
  const initial = await ProjectContext.create(alice, projectId), invitation = initial.invitation; initial.close();
  async function open(legacy = false) {
    const project = await ProjectContext.open(invitation, alice, projectId);
    const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], project);
    if (legacy) { const save = journal.save.bind(journal); journal.save = (log, at, data) => save(log, at, data); }
    const store = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
    return { store, core: await LocalCore.open(store, alice, project, { checkpointInterval: 10 }) };
  }
  let db = await open(true);
  try {
    for (let i = 0; i < 10; i++) await db.core.dispatch({ type: "ITEM_ADDED", itemId: `row_${i}`, fields: { i } });
    await db.core.close(); db = await open(); assert.equal(db.store.checkpoint.logLocations, undefined);
    db.store.readEvents = async () => { throw new Error("Bulk arrays forbidden"); };
    const summary = { [alice.actorId]: 9 }; devices[0].resetReads();
    assert.equal((await drainCursor(db.core, summary)).events.length, 1);
    assert.ok(devices[0].stats.bytes >= devices[0].durable.length);
    devices[0].resetReads(); assert.equal((await drainCursor(db.core, summary)).events.length, 1);
    assert.ok(devices[0].stats.bytes < devices[0].durable.length / 2);
    for (let i = 10; i < 20; i++) await db.core.dispatch({ type: "ITEM_ADDED", itemId: `row_${i}`, fields: { i } });
    await db.core.close(); db = await open(); assert.equal(db.store.checkpoint.logLocations.length, 8 + 20 * 16);
  } finally { await db.core.close(); }
});

test("invalid but owner-signed address coverage fails before incomplete-tail repair", async () => {
  const devices = [new ReadTrackedDevice(), new Device(), new Device()];
  const project = await ProjectContext.create(alice, projectId), invitation = project.invitation;
  const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], project), save = journal.save.bind(journal);
  journal.save = (log, at, data, locations) => save(log, at, data, locations.slice(0, -16));
  const store = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
  const core = await LocalCore.open(store, alice, project, { checkpointInterval: 2 });
  await core.dispatch({ type: "ITEM_ADDED", itemId: "one", fields: {} });
  await core.dispatch({ type: "ITEM_ADDED", itemId: "two", fields: {} });
  assert.equal(core.checkpointStatus.events, 2); await core.close();
  devices[0].durable = concat(devices[0].durable, new Uint8Array(7)); const before = devices[0].durable.slice();
  const reopened = await ProjectContext.open(invitation, alice, projectId);
  try {
    await assert.rejects(LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined,
      new CheckpointJournal([devices[1].open(), devices[2].open()], reopened)), /checkpoint log locations/);
    assert.deepEqual(devices[0].durable, before);
  } finally { reopened.close(); }
});

test("forged bytes during a legacy index rebuild fault the core before any future append", async () => {
  const f = await seedCursorCore(2, 32);
  try {
    const before = f.device.durable.slice(); f.store.locationsComplete = false;
    const forged = { ...f.events[0], signature: (f.events[0].signature[0] === "A" ? "B" : "A") + f.events[0].signature.slice(1) };
    f.device.overrideBytes = concat(encodeFrame({ kind: "identity", version: 3, actorId: alice.actorId, projectId }),
      encodeFrame({ kind: "event", event: forged }), encodeFrame({ kind: "event", event: f.events[1] }));
    await assert.rejects(f.core.openSyncCursor({}), /signature/i);
    await assert.rejects(f.core.dispatch({ type: "ITEM_ADDED", itemId: "future", fields: {} }), /faulted/);
    assert.deepEqual(f.device.durable, before);
  } finally { await f.core.close(); }
});

test("a stalled indexed adapter fails closed and releases its scan rather than looping forever", async () => {
  const f = await seedCursorCore(1, 16); let closed = 0;
  try {
    f.store.openMissingEventScan = async () => ({
      readPage: async () => ({ events: [], done: false, scannedRecords: 0, scannedBytes: 0 }),
      close: () => { closed++; },
    });
    const cursor = await f.core.openSyncCursor({}); await f.core.readSyncCursor(cursor.id);
    await assert.rejects(f.core.readSyncCursor(cursor.id), /indexed cursor contract/);
    assert.equal(closed, 1); assert.equal(f.core.syncCursors.size, 0);
    await assert.rejects(f.core.snapshot(), /faulted/);
  } finally { await f.core.close(); }
});
