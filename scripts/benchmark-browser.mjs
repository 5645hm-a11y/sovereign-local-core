import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/serve-fixtures.mjs"], { env: { ...process.env, LOCAL_CORE_PORT: String(port) }, stdio: "pipe", windowsHide: true });
let browser;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once("data", resolve); server.once("error", reject);
    server.once("exit", code => reject(new Error(`Benchmark server exited ${code}`)));
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(url); await page.evaluate(() => window.ready);
  const report = await page.evaluate(async () => {
    const source = `import { runProjectionBenchmark } from ${JSON.stringify(`${location.origin}/dist/projection-benchmark.js`)};
      onmessage = async () => {
        try { postMessage({ ok: true, report: await runProjectionBenchmark() }); }
        catch (error) { postMessage({ ok: false, error: String(error.stack) }); }
      };`;
    const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(blob, { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.ok ? resolve({ ...data.report, userAgent: navigator.userAgent, dedicatedWorker: true }) : reject(new Error(data.error));
        worker.onerror = reject; worker.postMessage(null);
      });
    } finally { worker.terminate(); URL.revokeObjectURL(blob); }
  });
  const recovery = await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const options = { email: "benchmark-recovery@example.test", password: "benchmark-only-password-2026", projectId: "benchmark-recovery" };
    const database = "benchmark-recovery";
    let core = new LocalCoreClient(); await core.createProject(database, options);
    let start = performance.now();
    for (let i = 0; i < 1001; i++) await core.dispatch({ type: i ? "ITEM_UPDATED" : "ITEM_ADDED", itemId: "item", fields: { n: i, text: "binary recovery" } });
    const creationMs = performance.now() - start;
    const liveDispatchMs = [];
    for (let i = 0; i < 5; i++) { start = performance.now(); await core.dispatch({ type: "ITEM_UPDATED", itemId: "item", fields: { n: 1001 + i } }); liveDispatchMs.push(performance.now() - start); }
    const expected = JSON.stringify(await core.snapshot()); await core.close();
    const checkpointOpenMs = [], fullReplayOpenMs = [];
    let recovered;
    for (let i = 0; i < 3; i++) {
      core = new LocalCoreClient(); start = performance.now(); recovered = await core.open(database, options); checkpointOpenMs.push(performance.now() - start);
      if (JSON.stringify(recovered.snapshot) !== expected || recovered.recovery.checkpointEvents !== 1000 || recovered.recovery.replayedEvents !== 6) throw new Error("Checkpoint recovery benchmark parity failed");
      await core.close();
    }
    // Only this isolated benchmark fixture loses its optional caches; authoritative log is preserved.
    const root = await navigator.storage.getDirectory(), ns = await root.getDirectoryHandle("sovereign-local-core"), dir = await ns.getDirectoryHandle(database);
    for (const name of ["checkpoint-0.slc", "checkpoint-1.slc"]) await dir.removeEntry(name);
    for (let i = 0; i < 3; i++) {
      core = new LocalCoreClient(); start = performance.now(); const opened = await core.open(database, options); fullReplayOpenMs.push(performance.now() - start);
      if (JSON.stringify(opened.snapshot) !== expected || opened.recovery.checkpointEvents !== 0 || opened.recovery.replayedEvents !== 1006) throw new Error("Full replay benchmark parity failed");
      await core.close();
    }
    const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
    return { events: 1006, checkpointEvents: 1000, deltaEvents: 6, samples: 3, creationMs, checkpointOpenMs, fullReplayOpenMs, liveDispatchMs,
      checkpointMedianMs: median(checkpointOpenMs), fullReplayMedianMs: median(fullReplayOpenMs), liveDispatchMedianMs: median(liveDispatchMs),
      scope: "Real LocalCoreClient/Worker/OPFS. Open includes module initialization, PBKDF2 vault unlock, metadata/crypto, raw-prefix digest, dedup index restore, native materialization and RPC. Full-replay path is the NEW binary engine without a cache, not the previous implementation. Five live dispatches include signing, encryption, OPFS flush and RPC." };
  });
  const build = JSON.parse(await readFile(new URL("../dist/wasm/build-info.json", import.meta.url), "utf8"));
  const result = { browser: await browser.version(), cpu: cpus()[0]?.model, compiler: build, recovery, ...report };
  await mkdir(new URL("../artifacts", import.meta.url), { recursive: true });
  await writeFile(new URL("../artifacts/benchmark-browser.json", import.meta.url), JSON.stringify(result, null, 2));
  console.table(result.results.map(row => ({ events: row.events, TS_ms: row.tsProjection.medianMs.toFixed(2), WASM_kernel_ms: row.wasmKernel.medianMs.toFixed(2), old_bridge_ms: row.wasmWithBridge.medianMs.toFixed(2), binary_batch_ms: row.binaryContiguousWithBridge.medianMs.toFixed(2), binary_records_ms: row.binaryRecordReplay.medianMs.toFixed(2), checkpoint_delta_ms: row.checkpointAndDelta.medianMs.toFixed(2), heap_MiB: (row.wasmLinearMemoryBytes / 1048576).toFixed(1) })));
  console.log("OPFS recovery:", recovery);
  console.log("Raw samples: artifacts/benchmark-browser.json");
} finally { await browser?.close(); server.kill(); }
