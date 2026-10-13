import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { BinaryProjection, getWasmDiagnostics } from "../dist/wasm-loader.js";
import { encodeCommands } from "../dist/binary-command.js";
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [], repetitions = 5;
for (const rows of [1000, 10000, 100000]) {
  const started = performance.now(), bytes = encodeCommands(Array.from({ length: rows }, (_, i) => ({
    actorId: "actor_root", sequence: i + 1, lamport: i + 1, id: `actor_root:${i + 1}`, type: "ITEM_ADDED", itemId: `row_${String(i).padStart(6, "0")}`,
    fields: { n: i, status: i % 1000 ? "common" : "rare" },
  }))), producerMs = performance.now() - started;
  const q = { kind: "items", prefix: "row_", where: [{ field: "status", op: "eq", value: "rare" }], limit: 128, maxBytes: 65536 };
  const range = { kind: "items", prefix: "row_", where: [{ field: "n", op: "gte", value: rows - 100 }], orderBy: { field: "n", direction: "desc" }, limit: 128, maxBytes: 65536 };
  const native = await BinaryProjection.create(); native.apply(bytes); const samples = [];
  try {
    const all = native.snapshot(rows), expected = all.items.filter(i => i.fields.status === "rare");
    const editedSource = all.items.find(i => i.id === "row_000001");
    const editedExpected = [expected[0], { ...editedSource, fields: { ...editedSource.fields, status: "rare" } }, ...expected.slice(1)];
    for (let iteration = 0; iteration <= repetitions; iteration++) {
      // Restore deliberately clears disposable indexes; cold build is paid and reported.
      const checkpoint = native.checkpoint(); native.restore(checkpoint);
      let start = performance.now(); const cold = native.queryPage(q); const coldMs = performance.now() - start;
      start = performance.now(); const warm = native.queryPage(q); const warmMs = performance.now() - start;
      assert.deepEqual(cold.items, expected); assert.deepEqual(warm.items, expected); assert.equal(cold.indexBuildScanned, rows); assert.equal(warm.indexBuildScanned, 0);
      const output = []; let position, done = false, pages = 0, scanned = 0;
      start = performance.now();
      while (!done) { const page = native.queryPage({ ...q, index: "scan" }, position); output.push(...page.items); position = page.next; done = page.done; pages++; scanned += page.scanned; }
      const scanDrainMs = performance.now() - start; assert.deepEqual(output, expected); assert.equal(scanned, rows);
      start = performance.now(); const firstRange = native.queryPage(range); const rangeColdMs = performance.now() - start;
      start = performance.now(); const warmRange = native.queryPage(range); const rangeWarmMs = performance.now() - start;
      assert.deepEqual(warmRange.items.map(i => i.fields.n), Array.from({ length: 100 }, (_, i) => rows - 1 - i));
      assert.equal(firstRange.indexBuildScanned, rows); assert.equal(warmRange.scanned, 100);
      start = performance.now(); native.apply(encodeCommands([{ actorId: "actor_root", id: `actor_root:${rows + 1}`, sequence: rows + 1, lamport: rows + 1,
        type: "ITEM_UPDATED", itemId: "row_000001", fields: { status: "rare" } }])); const editAndMaintenanceMs = performance.now() - start;
      start = performance.now(); const maintained = native.queryPage(q); const queryAfterEditMs = performance.now() - start;
      assert.deepEqual(maintained.items, editedExpected); assert.equal(maintained.indexBuildScanned, 0);
      assert.equal(native.queryPage(range).indexBuildScanned, 0); // Unchanged numeric key is rewired, not rebuilt.
      const writeSamples = [], querySamples = [];
      for (let edit = 0; edit < 20; edit++) {
        const sequence = rows + 2 + edit, rare = edit % 2 === 1;
        start = performance.now();
        native.apply(encodeCommands([{ actorId: "actor_root", id: `actor_root:${sequence}`, sequence, lamport: sequence,
          type: "ITEM_UPDATED", itemId: "row_000001", fields: { status: rare ? "rare" : "common" } }]));
        writeSamples.push(performance.now() - start);
        start = performance.now(); const page = native.queryPage(q); querySamples.push(performance.now() - start);
        assert.equal(page.indexBuildScanned, 0); assert.equal(page.items.length, expected.length + Number(rare));
        assert.deepEqual(page.items, rare ? editedExpected : expected);
      }
      native.restore(checkpoint);
      if (iteration) samples.push({ coldMs, warmMs, scanDrainMs, rangeColdMs, rangeWarmMs, editAndMaintenanceMs, queryAfterEditMs,
        repeatedWriteMedianMs: median(writeSamples), repeatedQueryMedianMs: median(querySamples),
        scanPages: pages, scanned, indexedScanned: warm.scanned, indexKeyBytes: warm.indexKeyBytes });
    }
    results.push({ rows, matches: expected.length, producerMs, samples,
      medians: Object.fromEntries(Object.keys(samples[0]).map(k => [k, median(samples.map(s => s[k]))])), linearCapacityBytes: getWasmDiagnostics().memoryBytes });
  } finally { native.close(); }
  console.log(`Verified field query profile: ${rows} rows`);
}
const report = { date: new Date().toISOString(), runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model,
  compiler: JSON.parse(await readFile("dist/wasm/build-info.json", "utf8")), wasmSha256: createHash("sha256").update(await readFile("dist/wasm/core_engine.wasm")).digest("hex"),
  repetitions, warmups: 1, repeatedEdits: 20, scope: "Node native LWW projection + binary query bridge + decoded JS results. No crypto, OPFS, RPC, network, module startup or checkpoint/restore time is included in query timers. Restore resets caches between cold samples. Rare equality returns the same COMPLETE result as a full bounded scan; typed descending numeric range returns 100 rows. Edit timing includes single-command encoding/application and incremental maintenance of two indexes. First query after a small edit remains warm. Twenty alternating edits and exact-result queries per iteration verify maintained caches; reference snapshots and assertions are outside the measured intervals. Sorted vectors can still move O(n) references when a key changes; this is not logarithmic write performance.", results };
await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/benchmark-field-queries-node.json", JSON.stringify(report, null, 2) + "\n");
console.table(results.map(r => ({ rows: r.rows, cold_ms: r.medians.coldMs.toFixed(2), warm_ms: r.medians.warmMs.toFixed(2), scan_all_ms: r.medians.scanDrainMs.toFixed(2), edit_maintain_ms: r.medians.editAndMaintenanceMs.toFixed(2), after_edit_ms: r.medians.queryAfterEditMs.toFixed(2), repeated_edit_ms: r.medians.repeatedWriteMedianMs.toFixed(2) })));
