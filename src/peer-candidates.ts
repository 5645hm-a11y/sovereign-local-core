/** Bounded, authenticated presence hints. Hints never authorize data or allocate RTC resources. */
export class PeerCandidates {
  private readonly entries = new Map<string, { actor: string; seenAt: number }>();
  private cursor = "";
  constructor(readonly capacity: number, readonly ttlMs: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("Invalid candidate bounds");
  }
  get size(): number { return this.entries.size; }
  observe(id: string, actor: string, now: number, protectedIds: ReadonlySet<string>): void {
    this.prune(now, protectedIds);
    const old = this.entries.get(id);
    if (old && old.actor !== actor) return; // An instance ID cannot change signing identity.
    for (const [otherId, other] of this.entries) {
      if (other.actor !== actor || otherId === id) continue;
      if (protectedIds.has(otherId)) return; // A second tab cannot displace a healthy edge.
      this.entries.delete(otherId);
    }
    if (!old && this.entries.size >= this.capacity) {
      let victim: string | null = null, oldest = Infinity;
      for (const [key, value] of this.entries) if (!protectedIds.has(key) && value.seenAt < oldest) { victim = key; oldest = value.seenAt; }
      if (victim === null) return;
      this.entries.delete(victim);
    }
    this.entries.set(id, { actor, seenAt: now });
  }
  prune(now: number, protectedIds: ReadonlySet<string>): void {
    for (const [id, value] of this.entries) if (now - value.seenAt >= this.ttlMs && !protectedIds.has(id)) this.entries.delete(id);
  }
  /** Round-robin exploration of fresh, eligible candidates; no unbounded retry queue. */
  next(now: number, eligible: (id: string, actor: string) => boolean): { id: string; actor: string } | null {
    const keys = [...this.entries.keys()].sort();
    const ordered = [...keys.filter(id => id > this.cursor), ...keys.filter(id => id <= this.cursor)];
    for (const id of ordered) {
      const value = this.entries.get(id)!;
      if (now - value.seenAt >= this.ttlMs || !eligible(id, value.actor)) continue;
      this.cursor = id; return { id, actor: value.actor };
    }
    return null;
  }
  clear(): void { this.entries.clear(); this.cursor = ""; }
  /** A failed instance must advertise afresh before another connection attempt. */
  forget(id: string): void { this.entries.delete(id); }
}
