import assert from "node:assert/strict";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { seedCursorCore } from "../tests/helpers/sync-cursor-fixtures.mjs";
import { getWasmDiagnostics } from "../dist/wasm-loader.js";

const argument = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const count = Number(argument("count", "2000")), samples = Number(argument("samples", "3"));
assert.ok(Number.isInteger(count) && count >= 50 && count <= 10000, "count must be 50–10,000");
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 10, "samples must be 1–10");
const output = argument("output", "docs/benchmarks/sync-cursor-indexed-node.json");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const f = await seedCursorCore(count, 128);
const indexedScan = f.store.openMissingEventScan.bind(f.store);
const report = {
  date: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  count, fields: { textCodeUnits: 128, revision: "sequence" }, logBytes: f.device.durable.length, samples,
  scope: "Real signed/encrypted source-side catch-up, WASM-validated with resident offset index at setup. In-memory SyncFile; excludes index construction/checkpoint/startup, real OPFS, receiver, RTC and disk flush. Not a browser throughput or peak-RAM benchmark.",
  bounds: { recordsPerPage: 64, targetRawBytes: 131072, maximumSingleRecordBytes: 1048576 }, results: [],
};
try {
  for (const scenario of ["full", "tail20"]) {
    const known = scenario === "full" ? 0 : count - 20, summary = { [f.core.actorId]: known };
    const expected = new Map(f.events.filter(e => e.sequence > known).map(e => [e.id, e]));
    const measurements = { bulk: [], sequential: [], indexed: [] };
    for (let iteration = -1; iteration < samples; iteration++) {
      for (const mode of ["bulk", "sequential", "indexed"]) {
        f.store.openMissingEventScan = mode === "sequential" ? undefined : indexedScan;
        globalThis.gc?.(); f.device.resetReads();
        const seen = new Set(), nativeBefore = getWasmDiagnostics().mergeCalls;
        const validate = events => {
          for (const e of events) {
            assert.ok(!seen.has(e.id)); seen.add(e.id);
            assert.equal(e.signature, expected.get(e.id)?.signature);
            assert.equal(e.encryptedFields.ciphertext, expected.get(e.id)?.encryptedFields.ciphertext);
          }
        };
        const start = performance.now(); let firstBatchMs, firstBatchReadBytes, pages = 0, maxEvents = 0, maxRawBytes = 0;
        if (mode === "bulk") {
          const events = await f.core.readMissingEventsPaged(summary);
          firstBatchMs = performance.now() - start; firstBatchReadBytes = f.device.stats.bytes;
          maxEvents = events.length; validate(events);
        } else {
          const cursor = await f.core.openSyncCursor(summary); assert.ok(cursor);
          try {
            while (true) {
              const page = await f.core.readSyncCursor(cursor.id); pages++;
              assert.ok(page.events.length <= 64); assert.ok(page.scannedBytes <= 131072);
              maxEvents = Math.max(maxEvents, page.events.length); maxRawBytes = Math.max(maxRawBytes, page.scannedBytes);
              if (firstBatchMs === undefined && page.events.length) { firstBatchMs = performance.now() - start; firstBatchReadBytes = f.device.stats.bytes; }
              validate(page.events); if (page.done) break;
            }
          } finally { await f.core.closeSyncCursor(cursor.id); }
        }
        const totalMs = performance.now() - start;
        assert.equal(seen.size, expected.size); assert.equal(getWasmDiagnostics().mergeCalls, nativeBefore);
        const measurement = { firstBatchMs, totalMs, firstBatchReadBytes, totalReadBytes: f.device.stats.bytes, pages, maxEvents, maxRawBytes, eventCount: seen.size };
        if (iteration >= 0) measurements[mode].push(measurement);
      }
    }
    const medians = Object.fromEntries(Object.entries(measurements).map(([mode, rows]) => [mode,
      Object.fromEntries(Object.keys(rows[0]).map(key => [key, median(rows.map(row => row[key]))]))]));
    report.results.push({ scenario, knownSequence: known, expectedEvents: expected.size, medians, measurements });
  }
  await mkdir(new URL("../docs/benchmarks/", import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ logBytes: report.logBytes, results: report.results.map(({ scenario, medians }) => ({ scenario, medians })), output }, null, 2));
} finally { await f.core.close(); }
