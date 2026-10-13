import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { seedCursorCore, ReadTrackedDevice, drainCursor } from "../helpers/sync-cursor-fixtures.mjs";
import { Device, alice, bob, projectId, concat } from "../helpers/core-fixtures.mjs";
import { LocalEventStore } from "../../dist/local-store.js";
import { LocalCore } from "../../dist/engine.js";
import { ProjectContext } from "../../dist/project.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { encodeFrame, FramedLog, MAX_RECORD_BYTES } from "../../dist/framed-log.js";
import { SyncSession } from "../../dist/sync-session.js";
import { signEvent } from "../../dist/identity.js";
import { encryptFields, fieldsAAD } from "../../dist/project-crypto.js";

async function wait(predicate) { for (let i = 0; i < 1000; i++) { if (await predicate()) return; await pause(5); } throw new Error("Cursor test timed out"); }
function byteLinks() {
  const ab = new TransformStream(), ba = new TransformStream();
  return [{ readable: ba.readable, writable: ab.writable, close() {} }, { readable: ab.readable, writable: ba.writable, close() {} }];
}

test("cursor returns bounded disk pages, short reads and the exact missing suffix without bulk log evaluation", async () => {
  const f = await seedCursorCore(200, 2048); f.device.maxChunk = 37;
  f.store.openMissingEventScan = undefined; // Keep the sequential compatibility path covered.
  try {
    const expected = await f.core.readMissingEventsPaged({ [alice.actorId]: 7 });
    f.device.resetReads();
    f.store.readEvents = async () => { throw new Error("Whole-log array forbidden during cursor catch-up"); };
    f.context.evaluate = async () => { throw new Error("Whole-log decryption forbidden during cursor catch-up"); };
    const handle = await f.core.openSyncCursor({ [alice.actorId]: 7 });
    assert.equal(f.device.stats.bytes, 0, "Opening a cursor reads no log payloads");
    let page = await f.core.readSyncCursor(handle.id);
    assert.equal(page.scannedBytes, 0); assert.equal(page.done, false); // no cached controls
    page = await f.core.readSyncCursor(handle.id);
    assert.ok(page.events.length > 0); assert.ok(page.scannedBytes <= 131072);
    assert.ok(f.device.stats.bytes < f.device.durable.length / 4, "First batch must not scan the full file");
    const events = [...page.events]; let pages = 2, bytes = page.scannedBytes;
    while (!page.done) {
      page = await f.core.readSyncCursor(handle.id); pages++; events.push(...page.events); bytes += page.scannedBytes;
      assert.ok(page.events.length <= 64); assert.ok(page.scannedRecords <= 64); assert.ok(page.scannedBytes <= 131072);
    }
    assert.ok(pages > 5); assert.equal(bytes, f.device.durable.length);
    assert.deepEqual(events, expected);
    assert.ok(f.device.stats.bytes <= f.device.durable.length + pages * 16, "Only bounded next-header probes may be reread");
    await assert.rejects(f.core.readSyncCursor(handle.id), /completed/);
    await f.core.closeSyncCursor(handle.id);
  } finally { await f.core.close(); }
});

test("one oversized record makes progress within the 1 MiB log limit; bad ranges preserve the file", async () => {
  const f = await seedCursorCore(2, 140000);
  try {
    const { events, pages } = await drainCursor(f.core);
    assert.equal(events.length, 2);
    for (const page of pages.filter(p => p.scannedBytes > 131072)) {
      assert.equal(page.scannedRecords, 1); assert.equal(page.events.length, 1); assert.ok(page.scannedBytes <= MAX_RECORD_BYTES + 16);
    }
    const file = f.device.open(), log = new FramedLog(file); log.recover(() => {});
    const before = f.device.durable.slice();
    assert.throws(() => log.readPage(-1, log.endOffset), RangeError);
    assert.throws(() => log.readPage(0, log.endOffset + 1), RangeError);
    assert.deepEqual(f.device.durable, before); log.close();
  } finally { await f.core.close(); }
});

test("append-only fence excludes later writes; frontier copies preserve holes and a new cursor catches the delta", async () => {
  const f = await seedCursorCore(150, 32);
  try {
    const summary = { [alice.actorId]: 2 }, handle = await f.core.openSyncCursor(summary);
    summary[alice.actorId] = 9999;
    const added = await f.core.dispatch({ type: "ITEM_ADDED", itemId: "record_later", fields: { live: true } });
    const out = [];
    while (true) { const page = await f.core.readSyncCursor(handle.id); out.push(...page.events); if (page.done) break; }
    assert.equal(out.length, 148); assert.equal(out.some(e => e.id === added.event.id), false);
    assert.ok(handle.endOffset < f.device.durable.length);
    const delta = await drainCursor(f.core, { [alice.actorId]: 150 }); assert.deepEqual(delta.events, [added.event]);
  } finally { await f.core.close(); }
});

test("governance changes invalidate cursors; refreshed exports match revocation-witness eligibility", async () => {
  const f = await seedCursorCore(3, 32); let member;
  try {
    const { invitation, event: invite } = await f.core.inviteMember(bob.actorId);
    const memberContext = await ProjectContext.open(invitation, bob, projectId);
    member = await LocalCore.open(await LocalEventStore.open(new Device().open(), { actorId: bob.actorId, projectId }), bob, memberContext);
    const offline = await member.dispatch({ type: "ITEM_ADDED", itemId: "record_offline", fields: { witnessed: true } });
    await f.core.ingestEvents([offline.event]);
    const stale = await f.core.openSyncCursor({});
    await f.core.revokeMember(bob.actorId);
    await assert.rejects(f.core.readSyncCursor(stale.id), { name: "SyncCursorInvalidatedError" });
    const expected = await f.core.readMissingEventsPaged({}), { events } = await drainCursor(f.core);
    assert.deepEqual(events.map(e => e.id).sort(), expected.map(e => e.id).sort());
    assert.ok(events.some(e => e.id === offline.event.id));
    assert.equal(events[0].id, invite.id, "Governance precedes all data");
    const revocation = events.find(e => e.type === "MEMBER_REVOKED"); await member.ingestEvents([revocation]);
    await assert.rejects(member.openSyncCursor({}), /revoked/);
    const late = await f.core.dispatch({ type: "ITEM_ADDED", itemId: "record_after_rotation", fields: { allowed: true } });
    assert.equal((await drainCursor(f.core, { [alice.actorId]: late.event.sequence - 1, [bob.actorId]: 1 })).events.at(-1).id, late.event.id);
  } finally { await member?.close(); await f.core.close(); }
});

test("CRC-valid forged signatures and re-signed equivocation are rejected against the authenticated index", async () => {
  for (const mode of ["signature", "content", "crc"]) {
    const f = await seedCursorCore(1, 32);
    try {
      const known = f.events[0]; let changed = { ...known, signature: "A".repeat(86) };
      if (mode === "content") {
        const key = (await f.context.evaluate([])).keys.get(known.keyId);
        const encryptedFields = await encryptFields({ revision: 1, text: "z".repeat(32) }, fieldsAAD(known, known.type, known.itemId, known.keyId), key);
        const { signature: _, ...unsigned } = known; changed = await signEvent({ ...unsigned, encryptedFields }, alice);
      }
      const identity = encodeFrame({ kind: "identity", version: 3, actorId: alice.actorId, projectId });
      const bytes = concat(identity, encodeFrame({ kind: "event", event: mode === "crc" ? known : changed }));
      assert.equal(bytes.length, f.device.durable.length); if (mode === "crc") bytes[bytes.length - 1] ^= 1;
      const handle = await f.core.openSyncCursor({}); f.device.overrideBytes = bytes;
      await f.core.readSyncCursor(handle.id);
      await assert.rejects(f.core.readSyncCursor(handle.id));
      await assert.rejects(f.core.dispatch({ type: "ITEM_ADDED", itemId: "record_cannot_continue", fields: {} }), /faulted/);
      assert.deepEqual(f.device.durable, concat(identity, encodeFrame({ kind: "event", event: known })));
    } finally { await f.core.close(); }
  }
});

test("durable but unwitnessed revoked history is verified and withheld from cursor exports", async () => {
  const f = await seedCursorCore(3, 32); let replica, member;
  try {
    const { invitation } = await f.core.inviteMember(bob.actorId);
    const rootCopy = await ProjectContext.open(f.context.invitation, alice, projectId);
    replica = await LocalCore.open(await LocalEventStore.open(new Device().open(), { actorId: alice.actorId, projectId }), alice, rootCopy);
    await replica.ingestEvents(await f.core.readEvents());
    member = await LocalCore.open(await LocalEventStore.open(new Device().open(), { actorId: bob.actorId, projectId }), bob, await ProjectContext.open(invitation, bob, projectId));
    const { event } = await member.dispatch({ type: "ITEM_ADDED", itemId: "record_not_witnessed", fields: { private: true } });
    await replica.ingestEvents([event]);
    const { event: revocation } = await f.core.revokeMember(bob.actorId); await replica.ingestEvents([revocation]);
    assert.ok((await replica.readEvents()).some(e => e.id === event.id), "Audit record stays durable");
    const cursor = await drainCursor(replica);
    assert.equal(cursor.events.some(e => e.id === event.id), false);
    assert.deepEqual(cursor.events.map(e => e.id).sort(), (await replica.readMissingEventsPaged({})).map(e => e.id).sort());
  } finally { await member?.close(); await replica?.close(); await f.core.close(); }
});

test("cursor capacity, idle expiry, explicit cleanup and core shutdown release all slots", async () => {
  const f = await seedCursorCore(1, 16);
  try {
    const cursors = await Promise.all(Array.from({ length: 32 }, () => f.core.openSyncCursor({})));
    await assert.rejects(f.core.openSyncCursor({}), /capacity/);
    await Promise.all(cursors.map(c => f.core.closeSyncCursor(c.id)));
    const next = await f.core.openSyncCursor({}); await f.core.closeSyncCursor(next.id); await f.core.closeSyncCursor(next.id);
    await assert.rejects(f.core.readSyncCursor(next.id), /Unknown/);
    assert.equal(f.core.syncCursors.size, 0);
    await f.core.openSyncCursor({}); await f.core.close(); assert.equal(f.core.syncCursors.size, 0);
  } finally { await f.core.close(); }
  const expiring = await seedCursorCore(1, 16, { syncCursorIdleTimeoutMs: 20 });
  try {
    const cursor = await expiring.core.openSyncCursor({}); await pause(50);
    await assert.rejects(expiring.core.readSyncCursor(cursor.id), /expired/); assert.equal(expiring.core.syncCursors.size, 0);
  } finally { await expiring.core.close(); }
});

test("cold checkpoint restores use bounded cursor reads without reconstructing a full history array", async () => {
  const devices = [new ReadTrackedDevice(), new Device(), new Device()];
  const initial = await ProjectContext.create(alice, projectId), invitation = initial.invitation; initial.close();
  async function open() {
    const context = await ProjectContext.open(invitation, alice, projectId), journal = new CheckpointJournal([devices[1].open(), devices[2].open()], context);
    const store = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
    return { store, context, core: await LocalCore.open(store, alice, context, { checkpointInterval: 20 }) };
  }
  let db = await open();
  try {
    for (let i = 0; i < 45; i++) await db.core.dispatch({ type: "ITEM_ADDED", itemId: `record_${i}`, fields: { i } });
    const before = await db.core.snapshot(); await db.core.close(); db = await open();
    assert.equal(db.core.history, null); assert.equal(db.core.recovery.checkpointEvents, 40); assert.equal(db.core.recovery.replayedEvents, 5);
    db.store.readEvents = async () => { throw new Error("Checkpoint history rebuild forbidden"); };
    db.context.evaluate = async () => { throw new Error("Full replay forbidden"); };
    const { events } = await drainCursor(db.core); assert.equal(events.length, 45); assert.equal(db.core.history, null);
    assert.deepEqual(await db.core.snapshot(), before);
  } finally { await db.core.close(); }
});

test("shutdown clears cursors opened by queued operations and does not restart timers during active reads", async () => {
  const queued = await seedCursorCore(2, 32);
  const opening = queued.core.openSyncCursor({});
  const closing = queued.core.close();
  await opening; await closing;
  assert.equal(queued.core.syncCursors.size, 0);

  const active = await seedCursorCore(2, 32); let release;
  active.store.openMissingEventScan = undefined;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const cursor = await active.core.openSyncCursor({});
    await active.core.readSyncCursor(cursor.id); // finish empty controls
    const original = active.store.readEventPage.bind(active.store); let entered = false;
    active.store.readEventPage = async (...args) => { entered = true; await gate; return original(...args); };
    const reading = active.core.readSyncCursor(cursor.id);
    await wait(() => entered);
    const stopping = active.core.close();
    assert.equal(active.core.syncCursors.size, 0);
    release(); await reading; await stopping;
    assert.equal(active.core.syncCursors.size, 0);
  } finally { release(); await active.core.close(); }
});

test("stream ACK backpressure stops further disk pages, then catch-up and live writes converge and clean cursors", async () => {
  const f = await seedCursorCore(180, 1024); let member, sa, sb, release;
  const gate = new Promise(resolve => { release = resolve; }); let blocked = false, reads = 0;
  try {
    const { invitation, event } = await f.core.inviteMember(bob.actorId);
    member = await LocalCore.open(await LocalEventStore.open(new Device().open(), { actorId: bob.actorId, projectId }), bob, await ProjectContext.open(invitation, bob, projectId));
    await member.ingestEvents([event]);
    f.store.readEvents = async () => { throw new Error("Sync must use bounded pages"); };
    const read = f.core.readSyncCursor.bind(f.core); f.core.readSyncCursor = id => { reads++; return read(id); };
    const ingest = member.ingestCommitted.bind(member);
    member.ingestEvents = async () => { throw new Error("Sync must skip full snapshot ingestion"); };
    member.ingestCommitted = async events => {
      if (!blocked && events.some(e => e.type === "ITEM_ADDED")) { blocked = true; await gate; }
      return ingest(events);
    };
    const links = byteLinks(); sa = new SyncSession(f.core); sb = new SyncSession(member); sa.connect(links[0]); sb.connect(links[1]);
    await wait(() => blocked); const stoppedAt = reads, bytes = f.device.stats.bytes;
    await pause(40); assert.equal(reads, stoppedAt); assert.equal(f.device.stats.bytes, bytes);
    await f.core.dispatch({ type: "ITEM_ADDED", itemId: "record_live", fields: { live: true } });
    release(); await wait(() => sa.state === "online" && sb.state === "online");
    await wait(async () => (await member.snapshot()).items.some(i => i.id === "record_live"));
    assert.deepEqual(await f.core.snapshot(), await member.snapshot());
    assert.equal(f.core.syncCursors.size, 0); assert.equal(member.syncCursors.size, 0);
  } finally { release(); sa?.stop(); sb?.stop(); await member?.close(); await f.core.close(); }
});
