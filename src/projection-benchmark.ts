import { encodeCommands } from "./binary-command.js";
import { projectItemsReference } from "./crdt.js";
import { getWasmDiagnostics, WasmProjection, BinaryProjection } from "./wasm-loader.js";
import type { PlainItemEvent } from "./project.js";

interface Distribution { medianMs: number; minMs: number; maxMs: number; samplesMs: number[] }
function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)]!, minMs: sorted[0]!, maxMs: sorted.at(-1)!, samplesMs: values };
}
export function benchmarkEvents(count: number, itemCount = 5000): PlainItemEvent[] {
  let seed = 0x1234abcd;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const items = Math.min(itemCount, count);
  return Array.from({ length: count }, (_, i) => {
    const actorId = `actor-${i % 16}`, itemId = `item-${i % items}`, sequence = i + 1;
    const type = i < items || i % 71 === 0 ? "ITEM_ADDED" : i % 97 === 0 ? "ITEM_DELETED" : "ITEM_UPDATED";
    return { id: `${actorId}:${sequence}`, actorId, itemId, sequence, lamport: 1 + Math.floor(i / 4), type,
      ...(type === "ITEM_DELETED" ? {} : { fields: { n: random(), title: `עדכון 🚀 ${i % 1000}`, flag: !!(i % 2), nullable: null } }) } as PlainItemEvent;
  });
}
/** Authorized/decrypted projection only: input generation, crypto, OPFS and module startup excluded. */
export async function runProjectionBenchmark(options: { sizes?: number[]; samples?: number; warmups?: number; itemCount?: number } = {}) {
  const sizes = options.sizes ?? [10000, 100000, 300000], samples = options.samples ?? 7, warmups = options.warmups ?? 2;
  const itemCount = options.itemCount ?? 5000;
  const startup = performance.now();
  const native = await WasmProjection.create(), kernel = await WasmProjection.create(), session = await BinaryProjection.create();
  const startupMs = performance.now() - startup;
  const results = [];
  try {
    for (const count of sizes) {
      const events = benchmarkEvents(count, itemCount), lamport = Math.max(1, Math.ceil(count / 4));
      const producing = performance.now();
      const encoded = encodeCommands(events), blocks = events.map(e => encodeCommands([e]));
      const producerEncodingMs = performance.now() - producing;
      const deltaCount = Math.min(1000, count), prefixCount = count - deltaCount;
      session.reset(); if (prefixCount) session.apply(encodeCommands(events.slice(0, prefixCount)));
      const checkpoint = session.checkpoint(), deltas = blocks.slice(prefixCount);
      session.applyAll(deltas);
      const expected = projectItemsReference(events, lamport);
      if (JSON.stringify(session.snapshot(lamport)) !== JSON.stringify(expected)) throw new Error("Checkpoint projection parity failed");
      session.reset(); session.applyAll(blocks);
      if (JSON.stringify(session.snapshot(lamport)) !== JSON.stringify(expected)) throw new Error("Producer-record replay parity failed");
      const actual = native.materialize(events, lamport);
      // Comparison is outside measured sections; JSON is for benchmark assertion only, never the bridge.
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Benchmark projection parity failed");
      const prepared = kernel.prepare(events);
      const ts: number[] = [], wasm: number[] = [], full: number[] = [], pack: number[] = [], decode: number[] = [];
      const binary: number[] = [], copy: number[] = [], records: number[] = [], restore: number[] = [];
      const measure = (target: number[], iteration: number, operation: () => unknown) => {
        const start = performance.now(); operation(); const duration = performance.now() - start;
        if (iteration >= warmups) target.push(duration);
      };
      try {
        for (let iteration = 0; iteration < samples + warmups; iteration++) {
          // Rotate order so the before/after comparison does not always favor the last warmed kernel.
          const operations = [
            () => measure(ts, iteration, () => projectItemsReference(events, lamport)),
            () => measure(wasm, iteration, () => prepared.runKernel()),
            () => measure(full, iteration, () => native.materialize(events, lamport)),
            () => measure(pack, iteration, () => { const batch = native.prepare(events); batch.dispose(); }),
            () => { prepared.runKernel(); measure(decode, iteration, () => prepared.snapshot(lamport)); },
            () => measure(binary, iteration, () => { const batch = native.prepareBinary(encoded); try { batch.runKernel(); return batch.snapshot(lamport); } finally { batch.dispose(); } }),
            () => measure(copy, iteration, () => { const batch = native.prepareBinary(encoded); batch.dispose(); }),
            () => { session.reset(); measure(records, iteration, () => { session.applyAll(blocks); return session.snapshot(lamport); }); },
            () => measure(restore, iteration, () => { session.restore(checkpoint); session.applyAll(deltas); return session.snapshot(lamport); }),
          ];
          for (let offset = 0; offset < operations.length; offset++) operations[(offset + iteration) % operations.length]!();
        }
        results.push({ events: count, visibleItems: expected.items.length, fieldsPerWrite: 4, actors: 16,
          inputBytes: prepared.byteLength, tsProjection: distribution(ts), wasmKernel: distribution(wasm),
          wasmWithBridge: distribution(full), packAndClear: distribution(pack), decodeSnapshot: distribution(decode),
          binaryContiguousWithBridge: distribution(binary), binaryTransferAndClear: distribution(copy),
          binaryRecordReplay: distribution(records), checkpointAndDelta: distribution(restore), producerEncodingMs,
          producerRecordBytes: blocks.reduce((total, block) => total + block.length, 0), checkpointBytes: checkpoint.length, deltaEvents: deltaCount,
          wasmLinearMemoryBytes: getWasmDiagnostics().memoryBytes });
      } finally { prepared.dispose(); checkpoint.fill(0); encoded.fill(0); for (const block of blocks) block.fill(0); }
    }
  } finally { native.close(); kernel.close(); session.close(); }
  return { timestamp: new Date().toISOString(), startupMs, samples, warmups, itemCount, results,
    scope: "Decrypted/authorized commands; excludes cryptography, OPFS I/O, RPC and event generation. Kernel includes binary parse, LWW and binary output; full includes dictionaries/packing, kernel, snapshot decode and scratch clearing.",
    memoryScope: "Shared WASM linear-memory high-water includes two legacy input arenas and one persistent session arena/state, not total application/JS heap or live native allocations.", diagnostics: getWasmDiagnostics() };
}
