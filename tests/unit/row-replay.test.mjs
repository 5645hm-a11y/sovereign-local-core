import test from "node:test";
import assert from "node:assert/strict";
import { BinaryProjection } from "../../dist/wasm-loader.js";
import { encodeCommands } from "../../dist/binary-command.js";
import { fullReplayCheckpoint } from "../helpers/business-replay-oracle.mjs";

const all = ["Admin", "Member", "Kiosk"];
const policy = { version: 1, defaultAllow: true, rules: [
  { prefix: "asset_", create: all, update: all, delete: ["Admin"], checkout: all, return: all, ownerField: null, library: true },
  { prefix: "owned_", create: all, update: all, delete: all, checkout: [], return: [], ownerField: "owner", library: false },
  { prefix: "owned_private_", create: ["Admin"], update: ["Admin"], delete: ["Admin"], checkout: [], return: [], ownerField: null, library: false },
] };
function candidate(actorId, sequence, lamport, type, itemId, fields = {}, role = "Admin") {
  return { command: { id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId, ...(type === "ITEM_DELETED" ? {} : { fields }) }, role };
}
function apply(native, candidates) { native.applyAuthorized(candidates.map(c => encodeCommands([c.command])), candidates.map(c => c.role)); }
function shuffle(values, seed) {
  const result = [...values]; let x = seed;
  for (let i = result.length - 1; i > 0; i--) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; const j = (x >>> 0) % (i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
async function parity(arrival, cadence = 1) {
  const incremental = await BinaryProjection.create(policy), full = await BinaryProjection.create(policy), seen = [];
  try {
    for (let offset = 0; offset < arrival.length; offset += cadence) {
      const next = arrival.slice(offset, offset + cadence); apply(incremental, next); seen.push(...next);
      const cp = fullReplayCheckpoint(policy, seen); full.restore(cp);
      assert.deepEqual(incremental.snapshot(10000), full.snapshot(10000));
      assert.deepEqual(incremental.checkpoint(), cp, "authoritative checkpoint bytes must retain canonical history");
      if (offset % 7 === 0) { incremental.restore(cp); assert.deepEqual(incremental.snapshot(10000), full.snapshot(10000)); }
    }
  } finally { incremental.close(); full.close(); }
}

test("suffix edits reduce only new commands; late edits replay only affected rows and duplicates reduce nothing", async () => {
  const native = await BinaryProjection.create(policy);
  try {
    const initial = Array.from({ length: 2000 }, (_, i) => candidate("actor_root", i + 1, i + 1, "ITEM_ADDED", `asset_${i}`, { label: `Asset ${i}` }));
    apply(native, initial); assert.equal(native.replayWork.commands, 2000);
    const tail = candidate("actor_root", 2001, 4000, "ITEM_UPDATED", "asset_0", { label: "Tail" });
    apply(native, [tail]); assert.deepEqual(native.replayWork, { rows: 1, commands: 1, suffixRows: 1, replayedRows: 0 });
    const late = candidate("actor_other", 1, 2, "CHECKOUT", "asset_0", { borrowerId: "borrower_1" }, "Member");
    apply(native, [late]); assert.deepEqual(native.replayWork, { rows: 1, commands: 3, suffixRows: 0, replayedRows: 1 });
    const prefix = candidate("actor_other", 2, 1, "ITEM_ADDED", "asset_999", { label: "Earlier" });
    const more = candidate("actor_root", 2002, 5000, "ITEM_UPDATED", "asset_0", { label: "Again" });
    apply(native, [more, prefix]); assert.deepEqual(native.replayWork, { rows: 2, commands: 3, suffixRows: 1, replayedRows: 1 });
    const cp = native.checkpoint(); apply(native, [tail, more]);
    assert.equal(native.replayWork.commands, 0); assert.deepEqual(native.checkpoint(), cp);
    const full = await BinaryProjection.create(policy);
    try { full.restore(fullReplayCheckpoint(policy, [...initial, tail, late, prefix, more])); assert.deepEqual(native.snapshot(5000), full.snapshot(5000)); }
    finally { full.close(); }
  } finally { native.close(); }
});

test("seeded mixed-row histories match full canonical replay after every shuffled batch/checkpoint", async () => {
  const events = []; let seq = 0;
  for (let i = 0; i < 12; i++) {
    events.push(candidate("actor_root", ++seq, 1, "ITEM_ADDED", `asset_${i}`, { label: "Unicode \ud800\uFEFF🙂", score: -0 }));
    events.push(candidate("actor_root", ++seq, 2, "ITEM_ADDED", `owned_${i}`, { owner: "actor_A", text: "owned" }));
    for (let n = 0; n < 8; n++) {
      const checkout = candidate("actor_A", i * 16 + n * 2 + 1, 10 + n * 4, "CHECKOUT", `asset_${i}`, { borrowerId: `reader_${n}` }, "Member");
      events.push(checkout, candidate("actor_A", i * 16 + n * 2 + 2, 13 + n * 4, "RETURN", `asset_${i}`, { checkoutId: checkout.command.id }, "Member"));
      events.push(candidate("actor_B", i * 8 + n + 1, 10 + n * 4, "CHECKOUT", `asset_${i}`, { borrowerId: "contender" }, "Kiosk"));
      events.push(candidate("actor_root", ++seq, 11 + n * 4, "ITEM_DELETED", `asset_${i}`));
      events.push(candidate("actor_root", ++seq, 14 + n * 4, "ITEM_ADDED", `asset_${i}`, { label: `restore_${n}` }));
      events.push(candidate("actor_owner", i * 8 + n + 1, 10 + n, "ITEM_UPDATED", `owned_${i}`, { text: "wrong owner" }, "Member"));
      events.push(candidate("actor_root", ++seq, 11 + n, "ITEM_UPDATED", `owned_${i}`, { owner: n % 2 ? "actor_A" : "actor_owner", text: "admin" }));
    }
  }
  for (const seed of [31, 97, 451]) await parity(shuffle([...events, ...events.slice(0, 9)], seed), 23);
});

test("early owner changes remove obsolete rejected decisions; tombstones and updates before adds retain exact checkpoint semantics", async () => {
  const events = [candidate("actor_root", 1, 20, "ITEM_ADDED", "owned_1", { owner: "actor_B", text: "created later" }),
    candidate("actor_A", 1, 25, "ITEM_UPDATED", "owned_1", { text: "member" }, "Member"),
    candidate("actor_root", 2, 30, "ITEM_DELETED", "owned_1"),
    candidate("actor_root", 3, 35, "ITEM_UPDATED", "owned_1", { marker: true }),
    candidate("actor_root", 4, 40, "ITEM_ADDED", "owned_1", { text: "resurrect" }),
    candidate("actor_root", 5, 24, "ITEM_UPDATED", "owned_1", { owner: "actor_A" }),
    candidate("actor_root", 6, 1, "ITEM_UPDATED", "record_1", { initial: true }),
    candidate("actor_root", 7, 2, "ITEM_DELETED", "record_1"),
    candidate("actor_root", 8, 3, "ITEM_UPDATED", "record_1", { afterDeletion: true }),
    candidate("actor_root", 9, 4, "ITEM_ADDED", "record_1", { final: null })];
  await parity(events);
});

test("multi-row malformed/denied/equivocating batches preserve native state, all indexes and checkpoint bytes", async () => {
  const native = await BinaryProjection.create(policy);
  try {
    const add = candidate("actor_root", 1, 1, "ITEM_ADDED", "asset_1", { label: "Original" }); apply(native, [add]);
    const cp = native.checkpoint(), snapshot = native.snapshot(1), work = native.replayWork;
    const good = candidate("actor_root", 2, 2, "ITEM_ADDED", "asset_2", { label: "would commit" });
    const bad = candidate("actor_member", 1, 3, "ITEM_DELETED", "asset_1", {}, "Member");
    const conflict = candidate("actor_root", 1, 1, "ITEM_ADDED", "asset_1", { label: "forged" });
    assert.throws(() => apply(native, [good, bad]), e => e.status === 3);
    assert.throws(() => apply(native, [good, conflict]), e => e.status === 1);
    const malformed = encodeCommands([good.command]).slice(0, -1);
    assert.throws(() => native.applyAuthorized([encodeCommands([good.command]), malformed], ["Admin", "Admin"]), e => e.status === 1);
    assert.deepEqual(native.checkpoint(), cp); assert.deepEqual(native.snapshot(1), snapshot); assert.deepEqual(native.replayWork, work);
    const corrupted = cp.slice(); new DataView(corrupted.buffer).setUint32(12, cp.length + 1, true);
    assert.throws(() => native.restore(corrupted), e => e.status === 1);
    assert.deepEqual(native.checkpoint(), cp);
    apply(native, [good]); assert.equal(native.snapshot(2).items.length, 2);
  } finally { native.close(); }
});
