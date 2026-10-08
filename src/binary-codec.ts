/** Canonical, bounded binary values. UTF-16 preserves JS strings, including lone surrogates. */
const MAGIC = 0x31425653, LIMIT = 128 * 1024 * 1024;
export class BinaryWriter {
  bytes = new Uint8Array(256); offset = 0;
  reserve(count: number): void {
    const size = this.offset + count;
    if (!Number.isSafeInteger(size) || size > LIMIT) throw new RangeError("Binary value exceeds 128 MiB");
    if (size > this.bytes.length) { const next = new Uint8Array(Math.max(size, Math.min(LIMIT, this.bytes.length * 2))); next.set(this.bytes.subarray(0, this.offset)); this.bytes = next; }
  }
  u32(value: number): void { this.reserve(4); new DataView(this.bytes.buffer).setUint32(this.offset, value, true); this.offset += 4; }
  u64(value: number): void { this.u32(value >>> 0); this.u32(Math.floor(value / 4294967296)); }
  f64(value: number): void { this.reserve(8); new DataView(this.bytes.buffer).setFloat64(this.offset, value, true); this.offset += 8; }
  string(value: string): void { this.u32(value.length); this.reserve(value.length * 2); const v = new DataView(this.bytes.buffer); for (let i = 0; i < value.length; i++) v.setUint16(this.offset + i * 2, value.charCodeAt(i), true); this.offset += value.length * 2; }
  raw(value: Uint8Array): void { this.reserve(value.length); this.bytes.set(value, this.offset); this.offset += value.length; }
  finish(): Uint8Array<ArrayBuffer> { return this.bytes.slice(0, this.offset); }
}
export class BinaryReader {
  offset = 0; readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { if (bytes.length > LIMIT) throw new RangeError("Binary input too large"); this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  take(count: number): number { if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.offset) throw new TypeError("Truncated binary input"); const at = this.offset; this.offset += count; return at; }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  u64(): number { const low = this.u32(), value = low + this.u32() * 4294967296; if (!Number.isSafeInteger(value)) throw new TypeError("Unsafe binary clock"); return value; }
  f64(): number { const n = this.view.getFloat64(this.take(8), true); if (!Number.isFinite(n)) throw new TypeError("Non-finite binary number"); return n; }
  string(): string { const length = this.u32(), at = this.take(length * 2), parts: string[] = []; for (let i = 0; i < length; i += 8192) { const n = Math.min(8192, length - i), units = new Array<number>(n); for (let j = 0; j < n; j++) units[j] = this.view.getUint16(at + (i + j) * 2, true); parts.push(String.fromCharCode(...units)); } return parts.join(""); }
  done(): void { if (this.offset !== this.bytes.length) throw new TypeError("Trailing binary input"); }
}
export function encodeBinary(value: unknown): Uint8Array<ArrayBuffer> {
  const w = new BinaryWriter(); w.u32(MAGIC);
  const write = (v: unknown, depth: number): void => {
    if (depth > 32) throw new TypeError("Binary nesting exceeds 32");
    if (v === null) w.u32(0);
    else if (v === false || v === true) w.u32(v ? 2 : 1);
    else if (typeof v === "number" && Number.isFinite(v)) { w.u32(3); w.f64(v); }
    else if (typeof v === "string") { w.u32(4); w.string(v); }
    else if (v instanceof Uint8Array) { w.u32(7); w.u32(v.length); w.raw(v); }
    else if (Array.isArray(v)) { w.u32(5); w.u32(v.length); for (const entry of v) write(entry, depth + 1); }
    else if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      const keys = Object.keys(v).sort(); w.u32(6); w.u32(keys.length);
      for (const key of keys) { w.string(key); write((v as Record<string, unknown>)[key], depth + 1); }
    } else throw new TypeError("Unsupported binary value");
  };
  write(value, 0); return w.finish();
}
export function decodeBinary(bytes: Uint8Array): unknown {
  const r = new BinaryReader(bytes); if (r.u32() !== MAGIC) throw new TypeError("Unsupported binary format");
  let nodes = 0;
  const read = (depth: number): unknown => {
    if (depth > 32 || ++nodes > 4000000) throw new TypeError("Binary nesting/count limit");
    const tag = r.u32();
    if (tag === 0) return null; if (tag === 1 || tag === 2) return tag === 2;
    if (tag === 3) return r.f64(); if (tag === 4) return r.string();
    const count = r.u32(); if (count > r.bytes.length - r.offset) throw new TypeError("Invalid binary count");
    if (tag === 7) { const at = r.take(count); return bytes.slice(at, at + count); }
    if (tag === 5) return Array.from({ length: count }, () => read(depth + 1));
    if (tag === 6) { const obj: Record<string, unknown> = Object.create(null); let previous: string | undefined; for (let i = 0; i < count; i++) { const key = r.string(); if (previous !== undefined && key <= previous) throw new TypeError("Noncanonical binary keys"); previous = key; Object.defineProperty(obj, key, { value: read(depth + 1), enumerable: true, writable: true, configurable: true }); } return obj; }
    throw new TypeError("Unknown binary tag");
  };
  const value = read(0); r.done(); return value;
}
