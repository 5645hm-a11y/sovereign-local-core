import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { runProjectionBenchmark } from "../dist/projection-benchmark.js";
import { BinaryProjection } from "../dist/wasm-loader.js";
import { projectItemsReference } from "../dist/crdt.js";
import { event, project } from "../tests/helpers/core-fixtures.mjs";

const results = await runProjectionBenchmark();
// Also report identical security/decryption work before both projection backends.
const events = [];
for (let i = 1; i <= 1000; i++) events.push(await event(i, i <= 100 ? "ITEM_ADDED" : "ITEM_UPDATED", { title: `encrypted-${i}`, n: i }, undefined, i, `item-${i % 100}`));
const native = await BinaryProjection.create();
const authenticated = { events: events.length, samples: 3, referenceMs: [], wasmMs: [] };
try {
  for (let iteration = 0; iteration < 4; iteration++) {
    let reference, actual, referenceMs, wasmMs;
    const runReference = async () => {
      const start = performance.now(), state = await project.evaluate(events);
      reference = projectItemsReference(state.items, 1000); referenceMs = performance.now() - start;
    };
    const runNative = async () => {
      const start = performance.now(), state = await project.evaluateBinary(events);
      try { native.reset(); native.applyAll(state.blocks); actual = native.snapshot(1000); }
      finally { state.blocks.forEach(b => b.fill(0)); }
      wasmMs = performance.now() - start;
    };
    if (iteration % 2) { await runNative(); await runReference(); } else { await runReference(); await runNative(); }
    assert.deepEqual(actual, reference);
    if (iteration) { authenticated.referenceMs.push(referenceMs); authenticated.wasmMs.push(wasmMs); }
  }
} finally { native.close(); }
authenticated.referenceMedianMs = [...authenticated.referenceMs].sort((a,b) => a-b)[1];
authenticated.wasmMedianMs = [...authenticated.wasmMs].sort((a,b) => a-b)[1];
const build = JSON.parse(await readFile(new URL("../dist/wasm/build-info.json", import.meta.url), "utf8"));
const report = { runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, compiler: build,
  ...results, authenticatedReplay: { ...authenticated, order: "Alternating", scope: "Same project.evaluate signature/chain checks + AES-GCM decryption, then projection. No OPFS I/O, normalization/dedup or module initialization." } };
await mkdir(new URL("../artifacts", import.meta.url), { recursive: true });
await writeFile(new URL("../artifacts/benchmark-node.json", import.meta.url), JSON.stringify(report, null, 2));
console.table(report.results.map(row => ({ events: row.events, TS_ms: row.tsProjection.medianMs.toFixed(2), WASM_kernel_ms: row.wasmKernel.medianMs.toFixed(2), old_bridge_ms: row.wasmWithBridge.medianMs.toFixed(2), binary_batch_ms: row.binaryContiguousWithBridge.medianMs.toFixed(2), binary_records_ms: row.binaryRecordReplay.medianMs.toFixed(2), checkpoint_delta_ms: row.checkpointAndDelta.medianMs.toFixed(2), heap_MiB: (row.wasmLinearMemoryBytes / 1048576).toFixed(1) })));
console.log("Authenticated replay:", authenticated);
console.log("Raw samples: artifacts/benchmark-node.json");
