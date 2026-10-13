import { normalizeQueryOptions, type QueryOptions, type QueryPage, type QueryCursorHandle } from "./query.js";
import { isDataType, type CommitNotification } from "./types.js";

export interface QueryClient {
  openQueryCursor(options: QueryOptions): Promise<QueryCursorHandle>;
  readQueryCursor(id: string): Promise<QueryPage>;
  closeQueryCursor(id: string): Promise<void>;
}
export interface QuerySource {
  getState(): { status: string; client: QueryClient | null; error: Error | null };
  subscribe(listener: () => void): () => void;
  subscribeCommits(listener: (notification: CommitNotification) => void): () => void;
}
export interface PagedQueryState {
  readonly page: QueryPage | null;
  /** Zero-based physical page. Empty non-final pages still advance this index. */
  readonly pageIndex: number;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly canNext: boolean;
}
const waiting: PagedQueryState = Object.freeze({ page: null, pageIndex: 0, loading: true, error: null, canNext: false });
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

/** One owned page and one cursor per subscribed query. No IO happens during render. */
export class PagedQueryStore {
  private readonly options: Required<QueryOptions>;
  private state = waiting;
  private readonly listeners = new Set<() => void>();
  private off: (() => void)[] = [];
  private client: QueryClient | null = null;
  private cursor: { client: QueryClient; id: string } | null = null;
  private generation = 0;
  private flight: Promise<void> | null = null;
  private requested: "first" | "next" | null = null;
  private staleCursor = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly source: QuerySource, options: QueryOptions, private readonly refreshDelayMs = 25) {
    this.options = normalizeQueryOptions(options);
    if (!Number.isInteger(refreshDelayMs) || refreshDelayMs < 0 || refreshDelayMs > 1000) throw new RangeError("Query refresh delay must be 0–1000 ms");
  }
  getSnapshot = () => this.state;
  getServerSnapshot = () => waiting;
  subscribe = (listener: () => void): (() => void) => {
    const first = this.listeners.size === 0; this.listeners.add(listener);
    if (first) {
      this.off = [this.source.subscribe(() => this.bind()), this.source.subscribeCommits(n => this.committed(n))];
      this.bind();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.generation++; this.requested = null; this.clearTimer(); this.releaseCursor(); this.client = null;
        for (const stop of this.off.splice(0)) stop();
        this.state = waiting;
      }
    };
  };
  refresh = (): void => { if (this.listeners.size && this.client) this.requestFirst(); };
  next = (): void => {
    if (!this.listeners.size || !this.client || this.flight || this.requested || !this.state.canNext) return;
    if (this.staleCursor || !this.cursor) this.requestFirst();
    else { this.requested = "next"; this.pump(); }
  };
  private publish(value: PagedQueryState): void {
    this.state = Object.freeze(value); for (const listener of this.listeners) listener();
  }
  private bind(): void {
    const value = this.source.getState(), client = value.status === "ready" ? value.client : null;
    if (client === this.client) {
      if (!client) {
        const loading = value.status === "loading", error = value.status === "error" ? value.error : null;
        if (this.state.page || this.state.loading !== loading || this.state.error !== error) this.publish({ ...waiting, loading, error });
      }
      return;
    }
    this.generation++; this.clearTimer(); this.releaseCursor(); this.requested = null; this.client = client;
    // Never retain another project's rows during client switches or failed opens.
    this.publish({ ...waiting, loading: value.status === "loading" || !!client, error: value.status === "error" ? value.error : null });
    if (client) this.requestFirst();
  }
  private committed(notification: CommitNotification): void {
    if (!this.client || !this.listeners.size) return;
    this.staleCursor = true; // Every durable commit changes the engine's cursor revision.
    const event = notification.event;
    if (this.options.kind === "items" && isDataType(event.type) && "itemId" in event && !event.itemId.startsWith(this.options.prefix)) return;
    this.requestFirst();
  }
  private requestFirst(): void {
    this.generation++; this.requested = "first"; this.releaseCursor();
    // Fixed first-dirty deadline coalesces bursts without indefinitely postponing reads.
    if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.refreshDelayMs);
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private releaseCursor(): void {
    const cursor = this.cursor; this.cursor = null;
    if (cursor) void cursor.client.closeQueryCursor(cursor.id).catch(() => {});
  }
  private pump(): void {
    if (this.flight || !this.requested || !this.client || !this.listeners.size || this.timer !== null) return;
    const mode = this.requested, token = this.generation, client = this.client; this.requested = null;
    this.publish({ ...this.state, loading: true, error: null, canNext: false });
    this.flight = this.fetch(client, mode, token).finally(() => {
      this.flight = null;
      if (this.requested && this.listeners.size && this.timer === null) this.pump();
    });
  }
  private current(client: QueryClient, token: number): boolean { return !!this.listeners.size && client === this.client && token === this.generation; }
  private async fetch(client: QueryClient, mode: "first" | "next", token: number): Promise<void> {
    // At most one automatic restart. Sustained invalidation surfaces an error instead of spinning.
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: { client: QueryClient; id: string } | null = null;
      try {
        if (mode === "first") {
          const opened = await client.openQueryCursor(this.options); handle = { client, id: opened.id };
          if (!this.current(client, token)) { void client.closeQueryCursor(handle.id).catch(() => {}); return; }
          this.cursor = handle; this.staleCursor = false;
        } else handle = this.cursor;
        if (!handle) throw new Error("No active query cursor");
        const page = await client.readQueryCursor(handle.id);
        if (!this.current(client, token)) {
          void client.closeQueryCursor(handle.id).catch(() => {}); return;
        }
        if (page.done) this.releaseCursor();
        // Replace, never accumulate pages. Immutable owned values survive cursor cleanup.
        const owned = Object.freeze({ ...page,
          items: Object.freeze(page.items.map(i => Object.freeze({ ...i, fields: Object.freeze({ ...i.fields }) }))),
          decisions: Object.freeze(page.decisions.map(d => Object.freeze({ ...d }))) });
        this.publish({ page: owned, pageIndex: mode === "first" ? 0 : this.state.pageIndex + 1, loading: false, error: null, canNext: !page.done });
        return;
      } catch (value) {
        if (handle) void client.closeQueryCursor(handle.id).catch(() => {});
        if (this.cursor === handle) this.cursor = null;
        if (!this.current(client, token)) return;
        const error = asError(value);
        // Classes can be bundled separately in core/react; use the RPC-preserved name.
        if (attempt === 0 && (error.name === "QueryCursorInvalidatedError" || /Unknown, completed or expired query cursor/.test(error.message))) { mode = "first"; continue; }
        this.publish({ ...this.state, loading: false, error, canNext: false }); return;
      }
    }
  }
}
