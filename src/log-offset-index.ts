import { normalizeActorId } from "./crypto-codec.js";
import { MAX_RECORD_BYTES, LOG_PAGE_BYTES, LOG_PAGE_RECORDS } from "./framed-log.js";
import type { SyncSummary } from "./types.js";

export interface LogLocation { readonly id: string; readonly offset: number; readonly length: number }
export interface LogLocations { readonly version: 1; readonly entries: readonly LogLocation[] }
interface ActorLocations { entries: LogLocation[]; sorted: boolean }
const sequence = (entry: LogLocation): number => Number(entry.id.slice(entry.id.lastIndexOf(":") + 1));
function actor(entry: LogLocation): string {
  const at = entry.id.lastIndexOf(":"), id = normalizeActorId(entry.id.slice(0, at)), seq = sequence(entry);
  if (!Number.isSafeInteger(seq) || seq < 1 || entry.id !== `${id}:${seq}`) throw new TypeError("Invalid log location identity");
  return id;
}
function upperBound(entries: readonly LogLocation[], known: number): number {
  let lo = 0, hi = entries.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (sequence(entries[mid]!) <= known) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Derived addresses only. Admission/content proofs remain in the core's EventIndex. */
export class LogOffsetIndex {
  private readonly byId = new Map<string, LogLocation>();
  private readonly byActor = new Map<string, ActorLocations>();
  add(entry: LogLocation): void {
    const id = actor(entry);
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 16 || !Number.isSafeInteger(entry.length) || entry.length < 17 || entry.length > MAX_RECORD_BYTES + 16 || !Number.isSafeInteger(entry.offset + entry.length)) throw new TypeError("Invalid log location range");
    if (this.byId.has(entry.id)) return;
    const copy = Object.freeze({ id: entry.id, offset: entry.offset, length: entry.length });
    const rows = this.byActor.get(id) ?? { entries: [], sorted: true };
    if (rows.entries.length && sequence(rows.entries[rows.entries.length - 1]!) >= sequence(copy)) rows.sorted = false;
    rows.entries.push(copy); this.byActor.set(id, rows); this.byId.set(copy.id, copy);
  }
  export(): LogLocations { return { version: 1, entries: [...this.byId.values()].sort((a, b) => a.offset - b.offset) }; }
  /** LIX1: count + (checkpoint-ID ordinal:u32, offset:u64, length:u32). */
  encode(ids: readonly { id: string }[]): Uint8Array<ArrayBuffer> {
    if (ids.length !== this.byId.size) throw new TypeError("Incomplete checkpoint location coverage");
    const ordinals = new Map(ids.map((e, i) => [e.id, i]));
    if (ordinals.size !== ids.length) throw new TypeError("Duplicate checkpoint identities");
    const bytes = new Uint8Array(8 + ids.length * 16), view = new DataView(bytes.buffer);
    view.setUint32(0, 0x3158494c, true); view.setUint32(4, ids.length, true);
    let at = 8;
    for (const entry of this.export().entries) {
      const ordinal = ordinals.get(entry.id); if (ordinal === undefined) throw new TypeError("Unexpected checkpoint location identity");
      view.setUint32(at, ordinal, true); view.setUint32(at + 4, entry.offset >>> 0, true);
      view.setUint32(at + 8, Math.floor(entry.offset / 4294967296), true); view.setUint32(at + 12, entry.length, true); at += 16;
    }
    return bytes;
  }
  static decode(bytes: Uint8Array<ArrayBuffer>, ids: readonly { id: string }[], end: number): LogOffsetIndex {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || !Number.isSafeInteger(end) || end < 16) throw new TypeError("Invalid checkpoint log locations");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(4, true);
    if (view.getUint32(0, true) !== 0x3158494c || count !== ids.length || bytes.length !== 8 + count * 16) throw new TypeError("Invalid checkpoint log locations");
    const seen = new Uint8Array(count), result = new LogOffsetIndex(); let previousEnd = 16;
    for (let i = 0, at = 8; i < count; i++, at += 16) {
      const ordinal = view.getUint32(at, true), offset = view.getUint32(at + 4, true) + view.getUint32(at + 8, true) * 4294967296, length = view.getUint32(at + 12, true);
      if (ordinal >= count || seen[ordinal] || offset < previousEnd || offset + length > end) throw new TypeError("Incomplete or overlapping checkpoint log locations");
      seen[ordinal] = 1; result.add({ id: ids[ordinal]!.id, offset, length }); previousEnd = offset + length;
    }
    // IDs are validated independently too; duplicate IDs cannot shrink coverage.
    if (result.byId.size !== count) throw new TypeError("Duplicate checkpoint location identity");
    return result;
  }
  scan(summary: SyncSummary, end: number): LocationScan { return new LocationScan(this, [...this.byActor.keys()].sort(), summary, end); }
  rows(actorId: string): readonly LogLocation[] {
    const rows = this.byActor.get(actorId)!;
    if (!rows.sorted) { rows.entries.sort((a, b) => sequence(a) - sequence(b)); rows.sorted = true; }
    return rows.entries;
  }
}

/** Re-seek after each page so late inserts cannot move an array-position cursor. */
export class LocationScan {
  private actorAt = 0;
  private last = 0;
  private closed = false;
  constructor(private readonly index: LogOffsetIndex, private readonly actors: readonly string[], private readonly summary: SyncSummary, private readonly end: number) {}
  next(): { entries: readonly LogLocation[]; done: boolean } {
    if (this.closed) throw new Error("Location scan closed");
    const selected: LogLocation[] = []; let bytes = 0;
    while (this.actorAt < this.actors.length) {
      const actorId = this.actors[this.actorAt]!, rows = this.index.rows(actorId);
      let at = upperBound(rows, Math.max(this.last, this.summary[actorId] ?? 0));
      while (at < rows.length) {
        const entry = rows[at++]!;
        if (entry.offset + entry.length > this.end) { this.last = sequence(entry); continue; }
        if (selected.length && bytes + entry.length > LOG_PAGE_BYTES) return { entries: selected, done: false };
        selected.push(entry); bytes += entry.length; this.last = sequence(entry);
        if (selected.length === LOG_PAGE_RECORDS || bytes >= LOG_PAGE_BYTES) return { entries: selected, done: false };
      }
      this.actorAt++; this.last = 0;
    }
    this.closed = true; return { entries: selected, done: true };
  }
  close(): void { this.closed = true; }
}
