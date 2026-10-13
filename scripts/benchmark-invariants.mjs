import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const argument = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const samples = Number(argument("samples", "3"));
const requestedRows = argument("rows", "default");
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20, "samples must be 1–20");

if (process.argv.includes("--worker")) {
  const count = Number(argument("count", "1000"));
  assert.ok(Number.isInteger(count) && count >= 10 && count <= 99998, "count must be 10–99,998");
  let phase = "startup", iterationIndex = 0;
  try {
    const { BinaryProjection, getWasmDiagnostics } = await import("../dist/wasm-loader.js");
    const { encodeCommands } = await import("../dist/binary-command.js");
    const { libraryPolicies } = await import("../dist/policies.js");
    const actor = async () => {
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      return `p256_${Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url")}`;
    };
    const admin = await actor(), kiosk = await actor();
    const books = requestedRows === "default" ? Math.min(1000, Math.floor(count / 10)) : Number(requestedRows);
    assert.ok(Number.isInteger(books) && books >= 1 && books <= Math.floor(count / 2), "rows must be 1 through half the candidate count");
    const blocks = [], roles = [], loans = new Map();
    const encode = (actorId, sequence, lamport, type, itemId, fields) => encodeCommands([
      { actorId, sequence, lamport, type, itemId, id: `${actorId}:${sequence}`, fields },
    ]);
    const producerStart = performance.now();
    for (let i = 0; i < count; i++) {
      const sequence = i + 1, itemId = `book_${i < books ? i : Math.floor((i - books) / 2) % books}`;
      let type, fields;
      if (i < books) { type = "ITEM_ADDED"; fields = { title: `Synthetic copy ${i}` }; }
      else if ((i - books) % 2 === 0) { type = "CHECKOUT"; fields = { borrowerId: `reader_${i % 100}` }; loans.set(itemId, `${admin}:${sequence}`); }
      else { type = "RETURN"; fields = { checkoutId: loans.get(itemId) }; }
      blocks.push(encode(admin, sequence, sequence * 4, type, itemId, fields)); roles.push("Admin");
    }
    const producerMs = performance.now() - producerStart;
    const tail = encode(admin, count + 1, (count + 1) * 4, "ITEM_UPDATED", "book_0", { title: "Tail update" });
    // After book_0 creation at clock 4, before its first historical checkout.
    const late = encode(kiosk, 1, 5, "CHECKOUT", "book_0", { borrowerId: "late_reader" });
    const times = [], policy = libraryPolicies();
    let checkpointBytes = 0, linearCapacityBytes = 0, observedRssBytes = 0, reducerWork;
    for (let iteration = 0; iteration <= samples; iteration++) {
      iterationIndex = iteration; phase = "create";
      let projection = await BinaryProjection.create(policy);
      const result = {};
      const measure = (key, fn) => { phase = key; const start = performance.now(); const value = fn(); result[key] = performance.now() - start; return value; };
      const observe = () => { linearCapacityBytes = Math.max(linearCapacityBytes, getWasmDiagnostics().memoryBytes); observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss); };
      let checkpoint;
      try {
        measure("initialApplyMs", () => projection.applyAuthorized(blocks, roles)); observe();
        reducerWork = { initial: projection.replayWork };
        measure("oneTailApplyMs", () => projection.applyAuthorized([tail], ["Admin"])); observe();
        reducerWork.tail = projection.replayWork;
        measure("duplicateApplyMs", () => projection.applyAuthorized([tail], ["Admin"])); observe();
        reducerWork.duplicate = projection.replayWork;
        measure("oneLateApplyMs", () => projection.applyAuthorized([late], ["Kiosk"])); observe();
        reducerWork.late = projection.replayWork;
        const snapshot = measure("snapshotDecodeMs", () => projection.snapshot((count + 1) * 4)); observe();
        assert.equal(snapshot.items.length, books);
        assert.equal(snapshot.items.find(i => i.id === "book_0").fields.loanId, `${kiosk}:1`);
        assert.equal(snapshot.decisions.find(d => d.eventId === `${kiosk}:1`).status, "ACCEPTED");
        assert.equal(snapshot.decisions.filter(d => d.eventId === `${kiosk}:1`).length, 1);
        assert.ok(snapshot.decisions.some(d => d.itemId === "book_0" && d.status === "REJECTED_CONFLICT"));
        checkpoint = measure("checkpointEncodeMs", () => projection.checkpoint()); checkpointBytes = checkpoint.length; observe();
        projection.close(); projection = await BinaryProjection.create(policy);
        measure("checkpointRestoreMs", () => projection.restore(checkpoint)); observe();
        reducerWork.restore = projection.replayWork;
        if (reducerWork.tail) {
          assert.equal(reducerWork.tail.commands, 1); assert.equal(reducerWork.duplicate.commands, 0);
          assert.equal(reducerWork.late.rows, 1); assert.equal(reducerWork.restore.commands, count + 2);
        }
        assert.deepEqual(projection.snapshot((count + 1) * 4), snapshot);
        if (count === 99998) {
          phase = "candidateLimitValidation";
          const overflow = encode(admin, count + 2, (count + 2) * 4, "ITEM_UPDATED", "book_0", { title: "Beyond limit" });
          assert.throws(() => projection.applyAuthorized([overflow], ["Admin"]), error => error.status === 1);
          // Failed insertion leaves the full session valid; duplicates consume no slots.
          projection.applyAuthorized([tail], ["Admin"]);
          assert.deepEqual(projection.snapshot((count + 1) * 4), snapshot);
        }
        if (iteration) times.push(result); // First full iteration is warm-up.
      } finally { checkpoint?.fill(0); projection.close(); }
    }
    process.send({ outcome: "ok", candidates: count, finalCandidates: count + 2, books,
      commandBytes: blocks.reduce((n, b) => n + b.length, 0), checkpointBytes, producerMs,
      linearCapacityBytes, observedRssBytes, reducerWork, samples: times });
  } catch (error) {
    process.send({ outcome: "error", candidates: count, phase, iteration: iterationIndex, error: { name: error.name, message: error.message, status: error.status } });
  }
} else {
  const counts = argument("sizes", "1000,10000,50000,99998").split(",").map(Number);
  assert.ok(counts.length > 0 && counts.length <= 10 && counts.every(n => Number.isInteger(n) && n >= 10 && n <= 99998));
  const results = [];
  for (const count of counts) {
    // A new process per size keeps unrelated WASM allocator high-water marks apart.
    const row = await new Promise((resolve, reject) => {
      const child = fork(self, ["--worker", `--count=${count}`, `--samples=${samples}`, `--rows=${requestedRows}`], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      let result;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Benchmark timed out at ${count} candidates`)); }, 240000);
      child.on("message", value => { result = value; });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); code === 0 && result ? resolve(result) : reject(new Error(`Benchmark worker exited ${code} without a complete result`)); });
    }).catch(error => ({ outcome: "error", candidates: count, phase: "childProcess", error: { name: error.name, message: error.message } }));
    if (row.outcome === "ok") {
      row.medians = Object.fromEntries(Object.keys(row.samples[0]).map(key => {
        const values = row.samples.map(s => s[key]).sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return [key, values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2];
      }));
    }
    results.push(row); console.log(`Measured ${count} candidates: ${row.outcome}`);
  }
  const report = { date: new Date().toISOString(), runtime: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    compiler: JSON.parse(await readFile(new URL("../dist/wasm/build-info.json", import.meta.url), "utf8")),
    scope: "Node WASM BinaryProjection including binary bridge. Trusted roles and producer-encoded decrypted commands. Excludes signatures, certificate checks, AES-GCM, OPFS, network, Worker RPC and module startup. One warm-up plus measured iterations per size; isolated process per size. Memory is observed RSS and reserved linear capacity, not live heap or an exact peak.",
    requestedRows,
    workload: "Default: up to 1,000 exclusive resources; --rows=1 selects one hot row. Historical CHECKOUT/RETURN pairs, tail edit, duplicate, earlier checkout, checkpoint and restore. Restore equality, single late winner and optional reducer work are asserted.",
    results };
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await writeFile(new URL("../artifacts/benchmark-invariants-node.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.table(results.map(r => ({ candidates: r.candidates, outcome: r.outcome,
    initial_ms: r.medians?.initialApplyMs.toFixed(2), tail_ms: r.medians?.oneTailApplyMs.toFixed(2),
    duplicate_ms: r.medians?.duplicateApplyMs.toFixed(2), late_ms: r.medians?.oneLateApplyMs.toFixed(2),
    restore_ms: r.medians?.checkpointRestoreMs.toFixed(2), linear_MiB: r.linearCapacityBytes ? (r.linearCapacityBytes / 1048576).toFixed(1) : undefined })));
  if (results.some(r => r.outcome !== "ok")) process.exitCode = 1;
}
