import { MAX_PAGED_SYNC_ACTORS, SYNC_FRONTIER_PAGE_ACTORS, normalizeSummary } from "./event-index.js";
import { compareText } from "./validation.js";
import type { SyncSummary } from "./types.js";

export const MAX_FRONTIER_PAGE_BYTES = 32 * 1024;
export interface FrontierManifest { readonly version: 1; readonly id: string; readonly actors: number; readonly pages: number }
export interface FrontierPage { readonly id: string; readonly index: number; readonly summary: SyncSummary }

export function normalizeFrontierManifest(value: unknown): FrontierManifest {
  if (!value || typeof value !== "object") throw new TypeError("Invalid frontier manifest");
  const m = value as FrontierManifest;
  if (m.version !== 1 || typeof m.id !== "string" || !/^[a-f0-9-]{36}$/.test(m.id) ||
      !Number.isSafeInteger(m.actors) || m.actors < 0 || m.actors > MAX_PAGED_SYNC_ACTORS ||
      m.pages !== Math.max(1, Math.ceil(m.actors / SYNC_FRONTIER_PAGE_ACTORS))) {
    throw new RangeError("Invalid frontier generation/count");
  }
  return Object.freeze({ version: 1, id: m.id, actors: m.actors, pages: m.pages });
}

/** Copy once: commits during the handshake must not change its page boundaries. */
export function createFrontier(value: SyncSummary): { manifest: FrontierManifest; pages: Iterable<FrontierPage> } {
  const entries = Object.entries(normalizeSummary(value, MAX_PAGED_SYNC_ACTORS));
  const manifest = normalizeFrontierManifest({ version: 1, id: crypto.randomUUID(), actors: entries.length,
    pages: Math.max(1, Math.ceil(entries.length / SYNC_FRONTIER_PAGE_ACTORS)) });
  return { manifest, pages: { *[Symbol.iterator]() {
    for (let index = 0; index < manifest.pages; index++) {
      yield { id: manifest.id, index, summary: Object.freeze(Object.fromEntries(
        entries.slice(index * SYNC_FRONTIER_PAGE_ACTORS, (index + 1) * SYNC_FRONTIER_PAGE_ACTORS))) };
    }
  } } };
}

/** Watermarks are hints. Signatures, membership, RLS and hashes remain core checks. */
export class FrontierAccumulator {
  private next = 0;
  private previous: string | undefined;
  private readonly summary: Record<string, number> = Object.create(null);
  constructor(readonly manifest: FrontierManifest) {}
  accept(page: FrontierPage): SyncSummary | null {
    if (page.id !== this.manifest.id || page.index !== this.next || this.next >= this.manifest.pages) {
      throw new Error("Unexpected frontier generation/page order");
    }
    const entries = Object.entries(normalizeSummary(page.summary, SYNC_FRONTIER_PAGE_ACTORS));
    const expected = Math.min(SYNC_FRONTIER_PAGE_ACTORS, this.manifest.actors - this.next * SYNC_FRONTIER_PAGE_ACTORS);
    if (entries.length !== expected) throw new Error("Incomplete frontier actor range");
    for (const [actor, sequence] of entries) {
      if (this.previous !== undefined && compareText(this.previous, actor) >= 0) throw new Error("Overlapping frontier actor ranges");
      this.summary[actor] = sequence; this.previous = actor;
    }
    this.next++;
    return this.next === this.manifest.pages ? Object.freeze(this.summary) : null;
  }
}
