import test from "node:test";
import assert from "node:assert/strict";
import { SyncSession } from "../../dist/sync-session.js";
import { createFrontier, FrontierAccumulator, normalizeFrontierManifest } from "../../dist/sync-frontier.js";
import { normalizeSummary } from "../../dist/event-index.js";
import { encodeWire, decodeWire } from "../../dist/binary-events.js";
import { toBase64Url } from "../../dist/crypto-codec.js";
import { Device, core, event, bob, alice, store, projectId } from "../helpers/core-fixtures.mjs";
import { LocalCore } from "../../dist/engine.js";
import { ProjectContext } from "../../dist/project.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, timeout = 15000) {
  const until = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > until) throw new Error("Sync test timed out"); await pause(5); }
}
// Valid SEC1 encodings, deliberately NOT signing keys: scale tests measure the
// transport/frontier boundary. Real cryptographic core checks are tested below.
function actor(i) { const bytes = new Uint8Array(65); bytes[0] = 4; new DataView(bytes.buffer).setUint32(61, i); return `p256_${toBase64Url(bytes)}`; }
const actors = Array.from({ length: 10001 }, (_, i) => actor(i + 1)).sort();
function item(actorId, sequence = 1) { return { id: `${actorId}:${sequence}`, actorId, sequence, lamport: sequence, itemId: actorId, type: "ITEM_ADDED", fields: { revision: sequence } }; }
function mockCore(initial = [], paged = true) {
  const log = new Map(), writers = new Map(), listeners = new Set();
  const record = event => {
    const known = log.get(event.id);
    if (known) { assert.deepEqual(encodeWire(known), encodeWire(event), "Mock semantic equivocation check"); return false; }
    log.set(event.id, event);
    const w = writers.get(event.actorId) ?? { sequence: 0, seen: new Set() }; w.seen.add(event.sequence);
    while (w.seen.has(w.sequence + 1)) w.sequence++;
    writers.set(event.actorId, w); return true;
  };
  initial.forEach(record);
  const summary = () => Object.fromEntries([...writers].sort(([a], [b]) => a < b ? -1 : 1).map(([id, w]) => [id, w.sequence]));
  const missing = async s => [...log.values()].filter(e => e.sequence > (s[e.actorId] ?? 0));
  const api = {
    log, getSyncSummary: async () => summary(), readMissingEvents: async s => missing(normalizeSummary(s)),
    async ingestEvents(events) {
      assert.ok(events.length <= 64); let applied = 0;
      for (const e of events) if (record(e)) { applied++; for (const fn of listeners) fn({ source: "remote", event: e }); }
      return { applied, summary: summary(), snapshot: { schemaVersion: 1, lamport: 0, items: [] } };
    },
    onCommit(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    local(e) { if (record(e)) for (const fn of listeners) fn({ source: "local", event: e }); },
  };
  if (paged) api.readMissingEventsPaged = s => missing(normalizeSummary(s, 262144));
  return api;
}

/** Inspect actual framed binary streams, optionally corrupt or drop a message. */
function links(observer = () => {}) {
  const counters = { frames: 0, bytes: 0, maxFrame: 0, maxFrontier: 0, frontierPages: 0, batchEvents: [] };
  function direction(label) {
    let assembly = null;
    return new TransformStream({ async transform(framed, controller) {
      counters.frames++; counters.bytes += framed.length; counters.maxFrame = Math.max(counters.maxFrame, framed.length);
      const header = new DataView(framed.buffer, framed.byteOffset + 4, 16);
      const id = header.getUint32(4, true), total = header.getUint32(8, true), at = header.getUint32(12, true);
      if (at === 0) assembly = { bytes: new Uint8Array(total), frames: [] };
      assembly.bytes.set(framed.subarray(20), at); assembly.frames.push(framed);
      if (at + framed.length - 20 !== total) return;
      const message = decodeWire(assembly.bytes);
      if (message.type === "frontier-page") { counters.frontierPages++; counters.maxFrontier = Math.max(counters.maxFrontier, total); }
      if (message.type === "batch") counters.batchEvents.push(message.events.length);
      const result = await observer(message, label);
      if (result === null) { assembly = null; return; }
      if (result === undefined) for (const frame of assembly.frames) controller.enqueue(frame);
      else {
        const bytes = encodeWire(result);
        for (let at = 0; at < bytes.length; at += 16368) {
          const n = Math.min(16368, bytes.length - at), frame = new Uint8Array(n + 20), h = new DataView(frame.buffer);
          h.setUint32(0, n + 16, true); h.setUint32(4, 0x31505353, true); h.setUint32(8, id, true);
          h.setUint32(12, bytes.length, true); h.setUint32(16, at, true); frame.set(bytes.subarray(at, at + n), 20); controller.enqueue(frame);
        }
      }
      assembly = null;
    } });
  }
  const ab = direction("ab"), ba = direction("ba");
  return { counters, a: { readable: ba.readable, writable: ab.writable, close() {} }, b: { readable: ab.readable, writable: ba.writable, close() {} } };
}

test("10,000 writing actors: bounded frontier pages, holes, missing actors and live edits converge", async () => {
  const history = actors.slice(0, 10000).map(a => item(a)); history.push(item(actors[0], 2), item(actors[0], 3));
  const a = mockCore(history), b = mockCore([...history.slice(1, 5000), item(actors[0], 3), item(actors[10000])]);
  assert.equal((await b.getSyncSummary())[actors[0]], 0);
  const wire = links(), sa = new SyncSession(a), sb = new SyncSession(b);
  try {
    sa.connect(wire.a); sb.connect(wire.b);
    await wait(() => {
      if (sa.state === "offline" || sb.state === "offline") throw new Error(`${sa.lastError} / ${sb.lastError}`);
      return sa.state === "online" && sb.state === "online";
    });
    assert.deepEqual(await a.getSyncSummary(), await b.getSyncSummary());
    assert.equal(a.log.size, 10003); assert.equal(b.log.size, 10003);
    const order = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;
    assert.deepEqual(encodeWire([...a.log].sort(order)), encodeWire([...b.log].sort(order)));
    assert.equal(sa.stats.eventsSent, 5003); // includes duplicate seq3, because 1/2 were missing
    assert.equal(sb.stats.eventsSent, 1);
    b.local(item(actors[9999], 2)); await wait(() => a.log.has(`${actors[9999]}:2`));
    assert.equal(wire.counters.frontierPages, 119);
    assert.ok(wire.counters.maxFrontier <= 32768); assert.ok(wire.counters.maxFrame <= 16388);
    assert.ok(wire.counters.batchEvents.every(n => n <= 64));
    console.log("Synthetic frontier wire metrics:", JSON.stringify(wire.counters, (key, value) => key === "batchEvents" ? { batches: value.length, maximum: Math.max(...value) } : value));
  } finally { sa.stop(); sb.stop(); }
});

test("interrupted catch-up restarts from durable contiguous watermarks, without re-sending received actors", async () => {
  const a = mockCore(actors.slice(0, 10000).map(a => item(a))), b = mockCore();
  let release, blocked = false;
  const gate = new Promise(resolve => { release = resolve; });
  const first = links(async (m, dir) => { if (dir === "ab" && m.type === "batch" && b.log.size >= 192) { blocked = true; await gate; } });
  const sa = new SyncSession(a), sb = new SyncSession(b);
  try {
    sa.connect(first.a); sb.connect(first.b); await wait(() => {
      if (sa.state === "offline" || sb.state === "offline") throw new Error(`${sa.lastError} / ${sb.lastError}`);
      return blocked;
    });
    assert.equal(b.log.size, 192); assert.notEqual(sa.state, "online"); assert.notEqual(sb.state, "online");
    sa.stop(); sb.stop(); release(); await pause(10);
    const second = links(), ra = new SyncSession(a), rb = new SyncSession(b);
    try {
      ra.connect(second.a); rb.connect(second.b); await wait(() => ra.state === "online" && rb.state === "online");
      assert.equal(ra.stats.eventsSent, 10000 - 192); assert.deepEqual(await a.getSyncSummary(), await b.getSyncSummary());
    } finally { ra.stop(); rb.stop(); }
  } finally { release(); sa.stop(); sb.stop(); }
});

test("mixed versions keep small legacy cores working and reject large unsupported frontiers explicitly", async () => {
  for (const count of [2, 4097]) {
    const a = mockCore(actors.slice(0, count).map(a => item(a))), b = mockCore([item(actors[9999])], false), wire = links();
    const sa = new SyncSession(a), sb = new SyncSession(b);
    try {
      sa.connect(wire.a); sb.connect(wire.b);
      if (count === 2) {
        await wait(() => sa.state === "online" && sb.state === "online"); assert.deepEqual(await a.getSyncSummary(), await b.getSyncSummary());
        assert.equal(wire.counters.frontierPages, 0);
      } else {
        await wait(() => sa.state === "offline"); assert.match(sa.lastError, /paged-frontier-v1/); assert.notEqual(sb.state, "online");
      }
    } finally { sa.stop(); sb.stop(); }
  }
});

test("generation, page order, duplicate ranges and omissions cannot complete a frontier", () => {
  const source = Object.fromEntries(actors.slice(0, 257).map(id => [id, 0])), frontier = createFrontier(source);
  source[actors[0]] = 3; source[actors[9999]] = 1;
  const pages = [...frontier.pages];
  assert.equal(frontier.manifest.actors, 257); assert.equal(pages[0].summary[actors[0]], 0);
  for (const bad of [{ ...pages[0], id: crypto.randomUUID() }, pages[1], { ...pages[0], summary: {} }]) {
    assert.throws(() => new FrontierAccumulator(frontier.manifest).accept(bad));
  }
  const accumulator = new FrontierAccumulator(frontier.manifest);
  assert.equal(accumulator.accept(pages[0]), null); assert.throws(() => accumulator.accept(pages[0]), /order/);
  assert.throws(() => accumulator.accept({ ...pages[1], summary: pages[0].summary }), /Overlapping/);
  assert.throws(() => normalizeFrontierManifest({ version: 1, id: crypto.randomUUID(), actors: 262145, pages: 2049 }));
  assert.throws(() => normalizeFrontierManifest({ version: 1, id: crypto.randomUUID(), actors: 257, pages: 2 }));
  assert.throws(() => normalizeFrontierManifest({ version: 2, id: crypto.randomUUID(), actors: 257, pages: 3 }));
});

test("dropped final page and repeated page fail closed on the actual binary stream", async () => {
  for (const mode of ["drop", "repeat", "generation", "overlap"]) {
    const a = mockCore(actors.slice(0, 257).map(a => item(a))), b = mockCore(); let previous;
    const wire = links((m, dir) => {
      if (dir !== "ab" || m.type !== "frontier-page") return;
      if (m.index === 0) { previous = m; return; }
      if (mode === "drop") return null;
      if (mode === "repeat") return previous;
      if (mode === "generation") return { ...m, id: crypto.randomUUID() };
      return { ...m, summary: previous.summary };
    });
    const sa = new SyncSession(a, { acknowledgementTimeoutMs: 200 }), sb = new SyncSession(b, { acknowledgementTimeoutMs: 200 });
    try {
      sa.connect(wire.a); sb.connect(wire.b);
      await wait(() => sa.state === "offline" || sb.state === "offline");
      assert.notEqual(sa.state, "online"); assert.notEqual(sb.state, "online"); assert.equal(b.log.size, 0);
    } finally { sa.stop(); sb.stop(); }
  }
});

test("paged core exports retain real signature/equivocation checks and the legacy limit", async () => {
  const device = new Device(), db = await core(device);
  try {
    const one = await event(1, "ITEM_ADDED", { text: "signed" }, bob);
    await db.ingestEvents([one]);
    const summary = Object.fromEntries(actors.slice(0, 10000).map(id => [id, 0]));
    await assert.rejects(db.readMissingEvents(summary), /4096/);
    assert.deepEqual(await db.readMissingEventsPaged(summary), [one]);
    const before = device.durable.slice();
    await assert.rejects(db.ingestEvents([{ ...one, signature: "A".repeat(86) }]));
    await assert.rejects(db.ingestEvents([await event(1, "ITEM_ADDED", { text: "equivocation" }, bob)]), /Conflicting/);
    assert.deepEqual(device.durable, before);
    assert.equal((await db.getSyncSummary())[bob.actorId], 1);
  } finally { await db.close(); }
});

test("duplicate signed governance alone and mixed with a new item remains idempotent and fully validated", async () => {
  const device = new Device(), project = await ProjectContext.create(alice, projectId);
  const db = await LocalCore.open(await store(device), alice, project); const notifications = []; let member;
  try {
    const { event: invitation, invitation: bootstrap } = await db.inviteMember(bob.actorId);
    member = await LocalCore.open(await store(new Device(), bob), bob, await ProjectContext.open(bootstrap, bob, projectId));
    db.onCommit(n => notifications.push(n));
    const before = device.durable.slice();
    assert.equal((await db.ingestEvents([invitation])).applied, 0);
    assert.deepEqual(device.durable, before); assert.equal(notifications.length, 0);
    const { event: one } = await member.dispatch({ type: "ITEM_ADDED", itemId: "generic_record", fields: { text: "mixed with a known control" } });
    assert.equal((await db.ingestEvents([invitation, one])).applied, 1);
    assert.equal(notifications.length, 1);
    assert.equal((await db.ingestEvents([invitation, one])).applied, 0);
    const durable = device.durable.slice();
    await assert.rejects(db.ingestEvents([{ ...invitation, signature: "A".repeat(86) }]));
    assert.deepEqual(device.durable, durable);
    const { event: revocation } = await db.revokeMember(bob.actorId), rotated = device.durable.slice();
    assert.equal((await db.ingestEvents([revocation])).applied, 0);
    assert.deepEqual(device.durable, rotated);
    await assert.rejects(db.ingestEvents([{ ...revocation, signature: "A".repeat(86) }]));
    assert.deepEqual(device.durable, rotated);
  } finally { await member?.close(); await db.close(); }
});
