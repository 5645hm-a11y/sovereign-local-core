import type { FieldValue, ICRDTMerge, IEvent, Snapshot } from "./types.js";
import { compareText, eventText, normalizeEvent } from "./validation.js";
import { ProjectContext, type PlainItemEvent } from "./project.js";
import { BinaryProjection } from "./wasm-loader.js";

interface Stamp { lamport: number; actorId: string; sequence: number }
interface Register<T> { stamp: Stamp; value: T }
interface ItemState { existence?: Register<boolean>; fields: Map<string, Register<FieldValue>> }
function compareStamp(a: Stamp, b: Stamp): number { return a.lamport - b.lamport || compareText(a.actorId, b.actorId) || a.sequence - b.sequence; }

/** Pure projection of already authorized/decrypted commands; never accepts wire events. */
export function projectItemsReference(events: readonly PlainItemEvent[], lamport: number): Snapshot {
  const items = new Map<string, ItemState>();
  for (const event of events) {
    if (event.type === "CHECKOUT" || event.type === "RETURN") throw new Error("Business operations require the policy reducer");
    const stamp = { lamport: event.lamport, actorId: event.actorId, sequence: event.sequence };
    const item = items.get(event.itemId) ?? { fields: new Map<string, Register<FieldValue>>() };
    if (event.type !== "ITEM_UPDATED" && (!item.existence || compareStamp(stamp, item.existence.stamp) > 0)) item.existence = { stamp, value: event.type !== "ITEM_DELETED" };
    if (event.type !== "ITEM_DELETED") for (const [key, value] of Object.entries(event.fields)) {
      const current = item.fields.get(key);
      if (!current || compareStamp(stamp, current.stamp) > 0) item.fields.set(key, { stamp, value });
    }
    items.set(event.itemId, item);
  }
  return Object.freeze({ schemaVersion: 1, lamport, items: Object.freeze([...items.entries()]
    .filter(([, item]) => item.existence?.value === true).sort(([a], [b]) => compareText(a, b))
    .map(([id, item]) => Object.freeze({ id, fields: Object.freeze(Object.fromEntries([...item.fields.entries()].sort(([a], [b]) => compareText(a, b)).map(([key, register]) => [key, register.value]))) }))) });
}
export class EventMaterializer {
  private events: IEvent[] = [];
  private view: Snapshot = projectItemsReference([], 0);
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly project: ProjectContext) {}
  apply(value: IEvent): Promise<void> {
    const event = normalizeEvent(value);
    const operation = this.queue.then(async () => {
      const previous = this.events.find(e => e.id === event.id);
      if (previous && eventText(previous) !== eventText(event)) throw new Error(`Conflicting content for event ${event.id}`);
      const events = previous ? this.events : [...this.events, event];
      if (previous) await this.project.verifyEvent(event);
      const state = await this.project.evaluateBinary(events);
      if (!state.eligible.has(event.id)) throw new Error("Event permission revoked");
      const native = await BinaryProjection.create(this.project.descriptor.policies);
      try { native.applyAuthorized(state.blocks, state.roles); this.view = native.snapshot(events.reduce((clock, e) => Math.max(clock, e.lamport), this.project.certificate.issuedLamport)); }
      finally { for (const block of state.blocks) block.fill(0); native.close(); }
      this.events = events;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  snapshot(): Snapshot { return this.view; }
}
export class LWWMerge implements ICRDTMerge {
  constructor(private readonly project: ProjectContext) {}
  async materialize(input: Iterable<IEvent>): Promise<Snapshot> {
    const events = [...input].map(normalizeEvent), seen = new Map<string, IEvent>();
    for (const e of events) {
      const previous = seen.get(e.id);
      if (previous && eventText(previous) !== eventText(e)) throw new Error(`Conflicting content for event ${e.id}`);
      seen.set(e.id, e);
    }
    const state = await this.project.evaluateBinary([...seen.values()]);
    // Verify duplicate signatures too, without duplicating governance operations.
    if (seen.size !== events.length) for (const event of events) await this.project.verifyEvent(event);
    const native = await BinaryProjection.create(this.project.descriptor.policies);
    try { native.applyAuthorized(state.blocks, state.roles); return native.snapshot(events.reduce((clock, e) => Math.max(clock, e.lamport), this.project.certificate.issuedLamport)); }
    finally { for (const block of state.blocks) block.fill(0); native.close(); }
  }
}
