import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { BinaryProjection, getWasmDiagnostics } from "../dist/wasm-loader.js";
import { encodeCommands } from "../dist/binary-command.js";
import { seedCursorCore } from "../tests/helpers/sync-cursor-fixtures.mjs";

const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const samples = Number(process.argv.find(a => a.startsWith("--samples="))?.slice(10) ?? 5);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20);
const policy = { version: 1, defaultAllow: false, rules: [{ prefix: "record_", create: ["Admin"], update: ["Admin"], delete: ["Admin"], checkout: ["Admin"], return: ["Admin"], ownerField: null, library: true }] };
const nativeResults = [], durableResults = [];
for (const count of [1000, 10000, 50000, 99000]) {
  const rows = count / 5, blocks = [], loans = new Map();
  const producerAt = performance.now();
  for (let i = 0; i < count; i++) {
    const itemId = `record_${String(i < rows ? i : Math.floor((i - rows) / 2) % rows).padStart(6, "0")}`;
    const sequence = i + 1, type = i < rows ? "ITEM_ADDED" : (i - rows) % 2 ? "RETURN" : "CHECKOUT";
    const fields = type === "ITEM_ADDED" ? { text: "x".repeat(128), number: i } : type === "CHECKOUT" ? { borrowerId: "user" } : { checkoutId: loans.get(itemId) };
    if (type === "CHECKOUT") loans.set(itemId, `actor_root:${sequence}`);
    blocks.push(encodeCommands([{ id: `actor_root:${sequence}`, actorId: "actor_root", sequence, lamport: sequence, type, itemId, fields }]));
  }
  const producerMs = performance.now() - producerAt, native = await BinaryProjection.create(policy), timings = [];
  try {
    native.applyAuthorized(blocks, blocks.map(() => "Admin"));
    const expected = native.snapshot(count); assert.equal(expected.items.length, rows); assert.equal(expected.decisions.length, count - rows);
    // A complete drain must exactly equal the legacy full view before timing pages.
    for (const kind of ["items", "decisions"]) {
      let position, done = false; const all = [];
      while (!done) { const page = native.queryPage({ kind, limit: 128, maxBytes: 65536 }, position); all.push(...page[kind]); position = page.next; done = page.done; }
      assert.deepEqual(all, expected[kind]);
    }
    let itemPage, decisionPage;
    for (let iteration = 0; iteration <= samples; iteration++) {
      const at = performance.now(); native.snapshot(count); const fullMs = performance.now() - at;
      const itemAt = performance.now(); itemPage = native.queryPage({ kind: "items", limit: 128, maxBytes: 65536 }); const itemPageMs = performance.now() - itemAt;
      const decisionAt = performance.now(); decisionPage = native.queryPage({ kind: "decisions", limit: 128, maxBytes: 65536 }); const decisionPageMs = performance.now() - decisionAt;
      if (iteration) timings.push({ fullMs, itemPageMs, decisionPageMs });
    }
    nativeResults.push({ candidates: count, rows, decisions: count - rows, producerMs, samples: timings,
      medians: Object.fromEntries(Object.keys(timings[0]).map(k => [k, median(timings.map(s => s[k]))])),
      firstItemPage: { count: itemPage.items.length, bytes: itemPage.encodedBytes }, firstDecisionPage: { count: decisionPage.decisions.length, bytes: decisionPage.encodedBytes },
      linearCapacityBytes: getWasmDiagnostics().memoryBytes });
  } finally { native.close(); }
  console.log(`Native query parity/timing: ${count} candidates`);
}
for (const rows of [1000, 10000]) {
  const f = await seedCursorCore(rows, 256), timings = []; let encodedBytes;
  try {
    for (let iteration = 0; iteration <= samples; iteration++) {
      const at = performance.now(); const legacy = await f.core.dispatch({ type: "ITEM_UPDATED", itemId: "record_1", fields: { text: `legacy_${iteration}` } });
      const legacyMs = performance.now() - at;
      const compactAt = performance.now(); const receipt = await f.core.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_1", fields: { text: `compact_${iteration}` } });
      const compactMs = performance.now() - compactAt; assert.equal("snapshot" in receipt, false); assert.equal(legacy.snapshot.items.length, rows);
      const cursorAt = performance.now(), cursor = await f.core.openQueryCursor({ kind: "items", prefix: "record_1", limit: 1, maxBytes: 4096 });
      const page = await f.core.readQueryCursor(cursor.id); await f.core.closeQueryCursor(cursor.id);
      const scopedReadMs = performance.now() - cursorAt; assert.equal(page.items[0].fields.text, `compact_${iteration}`); encodedBytes = page.encodedBytes;
      if (iteration) timings.push({ legacyMs, compactMs, scopedReadMs });
    }
    durableResults.push({ rows, samples: timings, medians: Object.fromEntries(Object.keys(timings[0]).map(k => [k, median(timings.map(s => s[k]))])), encodedBytes,
      scope: "Real Web Crypto/signature/authorization/native apply and per-event flush into an in-memory test file. The Device copies bytes on writes/flush; this is not OPFS, Worker RPC, a disk durability benchmark or policy replay timing." });
  } finally { await f.core.close(); }
  console.log(`Core receipt timing: ${rows} rows`);
}
const report = { date: new Date().toISOString(), runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model,
  compiler: JSON.parse(await readFile(new URL("../dist/wasm/build-info.json", import.meta.url))),
  wasmSha256: createHash("sha256").update(await readFile(new URL("../dist/wasm/core_engine.wasm", import.meta.url))).digest("hex"),
  repetitions: samples, warmups: 1,
  scope: "Native results: Node WASM + binary bridge + decoded JS values, trusted roles, no crypto, OPFS, RPC/network or module startup. A first page is a partial result, not a full-result speedup. All complete drains are compared to full snapshots. Core timings separately include real crypto and a simulated flushed file. Medians are not percentile guarantees.",
  nativeResults, durableResults };
await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/benchmark-queries-node.json", JSON.stringify(report, null, 2) + "\n");
console.table(nativeResults.map(r => ({ candidates: r.candidates, rows: r.rows, full_ms: r.medians.fullMs.toFixed(2), items128_ms: r.medians.itemPageMs.toFixed(2), decisions128_ms: r.medians.decisionPageMs.toFixed(2) })));
console.table(durableResults.map(r => ({ rows: r.rows, legacy_ms: r.medians.legacyMs.toFixed(2), receipt_ms: r.medians.compactMs.toFixed(2), read1_ms: r.medians.scopedReadMs.toFixed(2) })));
