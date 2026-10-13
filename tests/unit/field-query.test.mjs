import test from "node:test";
import assert from "node:assert/strict";
import { BinaryProjection } from "../../dist/wasm-loader.js";
import { encodeCommands } from "../../dist/binary-command.js";
import { QueryIndexLimitError, normalizeQueryOptions, queryOptionsKey } from "../../dist/query.js";
const command = (sequence, type, itemId, fields = {}, lamport = sequence, actorId = "actor_root") => encodeCommands([{ id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId, fields }]);
const rank = v => v === undefined ? 5 : v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === "number" ? 3 : 4;
function cmp(a, b) { const r = rank(a) - rank(b); return r || (a < b ? -1 : a > b ? 1 : 0); }
function expected(snapshot, options) {
  const filters = options.where ?? [], order = options.orderBy ?? (options.index !== "scan" && filters.some(f => f.op === "eq") ? { field: filters.find(f => f.op === "eq").field, direction: "asc" } : null);
  const rows = snapshot.items.filter(i => i.id.startsWith(options.prefix ?? "") && filters.every(f => {
    if (!Object.hasOwn(i.fields, f.field)) return false; const value = i.fields[f.field];
    if (value === null ? f.value !== null : typeof value !== typeof f.value) return false;
    return f.op === "eq" ? value === f.value : f.op === "gt" ? value > f.value : f.op === "gte" ? value >= f.value : f.op === "lt" ? value < f.value : value <= f.value;
  }));
  return rows.sort((a, b) => (order ? cmp(a.fields[order.field], b.fields[order.field]) : 0) * (order?.direction === "desc" ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * (order?.direction === "desc" ? -1 : 1));
}
function drain(native, options) {
  const pages = [], items = []; let position;
  for (let i = 0; i < 1000; i++) { const page = native.queryPage({ kind: "items", limit: 7, maxBytes: 2048, ...options }, position); pages.push(page); items.push(...page.items); if (page.done) return { pages, items }; position = page.next; }
  throw new Error("Field query made no progress");
}

test("field filters/order pages match an independent scalar reference across types, prefixes and directions", async () => {
  const native = await BinaryProjection.create();
  try {
    const values = [null, false, true, -20, -0, 3.5, Number.MAX_VALUE, -Number.MAX_VALUE, "", "a", "aa", "\ufeff", "\ud83e\uddea", "\ud800"];
    const blocks = Array.from({ length: 400 }, (_, i) => command(i + 1, "ITEM_ADDED", `${i < 350 ? "row_" : "other_"}${String(i).padStart(4, "0")}`, {
      ...(i % 15 ? { value: values[i % values.length] } : {}), status: i % 7 ? "open" : "closed", priority: i % 13, marker: i }));
    native.applyAll(blocks); native.applyAll(Array.from({ length: 40 }, (_, i) => command(1000 + i, "ITEM_DELETED", `row_${String(i).padStart(4, "0")}`)));
    const view = native.snapshot(1200), checkpoint = native.checkpoint();
    const queries = [
      { orderBy: { field: "marker" } }, { orderBy: { field: "marker", direction: "desc" } },
      { prefix: "row_", orderBy: { field: "value" } }, { prefix: "row_", orderBy: { field: "value", direction: "desc" } },
      ...values.map(value => ({ prefix: "row_", where: [{ field: "value", op: "eq", value }] })),
      ...["gt", "gte", "lt", "lte"].flatMap(op => [
        { where: [{ field: "value", op, value: 3.5 }], orderBy: { field: "value" } },
        { where: [{ field: "value", op, value: "a" }], orderBy: { field: "value", direction: "desc" } },
        { where: [{ field: "value", op, value: 0 }], index: "scan" },
      ]),
      { where: [{ field: "status", op: "eq", value: "open" }, { field: "priority", op: "gte", value: 10 }], orderBy: { field: "priority", direction: "desc" } },
      { where: [{ field: "value", op: "gt", value: 10 }, { field: "value", op: "lt", value: -10 }], orderBy: { field: "value" } },
      { where: [{ field: "value", op: "eq", value: null }, { field: "value", op: "gte", value: 0 }], orderBy: { field: "value" } },
      { where: [{ field: "value", op: "gte", value: "a" }, { field: "value", op: "lte", value: "a" }], orderBy: { field: "value" } },
      { where: [{ field: "value", op: "gte", value: "a" }, { field: "value", op: "lt", value: "a" }], orderBy: { field: "value" } },
    ];
    for (const q of queries) {
      const result = drain(native, q); assert.deepEqual(result.items, expected(view, q), JSON.stringify(q));
      for (const p of result.pages) { assert.ok(p.scanned <= 256); assert.ok(p.items.length <= 7); assert.ok(p.encodedBytes <= 2048); }
    }
    assert.deepEqual(native.checkpoint(), checkpoint);
  } finally { native.close(); }
});

test("warm indexes seek narrow equality/ranges, survive incremental edits and rebuild on LRU eviction/restore", async () => {
  const native = await BinaryProjection.create();
  try {
    const blocks = Array.from({ length: 1000 }, (_, i) => command(i + 1, "ITEM_ADDED", `row_${String(i).padStart(4, "0")}`, { n: i, group: i % 2, alternate: String(i) }));
    native.applyAll(blocks);
    const q = { kind: "items", prefix: "row_", where: [{ field: "n", op: "gte", value: 990 }], orderBy: { field: "n" }, limit: 128 };
    const cold = native.queryPage(q), warm = native.queryPage(q); assert.equal(cold.indexBuildScanned, 1000); assert.equal(warm.indexBuildScanned, 0); assert.equal(warm.scanned, 10);
    assert.deepEqual(warm.items.map(i => i.fields.n), Array.from({ length: 10 }, (_, i) => i + 990));
    const equality = native.queryPage({ kind: "items", where: [{ field: "n", op: "eq", value: 997 }] }); assert.equal(equality.scanned, 1);
    native.queryPage({ kind: "items", orderBy: { field: "group" } }); native.queryPage({ kind: "items", orderBy: { field: "alternate" } });
    assert.equal(native.queryPage(q).indexBuildScanned, 1000);
    const cp = native.checkpoint(); native.apply(command(2000, "ITEM_UPDATED", "row_0990", { n: -5 }));
    const edited = native.queryPage(q); assert.equal(edited.indexBuildScanned, 0); assert.equal(edited.items.length, 9);
    native.restore(cp); assert.equal(native.queryPage(q).items.length, 10);
    const bad = cp.slice(); new DataView(bad.buffer).setUint32(12, 1, true); assert.throws(() => native.restore(bad));
    assert.equal(native.queryPage(q).indexBuildScanned, 0); assert.equal(native.queryPage(q).items.length, 10);
  } finally { native.close(); }
});

test("late policy replay, denied edits and exact retries keep indexed outcomes equal to current native state", async () => {
  const policies = { version: 1, defaultAllow: true, rules: [{ prefix: "asset_", create: ["Admin"], update: ["Admin"], delete: ["Admin"], checkout: ["Admin", "Member"], return: ["Admin", "Member"], ownerField: null, library: true }] };
  const native = await BinaryProjection.create(policies);
  try {
    const add = command(1, "ITEM_ADDED", "asset_one", { name: "Resource" });
    const checkout = command(1, "CHECKOUT", "asset_one", { borrowerId: "late" }, 10, "actor_late");
    native.applyAuthorized([add, checkout], ["Admin", "Member"]);
    const q = { kind: "items", prefix: "asset_", orderBy: { field: "borrowerId" } }; assert.equal(native.queryPage(q).items[0].fields.borrowerId, "late");
    assert.throws(() => native.applyAuthorized([command(2, "ITEM_DELETED", "asset_one", {}, 20, "actor_late")], ["Member"]));
    assert.equal(native.queryPage(q).indexBuildScanned, 0);
    native.applyAuthorized([checkout], ["Member"]); assert.equal(native.queryPage(q).indexBuildScanned, 0);
    native.applyAuthorized([command(1, "CHECKOUT", "asset_one", { borrowerId: "early" }, 2, "actor_early")], ["Member"]);
    assert.equal(native.queryPage(q).indexBuildScanned, 0); assert.equal(native.queryPage(q).items[0].fields.borrowerId, "early"); assert.deepEqual(drain(native, q).items, expected(native.snapshot(20), q));
  } finally { native.close(); }
});

test("scan filtering progresses through empty pages and field-index bounds fail explicitly without damaging rows", async () => {
  const native = await BinaryProjection.create();
  try {
    native.applyAll(Array.from({ length: 900 }, (_, i) => command(i + 1, "ITEM_ADDED", `row_${String(i).padStart(4, "0")}`, { match: i === 899, large: "x".repeat(1025) })));
    const options = { kind: "items", prefix: "row_", where: [{ field: "match", op: "eq", value: true }], index: "scan", maxBytes: 8192 };
    const first = native.queryPage(options); assert.equal(first.items.length, 0); assert.equal(first.done, false); assert.equal(first.scanned, 256);
    assert.equal(drain(native, options).items[0].id, "row_0899");
    const cp = native.checkpoint(); assert.throws(() => native.queryPage({ kind: "items", orderBy: { field: "large" } }), QueryIndexLimitError);
    assert.deepEqual(native.checkpoint(), cp); assert.equal(native.queryPage({ kind: "items", where: [{ field: "match", op: "eq", value: true }], maxBytes: 8192 }).scanned, 1);
    const invalid = [{ kind: "decisions", where: [{ field: "x", op: "eq", value: 1 }] }, { kind: "items", where: [{ field: "x", op: "gt", value: false }] },
      { kind: "items", orderBy: { field: "__proto__" } }, { kind: "items", orderBy: { field: "x" }, index: "scan" },
      { kind: "items", where: [{ field: "x", op: "eq", value: NaN }] }, { kind: "items", where: [{ field: "x", op: "eq", value: "x".repeat(1025) }] }];
    for (const q of invalid) assert.throws(() => normalizeQueryOptions(q));
    assert.equal(queryOptionsKey(normalizeQueryOptions({ kind: "items", where: [{ field: "x", op: "eq", value: -0 }] })), queryOptionsKey(normalizeQueryOptions({ kind: "items", where: [{ field: "x", op: "eq", value: 0 }] })));
  } finally { native.close(); }
});


test("field-index row/key-byte caps are explicit and failed builds leave existing indexes and checkpoints usable", async () => {
  const native = await BinaryProjection.create();
  try {
    native.applyAll(Array.from({ length: 10000 }, (_, i) => command(i + 1, "ITEM_ADDED", `wide_${String(i).padStart(5, "0")}`, { small: i, wide: "x".repeat(1024) })));
    const q = { kind: "items", prefix: "wide_", where: [{ field: "small", op: "eq", value: 9999 }] };
    assert.equal(native.queryPage(q).items.length, 1); const cp = native.checkpoint();
    assert.throws(() => native.queryPage({ kind: "items", prefix: "wide_", orderBy: { field: "wide" } }), QueryIndexLimitError);
    assert.deepEqual(native.checkpoint(), cp); assert.equal(native.queryPage(q).indexBuildScanned, 0);
  } finally { native.close(); }
  const rows = await BinaryProjection.create();
  try {
    rows.apply(encodeCommands(Array.from({ length: 100001 }, (_, i) => ({ actorId: "actor_root", sequence: i + 1, lamport: i + 1,
      id: `actor_root:${i + 1}`, type: "ITEM_ADDED", itemId: `row_${String(i).padStart(6, "0")}`, fields: { n: i } }))));
    assert.throws(() => rows.queryPage({ kind: "items", orderBy: { field: "n" } }), QueryIndexLimitError);
    assert.equal(rows.queryPage({ kind: "items", prefix: "row_099", orderBy: { field: "n" }, limit: 2 }).items.length, 2);
    assert.equal(rows.queryPage({ kind: "items", index: "scan", where: [{ field: "n", op: "gte", value: 0 }] }).items.length, 128);
  } finally { rows.close(); }
});


test("incremental indexes converge across batched late edits, hidden rows, deletions and resurrection without cold builds", async () => {
  const native = await BinaryProjection.create();
  const queries = [
    { kind: "items", prefix: "row_", orderBy: { field: "value" } },
    { kind: "items", prefix: "row_", where: [{ field: "status", op: "eq", value: "open" }] },
  ];
  let sequence = 1000, random = 0x13fab123;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  try {
    native.applyAll(Array.from({ length: 500 }, (_, i) => command(i + 1, "ITEM_ADDED", `row_${String(i).padStart(4, "0")}`, { value: i % 9, status: i % 2 ? "open" : "closed", residual: i })));
    for (const q of queries) native.queryPage(q);
    // These writes must only rewire pointers or remove references: an old winning
    // stamp need not advance, but copied/replaced row nodes still expire.
    native.apply(command(++sequence, "ITEM_UPDATED", "row_0000", { value: -1 }, 1));
    native.apply(command(++sequence, "ITEM_UPDATED", "row_0001", { residual: "new" }));
    native.apply(command(++sequence, "ITEM_UPDATED", "row_unborn", { value: null }));
    native.apply(command(++sequence, "ITEM_DELETED", "row_0002"));
    native.apply(command(++sequence, "ITEM_ADDED", "row_0002", { value: "resurrected", status: "open" }));
    native.apply(command(++sequence, "ITEM_ADDED", "other_one", { value: "x".repeat(1025) }));
    const values = [null, false, true, -0, -5, 20, "", "alpha", "\ufeff", "\ud800"];
    for (let iteration = 0; iteration < 50; iteration++) {
      const blocks = Array.from({ length: 1 + next() % 12 }, () => {
        const i = next() % 520, type = ["ITEM_ADDED", "ITEM_UPDATED", "ITEM_DELETED"][next() % 3];
        const seq = ++sequence, lamport = next() % 3 ? seq : 1 + next() % 500;
        return command(seq, type, `row_${String(i).padStart(4, "0")}`, type === "ITEM_DELETED" ? {} : { value: values[next() % values.length], status: next() % 2 ? "open" : "closed", residual: seq }, lamport);
      });
      native.applyAll(blocks);
      const snapshot = native.snapshot(sequence), cp = native.checkpoint();
      for (const q of queries) {
        assert.equal(native.queryPage(q).indexBuildScanned, 0);
        assert.deepEqual(drain(native, q).items, expected(snapshot, q));
      }
      assert.deepEqual(native.checkpoint(), cp);
    }
    // A valid block followed by malformed trailing bytes is still an atomic failure.
    const valid = command(++sequence, "ITEM_UPDATED", "row_0001", { value: "forbidden" });
    const bad = valid.slice(0, -1), cp = native.checkpoint();
    assert.throws(() => native.applyAll([valid, bad]));
    assert.deepEqual(native.checkpoint(), cp);
    for (const q of queries) assert.equal(native.queryPage(q).indexBuildScanned, 0);
  } finally { native.close(); }
});

test("index maintenance drops only affected caches for large deltas or oversized keys, never rejects a valid write", async () => {
  const native = await BinaryProjection.create();
  try {
    native.applyAll(Array.from({ length: 600 }, (_, i) => command(i + 1, "ITEM_ADDED", `${i < 300 ? "alpha_" : "beta_"}${String(i).padStart(4, "0")}`, { n: i, text: "small" })));
    const alpha = { kind: "items", prefix: "alpha_", orderBy: { field: "text" } };
    const beta = { kind: "items", prefix: "beta_", orderBy: { field: "n" } };
    native.queryPage(alpha); native.queryPage(beta);
    native.apply(command(1000, "ITEM_UPDATED", "alpha_0000", { text: "x".repeat(1025) }));
    assert.throws(() => native.queryPage(alpha), QueryIndexLimitError);
    assert.equal(native.queryPage(beta).indexBuildScanned, 0);
    assert.equal(drain(native, { kind: "items", prefix: "alpha_", index: "scan", maxBytes: 8192 }).items[0].fields.text.length, 1025);
    native.apply(command(1001, "ITEM_UPDATED", "alpha_0000", { text: "small" }));
    assert.equal(native.queryPage(alpha).indexBuildScanned, 300);
    native.applyAll(Array.from({ length: 256 }, (_, i) => command(2000 + i, "ITEM_UPDATED", `alpha_${String(i).padStart(4, "0")}`, { text: String(i % 4) })));
    assert.equal(native.queryPage(alpha).indexBuildScanned, 0);
    assert.equal(native.queryPage(beta).indexBuildScanned, 0);
    native.applyAll(Array.from({ length: 257 }, (_, i) => command(3000 + i, "ITEM_UPDATED", `alpha_${String(i).padStart(4, "0")}`, { text: String(i % 7) })));
    assert.equal(native.queryPage(beta).indexBuildScanned, 0);
    assert.equal(native.queryPage(alpha).indexBuildScanned, 300);
    const snapshot = native.snapshot(4000);
    assert.deepEqual(drain(native, alpha).items, expected(snapshot, alpha));
    assert.deepEqual(drain(native, beta).items, expected(snapshot, beta));
  } finally { native.close(); }
});

test("maintained indexes enforce updated accounted bytes and hidden-row counts at their original limits", async () => {
  const native = await BinaryProjection.create();
  try {
    native.apply(encodeCommands(Array.from({ length: 9000 }, (_, i) => ({ actorId: "actor_root", sequence: i + 1, lamport: i + 1,
      id: `actor_root:${i + 1}`, type: "ITEM_ADDED", itemId: `wide_${String(i).padStart(5, "0")}`, fields: { text: "x".repeat(i < 7750 ? 1024 : 1) } }))));
    const q = { kind: "items", prefix: "wide_", orderBy: { field: "text" }, limit: 1, maxBytes: 8192 };
    const cold = native.queryPage(q); assert.equal(cold.indexBuildScanned, 9000);
    native.apply(command(10000, "ITEM_UPDATED", "wide_08000", { text: "x".repeat(1024) }));
    const warm = native.queryPage(q); assert.equal(warm.indexBuildScanned, 0); assert.equal(warm.indexKeyBytes - cold.indexKeyBytes, 2046);
    // Multiple legal scalar keys can exceed the aggregate budget.
    native.applyAll(Array.from({ length: 256 }, (_, i) => command(11000 + i, "ITEM_UPDATED", `wide_${String(8001 + i).padStart(5, "0")}`, { text: "x".repeat(1024) })));
    assert.throws(() => native.queryPage(q), QueryIndexLimitError);
  } finally { native.close(); }
  const rows = await BinaryProjection.create();
  try {
    rows.apply(encodeCommands(Array.from({ length: 100000 }, (_, i) => ({ actorId: "actor_root", sequence: i + 1, lamport: i + 1,
      id: `actor_root:${i + 1}`, type: "ITEM_ADDED", itemId: `row_${String(i).padStart(6, "0")}`, fields: { n: i } }))));
    const q = { kind: "items", prefix: "row_", orderBy: { field: "n" }, limit: 1 };
    rows.queryPage(q);
    rows.apply(command(100001, "ITEM_UPDATED", "row_unborn", { n: 0 }));
    assert.throws(() => rows.queryPage(q), QueryIndexLimitError);
    assert.equal(rows.queryPage({ kind: "items", prefix: "row_", index: "scan", limit: 1 }).items.length, 1);
  } finally { rows.close(); }
});
