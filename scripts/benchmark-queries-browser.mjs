import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const server = spawn(process.execPath, ["scripts/serve-fixtures.mjs"], { env: { ...process.env, LOCAL_CORE_PORT: String(port) }, stdio: "pipe", windowsHide: true });
let browser;
try {
  await new Promise((resolve, reject) => { server.stdout.once("data", resolve); server.once("error", reject); server.once("exit", code => reject(new Error(`Fixture server exited ${code}`))); });
  browser = await chromium.launch({ channel: "chrome", headless: true }); const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}`);
  const results = [];
  for (const rows of [1000, 5000]) {
    const result = await page.evaluate(async rows => {
      const { LocalCoreClient } = await import("/dist/index.js"); const db = new LocalCoreClient(), samples = [], count = 50;
      try {
        await db.createProject(`query_benchmark_${rows}`, { mode: "wallet", walletId: `benchmark_${rows}`, passphrase: "public-benchmark-passphrase", projectId: `query_benchmark_${rows}` });
        const seedAt = performance.now();
        for (let i = 0; i < rows; i++) await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: `record_${String(i).padStart(6, "0")}`, fields: { i, text: "x".repeat(256) } });
        const seedMs = performance.now() - seedAt;
        for (let iteration = 0; iteration < count + 3; iteration++) {
          const timings = {};
          // Alternate order to reduce systematic first/second-call bias.
          for (const method of iteration % 2 ? ["dispatchCommitted", "dispatch"] : ["dispatch", "dispatchCommitted"]) {
            const at = performance.now(); const r = await db[method]({ type: "ITEM_UPDATED", itemId: "record_000000", fields: { marker: `${method}_${iteration}` } });
            timings[method] = performance.now() - at;
            if (method === "dispatch" ? r.snapshot.items.length !== rows : "snapshot" in r) throw new Error("Result mode mismatch");
          }
          const at = performance.now(), handle = await db.openQueryCursor({ kind: "items", prefix: "record_000000", limit: 1, maxBytes: 4096 });
          const result = await db.readQueryCursor(handle.id); await db.closeQueryCursor(handle.id); timings.queryOne = performance.now() - at;
          if (result.items.length !== 1 || result.items[0].fields.marker !== `${iteration % 2 ? "dispatch" : "dispatchCommitted"}_${iteration}`) throw new Error("Query parity failure");
          if (iteration >= 3) samples.push(timings);
        }
        const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
        const percentiles = Object.fromEntries(["dispatch", "dispatchCommitted", "queryOne"].map(k => [k, Object.fromEntries([["p50", .5], ["p95", .95], ["p99", .99]].map(([name, fraction]) => [name, percentile(samples.map(s => s[k]), fraction)]))]));
        const expected = (await db.snapshot()).items[0].fields.marker; await db.close();
        const reopen = new LocalCoreClient();
        try { const recovered = await reopen.open(`query_benchmark_${rows}`, { mode: "wallet", walletId: `benchmark_${rows}`, passphrase: "public-benchmark-passphrase", projectId: `query_benchmark_${rows}` });
          if (recovered.snapshot.items.length !== rows || recovered.snapshot.items[0].fields.marker !== expected) throw new Error("Durable reopen parity failure");
          return { rows, seedMs, repetitions: count, warmups: 3, samples, percentiles, recovery: recovered.recovery };
        } finally { await reopen.close(); }
      } finally { await db.close(); }
    }, rows);
    results.push(result); console.log(`Chrome OPFS query/receipt profile complete: ${rows} rows`);
  }
  const report = { date: new Date().toISOString(), cpu: cpus()[0].model, userAgent: await page.evaluate(() => navigator.userAgent),
    compiler: JSON.parse(await readFile("dist/wasm/build-info.json", "utf8")), wasmSha256: createHash("sha256").update(await readFile("dist/wasm/core_engine.wasm")).digest("hex"),
    scope: "Real headless Chrome LocalCoreClient/Dedicated Worker/OPFS. Dispatch timings include Web Crypto, authorization, native apply, log flush, commit notification and RPC; legacy dispatch also returns a full structured-cloned view. Policy-free LWW rows, no network or UI query listeners. Timed updates remain between checkpoints after seeding; periodic cache writes are not measured. QueryOne includes open/read/close RPCs for a one-row prefix. 50 samples are descriptive p50/p95/p99 observations, not production latency guarantees. Reopen equality is asserted but open time is not measured.", results };
  await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/benchmark-queries-browser.json", JSON.stringify(report, null, 2) + "\n");
  console.table(results.map(r => ({ rows: r.rows, legacy_p50: r.percentiles.dispatch.p50.toFixed(2), receipt_p50: r.percentiles.dispatchCommitted.p50.toFixed(2), legacy_p95: r.percentiles.dispatch.p95.toFixed(2), receipt_p95: r.percentiles.dispatchCommitted.p95.toFixed(2), query1_p50: r.percentiles.queryOne.p50.toFixed(2) })));
} finally { await browser?.close(); server.kill(); }
