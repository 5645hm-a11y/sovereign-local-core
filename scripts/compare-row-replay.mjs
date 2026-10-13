import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import factory from "../dist/wasm/core_engine.mjs";
import { encodeCommands } from "../dist/binary-command.js";
import { encodePolicies, roleCode } from "../dist/policies.js";

const baseline = process.argv.find(a => a.startsWith("--baseline="))?.slice(11) ?? "artifacts/row-replay-baseline/core_engine.wasm";
const oldBytes = await readFile(baseline), currentBytes = await readFile(new URL("../dist/wasm/core_engine.wasm", import.meta.url));
const runtimes = await Promise.all([oldBytes, currentBytes].map(wasmBinary => factory({ wasmBinary })));
const all = ["Admin", "Member", "Kiosk"], policies = { version: 1, defaultAllow: true, rules: [
  { prefix: "asset_", create: all, update: all, delete: ["Admin"], checkout: all, return: all, ownerField: null, library: true },
  { prefix: "owned_", create: all, update: all, delete: all, checkout: [], return: [], ownerField: "owner", library: false },
] };
let snapshotsCompared = 0, checkpointsCompared = 0;
function input(r, h, bytes, call) {
  const ptr = r._malloc(bytes.length); assert.ok(ptr); r.HEAPU8.set(bytes, ptr);
  try { return call(h, ptr, bytes.length); } finally { r.HEAPU8.fill(0, ptr, ptr + bytes.length); r._free(ptr); }
}
function output(r, h, call) { assert.equal(call(h), 0); return r.HEAPU8.slice(r._core_output_ptr(), r._core_output_ptr() + r._core_output_size()); }
function batch(candidates) {
  const blocks = candidates.map(c => encodeCommands([c.command])), size = 16 + blocks.reduce((n, b) => n + b.length + 8, 0);
  const bytes = new Uint8Array(size), v = new DataView(bytes.buffer); let at = 0;
  const u32 = n => { v.setUint32(at, n, true); at += 4; }; u32(0x32424353); u32(2); u32(blocks.length); u32(size);
  for (let i = 0; i < blocks.length; i++) { u32(roleCode(candidates[i].role)); u32(blocks[i].length); bytes.set(blocks[i], at); at += blocks[i].length; }
  return bytes;
}
function compare(handles) {
  const views = runtimes.map((r, i) => output(r, handles[i], r._core_session_snapshot)); assert.deepEqual(views[0], views[1]); snapshotsCompared++;
  const cps = runtimes.map((r, i) => output(r, handles[i], r._core_session_checkpoint)); assert.deepEqual(cps[0], cps[1]); checkpointsCompared++; return cps;
}
const candidate = (actorId, sequence, lamport, type, itemId, fields, role = "Admin") => ({ role,
  command: { actorId, sequence, lamport, type, itemId, id: `${actorId}:${sequence}`, ...(type === "ITEM_DELETED" ? {} : { fields }) } });
for (const seed of [3, 7, 31, 47, 101, 211, 431, 617, 811, 977]) {
  const handles = runtimes.map(r => r._core_session_create());
  try {
    runtimes.forEach((r, i) => assert.equal(input(r, handles[i], encodePolicies(policies), r._core_session_configure), 0));
    const candidates = [], checkouts = []; let seq = 0;
    for (let row = 0; row < 32; row++) {
      candidates.push(candidate("actor_root", ++seq, 1, "ITEM_ADDED", `asset_${row}`, { label: "unicode \ud800🙂", number: -0 }));
      candidates.push(candidate("actor_root", ++seq, 1, "ITEM_ADDED", `owned_${row}`, { owner: "actor_A" }));
    }
    let random = seed;
    const next = n => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) % n; };
    for (let i = 1; i <= 320; i++) {
      const row = next(32), clock = next(40) + 2, kind = next(5);
      let c;
      if (kind === 0) { c = candidate("actor_A", i, clock, "CHECKOUT", `asset_${row}`, { borrowerId: `reader_${next(8)}` }, "Member"); checkouts.push(c.command.id); }
      else if (kind === 1) c = candidate("actor_A", i, clock, "RETURN", `asset_${row}`, { checkoutId: checkouts[next(checkouts.length)] ?? "actor_A:1" }, "Member");
      else if (kind === 2) c = candidate("actor_A", i, clock, "ITEM_UPDATED", `owned_${row}`, { text: `edit_${i}` }, "Member");
      else if (kind === 3) c = candidate("actor_root", ++seq, clock, "ITEM_UPDATED", `owned_${row}`, { owner: next(2) ? "actor_A" : "actor_B" });
      else c = candidate("actor_root", ++seq, clock, next(2) ? "ITEM_ADDED" : "ITEM_DELETED", `asset_${row}`, { label: `asset_${i}` });
      candidates.push(c);
    }
    for (let i = candidates.length - 1; i > 0; i--) { const j = next(i + 1); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    for (let offset = 0; offset < candidates.length;) {
      const n = next(19) + 1, entries = candidates.slice(offset, offset + n); if (offset) entries.push(candidates[offset - 1]);
      const bytes = batch(entries); runtimes.forEach((r, i) => assert.equal(input(r, handles[i], bytes, (h, p, s) => r._core_session_apply_authorized(h, p, s, 0)), 0));
      const cps = compare(handles);
      if (offset % 5 === 0) runtimes.forEach((r, i) => assert.equal(input(r, handles[i], cps[1 - i], r._core_session_restore), 0));
      offset += n;
    }
    const before = compare(handles);
    const denied = batch([candidate("actor_root", ++seq, 100, "ITEM_ADDED", "asset_new", {}), candidate("actor_A", 321, 101, "ITEM_DELETED", "asset_0", {}, "Member")]);
    runtimes.forEach((r, i) => assert.equal(input(r, handles[i], denied, (h, p, s) => r._core_session_apply_authorized(h, p, s, 0)), 3));
    assert.deepEqual(compare(handles), before);
  } finally { runtimes.forEach((r, i) => r._core_session_destroy(handles[i])); }
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { date: new Date().toISOString(), baselineWasmSha256: hash(oldBytes), updatedWasmSha256: hash(currentBytes), seeds: 10,
  commandsPerSeed: 384, snapshotsCompared, checkpointsCompared, crossRuntimeRestores: true, outcome: "equal",
  scope: "Two separate compiled WASM instances: captured pre-row-optimization binary vs current. Trusted producer-encoded roles/commands; shuffled mixed-row prefix batches, exact duplicate retries, cross-runtime checkpoints and denied-batch atomicity. Excludes cryptography, storage and network. CI also has a reproducible full-replay checkpoint oracle without this local baseline artifact." };
await mkdir(new URL("../docs/benchmarks/", import.meta.url), { recursive: true });
await writeFile(new URL("../docs/benchmarks/row-replay-parity-node.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
