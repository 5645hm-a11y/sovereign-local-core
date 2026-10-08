import { BinaryReader } from "./binary-codec.js";
import { commandDictionaries } from "./binary-command.js";
import type { FieldValue, Snapshot } from "./types.js";
import type { PlainItemEvent } from "./project.js";

const ABI = 1, INPUT_MAGIC = 0x31574353, OUTPUT_MAGIC = 0x314f4353;
const MAX_BYTES = 128 * 1024 * 1024, MAX_EVENTS = 1000000;
interface Runtime {
  HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _core_abi_version(): number;
  _core_merge(pointer: number, bytes: number): number;
  _core_output_ptr(): number;
  _core_output_size(): number;
  _core_clear_output(): void;
  _core_session_create(): number;
  _core_session_destroy(handle: number): void;
  _core_session_apply(handle: number, pointer: number, bytes: number): number;
  _core_session_snapshot(handle: number): number;
  _core_session_checkpoint(handle: number): number;
  _core_session_restore(handle: number, pointer: number, bytes: number): number;
  _core_session_reset(handle: number): number;
}
let runtimePromise: Promise<Runtime> | undefined;
const diagnostics = { backend: "wasm" as const, abi: ABI, mergeCalls: 0, projectedEvents: 0, maxInputBytes: 0, memoryBytes: 0 };
export function getWasmDiagnostics() { return Object.freeze({ ...diagnostics }); }
/** One asynchronously initialized instance per Worker/JS realm. No implicit JS fallback. */
export function loadWasmRuntime(): Promise<Runtime> {
  return runtimePromise ??= (async () => {
    const url = new URL("./wasm/core_engine.mjs", import.meta.url);
    const factory = (await import(url.href) as { default: (options: { locateFile: (name: string) => string }) => Promise<Runtime> }).default;
    const runtime = await factory({ locateFile: name => new URL(name, url).href });
    if (runtime._core_abi_version() !== ABI) throw new Error("WASM ABI mismatch; rebuild native/core_engine.cpp");
    diagnostics.memoryBytes = runtime.HEAPU8.buffer.byteLength;
    return runtime;
  })();
}

interface Plan {
  actors: Map<string, number>;
  items: Map<string, number>;
  keys: Map<string, number>;
  bytes: number;
}
function dictionaryIndex(map: Map<string, number>, value: string): number {
  if (typeof value !== "string") throw new TypeError("Native projection identifier must be a string");
  let index = map.get(value);
  if (index === undefined) { index = map.size; map.set(value, index); }
  return index;
}
/** One pass over events. Dictionaries follow records, so no size/count pre-scan is needed. */
function writeInput(runtime: Runtime, events: readonly PlainItemEvent[], reserve: (bytes: number, preserve: number) => number): Plan {
  if (events.length > MAX_EVENTS) throw new RangeError("Native projection exceeds one million events");
  const plan: Plan = { actors: new Map(), items: new Map(), keys: new Map(), bytes: 0 };
  let offset = 32, pointer = 0, capacity = 0;
  let view!: DataView, units!: Uint16Array;
  const ensure = (extra: number) => {
    const required = offset + extra;
    if (required <= capacity) return;
    if (required > MAX_BYTES) throw new RangeError("Native projection exceeds 128 MiB");
    capacity = Math.min(MAX_BYTES, Math.max(required, Math.ceil(capacity * 1.5), 4096, events.length * 112 + 32));
    pointer = reserve(capacity, offset === 32 && !pointer ? 0 : offset);
    // Refresh even when reserve reuses a larger arena: this writer's view grew.
    view = new DataView(runtime.HEAPU8.buffer, pointer, capacity);
    units = new Uint16Array(runtime.HEAPU8.buffer);
  };
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const u64 = (value: number) => { u32(value >>> 0); u32(Math.floor(value / 4294967296)); };
  const string = (value: string) => {
    ensure(4 + value.length * 2); u32(value.length);
    let index = (pointer + offset) / 2;
    for (let i = 0; i < value.length; i++) units[index++] = value.charCodeAt(i);
    offset += value.length * 2;
  };
  ensure(0);
  for (const e of events) {
    if (!Number.isSafeInteger(e.lamport) || e.lamport < 1 || !Number.isSafeInteger(e.sequence) || e.sequence < 1 ||
        (e.type !== "ITEM_ADDED" && e.type !== "ITEM_UPDATED" && e.type !== "ITEM_DELETED" && e.type !== "FILE_ADDED")) throw new TypeError("Invalid native projection metadata");
    ensure(32);
    u64(e.lamport); u64(e.sequence);
    u32(dictionaryIndex(plan.actors, e.actorId)); u32(dictionaryIndex(plan.items, e.itemId));
    u32(e.type === "ITEM_ADDED" || e.type === "FILE_ADDED" ? 1 : e.type === "ITEM_UPDATED" ? 2 : 3);
    const countOffset = offset; u32(0);
    let count = 0;
    if (e.type !== "ITEM_DELETED") for (const key in e.fields) {
      if (!Object.hasOwn(e.fields, key)) throw new TypeError("Inherited native field");
      ensure(8); u32(dictionaryIndex(plan.keys, key)); count++;
      const value = e.fields[key]!;
      if (value === null) u32(0);
      else if (value === false) u32(1);
      else if (value === true) u32(2);
      else if (typeof value === "number" && Number.isFinite(value)) { u32(3); ensure(8); view.setFloat64(offset, value, true); offset += 8; }
      else if (typeof value === "string") { u32(4); string(value); }
      else throw new TypeError("Native projection fields must be finite JSON scalars");
    }
    view.setUint32(countOffset, count, true);
  }
  const dictionaryOffset = offset;
  for (const dictionary of [plan.actors, plan.items, plan.keys]) for (const text of dictionary.keys()) string(text);
  plan.bytes = offset;
  offset = 0;
  u32(INPUT_MAGIC); u32(ABI); u32(events.length); u32(plan.bytes);
  u32(plan.actors.size); u32(plan.items.size); u32(plan.keys.size); u32(dictionaryOffset);
  return plan;
}
function decodeSnapshot(runtime: Runtime, lamport: number, itemNames: readonly string[], fieldNames: readonly string[]): Snapshot {
  // Native allocation may have grown memory: acquire fresh views AFTER the call.
  const pointer = runtime._core_output_ptr(), size = runtime._core_output_size();
  if (size < 16 || size > MAX_BYTES || pointer + size > runtime.HEAPU8.byteLength) throw new Error("Invalid native output bounds");
  const view = new DataView(runtime.HEAPU8.buffer, pointer, size);
  let offset = 0;
  const take = (count: number) => { if (count > size - offset) throw new Error("Truncated native snapshot"); const at = offset; offset += count; return at; };
  const u32 = () => view.getUint32(take(4), true);
  const string = () => {
    const length = u32(), at = take(length * 2), parts: string[] = [];
    const values = new Uint16Array(runtime.HEAPU8.buffer, pointer + at, length);
    // String.fromCharCode preserves lone surrogates and BOM, unlike TextDecoder.
    if (length <= 8192) return String.fromCharCode(...values);
    for (let i = 0; i < length; i += 8192) parts.push(String.fromCharCode(...values.subarray(i, i + 8192)));
    return parts.join("");
  };
  if (u32() !== OUTPUT_MAGIC || u32() !== ABI) throw new Error("Invalid native snapshot header");
  const count = u32();
  if (u32() !== size || count > MAX_EVENTS) throw new Error("Invalid native snapshot size");
  const items: Snapshot["items"][number][] = [];
  for (let i = 0; i < count; i++) {
    const id = itemNames[u32()], count = u32(), fields: Record<string, FieldValue> = {};
    if (id === undefined) throw new Error("Invalid native item index");
    for (let f = 0; f < count; f++) {
      const key = fieldNames[u32()], tag = u32();
      if (key === undefined) throw new Error("Invalid native field index");
      let value: FieldValue;
      if (tag === 0) value = null;
      else if (tag === 1 || tag === 2) value = tag === 2;
      else if (tag === 3) value = view.getFloat64(take(8), true);
      else if (tag === 4) value = string();
      else throw new Error("Invalid native scalar tag");
      fields[key] = value; // Native validation rejects prototype-sensitive names.
    }
    items.push(Object.freeze({ id, fields: Object.freeze(fields) }));
  }
  if (offset !== size) throw new Error("Trailing native snapshot bytes");
  return Object.freeze({ schemaVersion: 1, lamport, items: Object.freeze(items) });
}

export class NativeMergeError extends Error {
  constructor(readonly status: number) { super(status === 2 ? "WASM projection allocation failed" : "Invalid WASM projection input"); this.name = "NativeMergeError"; }
}
/** Prepared buffers are synchronous leases; snapshot output is valid until the next native call. */
export interface PreparedProjection {
  readonly byteLength: number;
  inputView(): Uint8Array<ArrayBuffer>;
  runKernel(): void;
  snapshot(lamport: number): Snapshot;
  dispose(): void;
}
export class WasmProjection {
  private pointer = 0;
  private capacity = 0;
  private leased = false;
  private closed = false;
  private constructor(private readonly runtime: Runtime) {}
  static async create(): Promise<WasmProjection> { return new WasmProjection(await loadWasmRuntime()); }
  prepare(events: readonly PlainItemEvent[]): PreparedProjection {
    if (this.closed || this.leased) throw new Error("WASM projection is closed or has an active input lease");
    let plan: Plan;
    try {
      plan = writeInput(this.runtime, events, (required, preserve) => {
        if (required > this.capacity) {
          const pointer = this.runtime._malloc(required);
          if (!pointer) throw new NativeMergeError(2);
          if (this.pointer) {
            // malloc may grow memory; refresh HEAPU8 before copying an encoded prefix.
            this.runtime.HEAPU8.copyWithin(pointer, this.pointer, this.pointer + preserve);
            this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + this.capacity);
            this.runtime._free(this.pointer);
          }
          this.pointer = pointer; this.capacity = required;
        }
        return this.pointer;
      });
    } catch (error) {
      if (this.pointer) this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + this.capacity);
      throw error;
    }
    return this.lease(plan.bytes, events.length, [...plan.items.keys()], [...plan.keys.keys()]);
  }
  prepareBinary(bytes: Uint8Array): PreparedProjection {
    if (this.closed || this.leased) throw new Error("WASM projection is closed or has an active input lease");
    const names = commandDictionaries(bytes);
    if (bytes.length > this.capacity) {
      const pointer = this.runtime._malloc(bytes.length);
      if (!pointer) throw new NativeMergeError(2);
      if (this.pointer) { this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + this.capacity); this.runtime._free(this.pointer); }
      this.pointer = pointer; this.capacity = bytes.length;
    }
    this.runtime.HEAPU8.set(bytes, this.pointer);
    return this.lease(bytes.length, new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true), names.items, names.keys);
  }
  private lease(byteLength: number, eventCount: number, itemNames: readonly string[], fieldNames: readonly string[]): PreparedProjection {
    this.leased = true;
    diagnostics.maxInputBytes = Math.max(diagnostics.maxInputBytes, byteLength);
    let disposed = false, ran = false, generation = 0;
    const assertActive = () => { if (disposed || this.closed) throw new Error("Native input lease has expired"); };
    return {
      byteLength: byteLength,
      inputView: () => { assertActive(); return new Uint8Array(this.runtime.HEAPU8.buffer, this.pointer, byteLength); },
      runKernel: () => {
        assertActive(); ran = false;
        const status = this.runtime._core_merge(this.pointer, byteLength);
        diagnostics.mergeCalls++; diagnostics.projectedEvents += eventCount;
        generation = diagnostics.mergeCalls;
        diagnostics.memoryBytes = this.runtime.HEAPU8.buffer.byteLength;
        if (status !== 0) throw new NativeMergeError(status);
        ran = true;
      },
      snapshot: (lamport: number) => {
        assertActive();
        if (!ran || generation !== diagnostics.mergeCalls || !Number.isSafeInteger(lamport) || lamport < 0) throw new Error("Native snapshot unavailable, superseded, or invalid clock");
        return decodeSnapshot(this.runtime, lamport, itemNames, fieldNames);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true; this.leased = false;
        this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + byteLength);
        if (generation === diagnostics.mergeCalls) this.runtime._core_clear_output();
      },
    };
  }
  materialize(items: readonly PlainItemEvent[], lamport: number): Snapshot {
    const prepared = this.prepare(items);
    try { prepared.runKernel(); return prepared.snapshot(lamport); }
    finally { prepared.dispose(); }
  }
  close(): void {
    if (this.leased) throw new Error("Cannot close WASM projection with an active lease");
    if (!this.closed) {
      this.closed = true;
      if (this.pointer) { this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + this.capacity); this.runtime._free(this.pointer); }
      this.pointer = 0; this.capacity = 0;
    }
  }
}
/** Persistent native registers: binary deltas are copied once into a reusable WASM arena. */
export class BinaryProjection {
  private pointer = 0; private capacity = 0; private closed = false;
  private constructor(private readonly runtime: Runtime, private readonly handle: number) {}
  static async create(): Promise<BinaryProjection> {
    const runtime = await loadWasmRuntime(), handle = runtime._core_session_create();
    if (!handle) throw new NativeMergeError(2);
    return new BinaryProjection(runtime, handle);
  }
  private status(value: number): void {
    diagnostics.mergeCalls++; diagnostics.memoryBytes = this.runtime.HEAPU8.byteLength;
    if (value !== 0) throw new NativeMergeError(value);
  }
  private reserve(size: number): void {
    if (this.closed) throw new Error("Native session closed");
    if (size > MAX_BYTES) throw new RangeError("Native input exceeds 128 MiB");
    if (size > this.capacity) {
      const capacity = Math.min(MAX_BYTES, Math.max(size, Math.ceil(this.capacity * 1.5), 4096)), pointer = this.runtime._malloc(capacity);
      if (!pointer) throw new NativeMergeError(2);
      if (this.pointer) { this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + this.capacity); this.runtime._free(this.pointer); }
      this.pointer = pointer; this.capacity = capacity;
    }
    diagnostics.maxInputBytes = Math.max(diagnostics.maxInputBytes, size);
  }
  private input(bytes: Uint8Array, action: (pointer: number, size: number) => number): void {
    this.reserve(bytes.length);
    this.runtime.HEAPU8.set(bytes, this.pointer); // Web Crypto cannot decrypt into WASM-owned memory.
    try { this.status(action(this.pointer, bytes.length)); }
    finally { this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + bytes.length); this.runtime._core_clear_output(); }
  }
  apply(block: Uint8Array): void {
    this.input(block, (pointer, size) => this.runtime._core_session_apply(this.handle, pointer, size));
    diagnostics.projectedEvents += new DataView(block.buffer, block.byteOffset).getUint32(8, true);
  }
  applyAll(blocks: readonly Uint8Array[]): void {
    if (blocks.length === 1) { this.apply(blocks[0]!); return; }
    let start = 0;
    while (start < blocks.length) {
      let end = start, size = 16;
      while (end < blocks.length && end - start < MAX_EVENTS && size + 4 + blocks[end]!.length <= MAX_BYTES) { size += 4 + blocks[end]!.length; end++; }
      if (end === start) throw new RangeError("Command exceeds native batch bound");
      this.reserve(size);
      const v = new DataView(this.runtime.HEAPU8.buffer, this.pointer, size);
      v.setUint32(0, 0x31424353, true); v.setUint32(4, 1, true); v.setUint32(8, end - start, true); v.setUint32(12, size, true);
      let at = 16, count = 0;
      for (let i = start; i < end; i++) {
        const block = blocks[i]!; v.setUint32(at, block.length, true); at += 4;
        this.runtime.HEAPU8.set(block, this.pointer + at); at += block.length;
        count += new DataView(block.buffer, block.byteOffset).getUint32(8, true);
      }
      try { this.status(this.runtime._core_session_apply(this.handle, this.pointer, size)); diagnostics.projectedEvents += count; }
      finally { this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + size); this.runtime._core_clear_output(); }
      start = end;
    }
  }
  reset(): void { if (this.closed) throw new Error("Native session closed"); this.status(this.runtime._core_session_reset(this.handle)); }
  checkpoint(): Uint8Array<ArrayBuffer> {
    if (this.closed) throw new Error("Native session closed");
    this.status(this.runtime._core_session_checkpoint(this.handle));
    try { return this.runtime.HEAPU8.slice(this.runtime._core_output_ptr(), this.runtime._core_output_ptr() + this.runtime._core_output_size()); }
    finally { this.runtime._core_clear_output(); }
  }
  restore(bytes: Uint8Array): void { this.input(bytes, (p, n) => this.runtime._core_session_restore(this.handle, p, n)); }
  snapshot(lamport: number): Snapshot {
    if (this.closed || !Number.isSafeInteger(lamport) || lamport < 0) throw new Error("Invalid native snapshot request");
    this.status(this.runtime._core_session_snapshot(this.handle));
    try {
      const r = new BinaryReader(new Uint8Array(this.runtime.HEAPU8.buffer, this.runtime._core_output_ptr(), this.runtime._core_output_size()));
      if (r.u32() !== 0x31564f53 || r.u32() !== 1) throw new Error("Invalid session snapshot");
      const count = r.u32(); if (r.u32() !== r.bytes.length || count > MAX_EVENTS) throw new Error("Invalid snapshot length");
      const items: Snapshot["items"][number][] = [];
      for (let i = 0; i < count; i++) {
        const id = r.string(), n = r.u32(), fields: Record<string, FieldValue> = {};
        for (let f = 0; f < n; f++) {
          const key = r.string(), tag = r.u32();
          if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe native key");
          if (tag === 0) fields[key] = null; else if (tag === 1 || tag === 2) fields[key] = tag === 2;
          else if (tag === 3) fields[key] = r.f64(); else if (tag === 4) fields[key] = r.string(); else throw new Error("Invalid native value");
        }
        items.push(Object.freeze({ id, fields: Object.freeze(fields) }));
      }
      r.done(); return Object.freeze({ schemaVersion: 1, lamport, items: Object.freeze(items) });
    } finally { this.runtime._core_clear_output(); }
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.runtime._core_session_destroy(this.handle);
    if (this.pointer) { this.runtime.HEAPU8.fill(0, this.pointer, this.pointer + this.capacity); this.runtime._free(this.pointer); }
    this.pointer = 0; this.capacity = 0;
  }
}

