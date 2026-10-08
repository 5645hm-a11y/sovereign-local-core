import test from "node:test";
import assert from "node:assert/strict";
import { WasmProjection, NativeMergeError, getWasmDiagnostics, loadWasmRuntime } from "../../dist/wasm-loader.js";
import { projectItemsReference } from "../../dist/crdt.js";

const event = (sequence, type, fields = {}, actorId = "actor-a", lamport = sequence, itemId = "item-1") =>
  ({ id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId, ...(type === "ITEM_DELETED" ? {} : { fields }) });

test("native projection matches ordinal ActorID ordering, tombstones, scalars, and all UTF-16 code units", async () => {
  const native = await WasmProjection.create();
  try {
    const inputs = [
      event(1, "ITEM_UPDATED", { title: "before add", null: null }),
      event(2, "ITEM_ADDED", { "\ud800": "\ufeff\udc00\ud800שלום🚀", "10": 1, "2": -0, bool: false, finite: Number.MAX_VALUE }),
      event(1, "ITEM_UPDATED", { title: "actor-z wins", bool: true }, "actor-z", 2),
      event(3, "ITEM_DELETED"), event(4, "ITEM_UPDATED", { title: "does not resurrect" }),
      event(5, "ITEM_ADDED", { restored: true }),
      event(Number.MAX_SAFE_INTEGER, "ITEM_ADDED", { safe: true }, "actor-z", Number.MAX_SAFE_INTEGER, "item-2"),
    ];
    const expected = projectItemsReference(inputs, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(native.materialize(inputs, Number.MAX_SAFE_INTEGER), expected);
    assert.deepEqual(native.materialize([...inputs].reverse(), Number.MAX_SAFE_INTEGER), expected);
    assert.deepEqual(native.materialize([...inputs, ...inputs], Number.MAX_SAFE_INTEGER), expected);
    assert.throws(() => { native.materialize(inputs, 1).items[0].fields.bool = false; }, TypeError);
  } finally { native.close(); }
});

test("seeded shuffled projections agree with the TypeScript reference", async () => {
  let seed = 123456789;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const native = await WasmProjection.create();
  try {
    for (let round = 0; round < 12; round++) {
      const events = Array.from({ length: 1000 }, (_, i) => {
        const type = ["ITEM_ADDED", "ITEM_UPDATED", "ITEM_DELETED"][random() % 3];
        return event(i + 1, type, { n: random(), text: `value-${random() % 100}`, empty: "", flag: !!(random() % 2), nullable: null },
          `actor-${random() % 16}`, 1 + random() % 100, `item-${random() % 100}`);
      });
      const expected = projectItemsReference(events, 100);
      for (let i = events.length - 1; i > 0; i--) { const j = random() % (i + 1); [events[i], events[j]] = [events[j], events[i]]; }
      assert.deepEqual(native.materialize(events, 100), expected);
    }
  } finally { native.close(); }
});

test("linear-memory growth refreshes views and snapshots outlive reused/freed input arenas", async () => {
  const native = await WasmProjection.create();
  try {
    const first = native.materialize([event(1, "ITEM_ADDED", { text: "stable" })], 1);
    const text = "a\ud800שלום🚀".repeat(800000); // More than the 8 MiB initial heap.
    const expected = projectItemsReference([event(2, "ITEM_ADDED", { text })], 2);
    assert.deepEqual(native.materialize([event(2, "ITEM_ADDED", { text })], 2), expected);
    // Reuse the large allocation while the next writer grows its own bounded view.
    const smaller = "value".repeat(10000);
    assert.deepEqual(native.materialize([event(3, "ITEM_ADDED", { text: smaller })], 3),
      projectItemsReference([event(3, "ITEM_ADDED", { text: smaller })], 3));
    assert.equal(first.items[0].fields.text, "stable");
    assert.ok(getWasmDiagnostics().memoryBytes > 8388608);
    assert.deepEqual(native.materialize([], 0), projectItemsReference([], 0));
    native.close(); assert.equal(first.items[0].fields.text, "stable");
    assert.throws(() => native.materialize([], 0), /closed/);
  } finally { native.close(); }
});

test("malformed native buffers fail explicitly and do not contaminate the next projection", async () => {
  const native = await WasmProjection.create();
  try {
    for (const corrupt of [
      view => view.setUint32(0, 0, true),
      view => view.setUint32(12, 32, true),
      view => view.setUint32(16, 0xffffffff, true),
      view => view.setUint32(68, 0xffffffff, true), // First event's scalar tag, before dictionaries.
    ]) {
      const batch = native.prepare([event(1, "ITEM_ADDED", { value: true })]);
      try {
        const bytes = batch.inputView(); corrupt(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        assert.throws(() => batch.runKernel(), NativeMergeError);
        assert.throws(() => batch.snapshot(1), /unavailable/);
      } finally { batch.dispose(); }
    }
    assert.deepEqual(native.materialize([event(1, "ITEM_ADDED", { value: true })], 1), projectItemsReference([event(1, "ITEM_ADDED", { value: true })], 1));
    const runtime = await loadWasmRuntime();
    assert.equal(runtime._core_merge(0xffffff00, 1024), 1);
  } finally { native.close(); }
});

test("expired and superseded binary output leases never expose another projection's snapshot", async () => {
  const a = await WasmProjection.create(), b = await WasmProjection.create();
  const first = a.prepare([event(1, "ITEM_ADDED", { label: "a" })]);
  try {
    assert.throws(() => a.prepare([]), /active/);
    assert.throws(() => a.close(), /active/);
    first.runKernel();
    assert.equal(b.materialize([event(1, "ITEM_ADDED", { label: "b" })], 1).items[0].fields.label, "b");
    assert.throws(() => first.snapshot(1), /superseded/);
    first.dispose();
    assert.throws(() => first.runKernel(), /expired/);
  } finally { first.dispose(); a.close(); b.close(); }
});
