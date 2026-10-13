import { toBase64Url } from "./crypto-codec.js";
import type { IEvent, SyncSummary } from "./types.js";
import { compareText, canonicalEventBytes } from "./validation.js";
import { normalizeActorId } from "./crypto-codec.js";

export const MAX_PAGED_SYNC_ACTORS = 262144;
export const SYNC_FRONTIER_PAGE_ACTORS = 128;

export function normalizeSummary(value: unknown, maximumActors = 4096): SyncSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid sync summary");
  const entries = Object.entries(value);
  if (entries.length > maximumActors) throw new RangeError(`Sync summary exceeds ${maximumActors} actors`);
  const summary: Record<string, number> = Object.create(null);
  for (const [actorId, sequence] of entries.sort(([a], [b]) => compareText(a, b))) {
    normalizeActorId(actorId);
    if (typeof sequence !== "number" ||
        !Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("Invalid actor watermark");
    summary[actorId] = sequence;
  }
  return Object.freeze(summary);
}

export class EventIndex {
  private readonly contents = new Map<string, string>();
  private readonly actors = new Map<string, { watermark: number; sequences: Set<number> }>();

  async assertCompatible(events: readonly IEvent[]): Promise<void> {
    const batch = new Map<string, string>();
    for (const event of events) {
      const text = await this.fingerprint(event);
      const existing = batch.get(event.id) ?? this.contents.get(event.id);
      if (existing !== undefined && existing !== text) throw new Error(`Conflicting content for event ${event.id}`);
      batch.set(event.id, text);
    }
  }

  has(event: IEvent): boolean { return this.contents.has(event.id); }

  async record(event: IEvent): Promise<void> {
    this.contents.set(event.id, await this.fingerprint(event));
    const actor = this.actors.get(event.actorId) ?? { watermark: 0, sequences: new Set<number>() };
    actor.sequences.add(event.sequence);
    while (actor.watermark < Number.MAX_SAFE_INTEGER && actor.sequences.has(actor.watermark + 1)) actor.watermark++;
    this.actors.set(event.actorId, actor);
  }

  private readonly fingerprints = new WeakMap<IEvent, Promise<string>>();
  private fingerprint(event: IEvent): Promise<string> {
    let digest = this.fingerprints.get(event);
    if (!digest) { const { signature: _, ...unsigned } = event; digest = crypto.subtle.digest("SHA-256", canonicalEventBytes(unsigned)).then(toBase64Url); this.fingerprints.set(event, digest); }
    return digest;
  }
  export(): { id: string; digest: string }[] { return [...this.contents].map(([id, digest]) => ({ id, digest })); }
  restore(entries: readonly { id: string; digest: string }[]): void {
    if (this.contents.size) throw new Error("Index already populated");
    for (const entry of entries) {
      const at = entry.id.lastIndexOf(":"), actorId = entry.id.slice(0, at), sequence = Number(entry.id.slice(at + 1));
      normalizeActorId(actorId);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || entry.id !== `${actorId}:${sequence}` || !/^[A-Za-z0-9_-]{43}$/.test(entry.digest) || this.contents.has(entry.id)) throw new TypeError("Invalid checkpoint index");
      this.contents.set(entry.id, entry.digest);
      const actor = this.actors.get(actorId) ?? { watermark: 0, sequences: new Set<number>() };
      actor.sequences.add(sequence); this.actors.set(actorId, actor);
    }
    for (const actor of this.actors.values()) while (actor.watermark < Number.MAX_SAFE_INTEGER && actor.sequences.has(actor.watermark + 1)) actor.watermark++;
  }
  summary(): SyncSummary {
    return Object.freeze(Object.fromEntries([...this.actors.entries()]
      .sort(([a], [b]) => compareText(a, b)).map(([id, actor]) => [id, actor.watermark])));
  }
}
