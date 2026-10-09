import { BinaryWriter, BinaryReader } from "./binary-codec.js";
import type { PlainItemEvent } from "./project.js";
import type { FieldValue } from "./types.js";
export const COMMAND_MAGIC = 0x31574353;
export function commandCode(type: PlainItemEvent["type"]): number {
  return type === "ITEM_ADDED" || type === "FILE_ADDED" ? 1 : type === "ITEM_UPDATED" ? 2 : type === "ITEM_DELETED" ? 3 : type === "CHECKOUT" ? 4 : 5;
}
/** Producer-side ABI 1 encoding; this work is paid once, before encryption, never during replay. */
export function encodeCommands(events: readonly PlainItemEvent[]): Uint8Array<ArrayBuffer> {
  const w = new BinaryWriter(); for (let i = 0; i < 8; i++) w.u32(0);
  const actors = new Map<string, number>(), items = new Map<string, number>(), keys = new Map<string, number>();
  const index = (map: Map<string, number>, key: string) => { let n = map.get(key); if (n === undefined) { n = map.size; map.set(key, n); } return n; };
  for (const e of events) {
    w.u64(e.lamport); w.u64(e.sequence); w.u32(index(actors, e.actorId)); w.u32(index(items, e.itemId));
    w.u32(commandCode(e.type));
    const fields = e.type === "ITEM_DELETED" ? [] : Object.entries(e.fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    w.u32(fields.length);
    for (const [key, v] of fields) {
      w.u32(index(keys, key));
      if (v === null) w.u32(0); else if (v === false || v === true) w.u32(v ? 2 : 1);
      else if (typeof v === "number" && Number.isFinite(v)) { w.u32(3); w.f64(v); }
      else if (typeof v === "string") { w.u32(4); w.string(v); }
      else throw new TypeError("Non-scalar binary field");
    }
  }
  const at = w.offset;
  for (const map of [actors, items, keys]) for (const text of map.keys()) w.string(text);
  const bytes = w.finish(), header = new DataView(bytes.buffer);
  [COMMAND_MAGIC, events.some(e => e.type === "CHECKOUT" || e.type === "RETURN") ? 2 : 1, events.length, bytes.length, actors.size, items.size, keys.size, at].forEach((v, i) => header.setUint32(i * 4, v, true));
  return bytes;
}
export function commandDictionaries(bytes: Uint8Array): { items: string[]; keys: string[] } {
  const r = new BinaryReader(bytes);
  if (r.u32() !== COMMAND_MAGIC || ![1, 2].includes(r.u32())) throw new TypeError("Unsupported command ABI");
  const events = r.u32(); if (events > 1000000 || r.u32() !== bytes.length) throw new TypeError("Invalid command length");
  const a = r.u32(), i = r.u32(), k = r.u32(), at = r.u32();
  if (at < 32 || at > bytes.length || a + i + k > (bytes.length - at) / 4) throw new TypeError("Invalid command dictionary");
  r.offset = at; for (let n = 0; n < a; n++) r.string();
  const items = Array.from({ length: i }, () => r.string()), keys = Array.from({ length: k }, () => r.string()); r.done(); return { items, keys };
}
/** Authenticate redundant native metadata against the signed/AAD envelope, without decoding fields. */
export function requireCommandBinding(bytes: Uint8Array, expected: Pick<PlainItemEvent, "actorId" | "sequence" | "lamport" | "itemId" | "type">): void {
  const r = new BinaryReader(bytes);
  if (r.u32() !== COMMAND_MAGIC || r.u32() !== (expected.type === "CHECKOUT" || expected.type === "RETURN" ? 2 : 1) || r.u32() !== 1 || r.u32() !== bytes.length || r.u32() !== 1 || r.u32() !== 1) throw new TypeError("Expected one bound native command");
  const keys = r.u32(), at = r.u32(); if (at < 64 || at > bytes.length || keys > (bytes.length - at) / 4) throw new TypeError("Invalid command dictionary");
  if (r.u64() !== expected.lamport || r.u64() !== expected.sequence || r.u32() !== 0 || r.u32() !== 0 ||
      r.u32() !== commandCode(expected.type)) throw new TypeError("Encrypted command metadata mismatch");
  r.offset = at; if (r.string() !== expected.actorId || r.string() !== expected.itemId) throw new TypeError("Encrypted command identity mismatch");
}
/** Compatibility/reference decoder, deliberately absent from the production replay path. */
export function decodeCommandFields(bytes: Uint8Array): Record<string, FieldValue> {
  const { keys } = commandDictionaries(bytes), r = new BinaryReader(bytes); r.offset = 60;
  const count = r.u32(), fields: Record<string, FieldValue> = Object.create(null);
  if (count > keys.length) throw new TypeError("Invalid command field count");
  for (let i = 0; i < count; i++) {
    const key = keys[r.u32()], tag = r.u32();
    if (!key || Object.hasOwn(fields, key) || ["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError("Invalid binary field key");
    if (tag === 0) fields[key] = null; else if (tag === 1 || tag === 2) fields[key] = tag === 2;
    else if (tag === 3) fields[key] = r.f64(); else if (tag === 4) fields[key] = r.string(); else throw new TypeError("Invalid field tag");
  }
  if (r.offset !== r.view.getUint32(28, true)) throw new TypeError("Trailing command records"); return fields;
}
