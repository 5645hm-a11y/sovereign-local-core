import { LocalCoreClient, type LocalCoreClientOptions } from "./client.js";
import { P2PSync, type P2PState, type P2PSyncOptions } from "./p2p-sync.js";
import type { IdentityOpenOptions, Snapshot } from "./types.js";

export interface ProjectCredentials extends Omit<IdentityOpenOptions, "projectId"> {
  readonly databaseName?: string;
  /** Create a new root only if the local descriptor is absent. Never replaces an existing root. */
  readonly createIfMissing?: boolean;
  readonly clientOptions?: LocalCoreClientOptions;
  readonly p2p?: P2PSyncOptions;
}
export interface ProjectState {
  readonly status: "loading" | "ready" | "error" | "closed";
  readonly client: LocalCoreClient | null;
  readonly connection: P2PState;
  readonly error: Error | null;
}
const initial: ProjectState = Object.freeze({ status: "loading", client: null, connection: "offline", error: null });
// Serialize open/close transitions, including Strict Mode's effect replay and same-origin writer leases.
let transitions: Promise<void> = Promise.resolve();
const enqueue = (job: () => Promise<void>) => { transitions = transitions.then(job).catch(() => {}); };
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

/** One hook owner; share it through ProjectProvider instead of opening the same writer twice. */
export class ProjectSession {
  private refs = 0;
  private started = false;
  private disposed = false;
  private core: LocalCoreClient | null = null;
  private sync: P2PSync | null = null;
  private unsubscribers: (() => void)[] = [];
  private state: ProjectState = initial;
  private view: Snapshot | null = null;
  private readonly stateListeners = new Set<() => void>();
  private readonly viewListeners = new Set<() => void>();
  private refreshing = false;
  private dirty = false;
  constructor(readonly projectId: string, private readonly credentials: ProjectCredentials) {}
  getState = () => this.state;
  getServerState = () => initial;
  getView = () => this.view;
  subscribe = (listener: () => void) => { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); }; };
  subscribeView = (listener: () => void) => { this.viewListeners.add(listener); return () => { this.viewListeners.delete(listener); }; };
  private publish(value: ProjectState) { this.state = Object.freeze(value); for (const fn of this.stateListeners) fn(); }
  private publishView(value: Snapshot) { this.view = value; for (const fn of this.viewListeners) fn(); }
  retain(): () => void {
    if (this.disposed) { this.disposed = false; this.started = false; this.view = null; this.state = initial; }
    this.refs++;
    if (!this.started) { this.started = true; enqueue(() => this.open()); }
    return () => {
      this.refs--;
      queueMicrotask(() => { if (!this.refs) this.sync?.stop(); });
      enqueue(async () => {
        // Effect replay reacquires before this queued cleanup; actual unmount closes everything.
        if (this.refs) return;
        this.disposed = true;
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.sync?.stop(); this.sync = null;
        const client = this.core; this.core = null;
        try { await client?.close(); } finally { this.publish({ ...initial, status: "closed" }); }
      });
    };
  }
  private async open(): Promise<void> {
    if (!this.refs || this.disposed) return;
    const { databaseName = this.projectId, createIfMissing, clientOptions, p2p, ...identity } = this.credentials;
    let client: LocalCoreClient | null = null;
    try {
      client = new LocalCoreClient(clientOptions);
      this.core = client;
      const options = { ...identity, projectId: this.projectId };
      let opened;
      try { opened = await client.open(databaseName, options); }
      catch (error) {
        if (!createIfMissing || options.invitation || asError(error).name !== "ProjectNotInitializedError") throw error;
        opened = await client.createProject(databaseName, options);
      }
      if (!this.refs) return; // Queued cleanup will release this client's lease.
      this.unsubscribers.push(client.onCommit(() => this.refresh()));
      this.publishView(opened.snapshot);
      this.publish({ status: "ready", client, connection: "offline", error: null });
      if (p2p) {
        this.sync = new P2PSync(client, p2p);
        this.unsubscribers.push(client.storage.addPeer(this.sync));
        this.unsubscribers.push(this.sync.onStateChange(connection => this.publish({ ...this.state, connection })));
        this.sync.start();
      }
    } catch (error) {
      this.sync?.stop(); this.sync = null;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      await client?.close().catch(() => {}); this.core = null;
      if (this.refs) this.publish({ ...initial, status: "error", error: asError(error) });
      for (const fn of this.viewListeners) fn();
    }
  }
  private refresh(): void {
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    void (async () => {
      try {
        while (this.dirty && this.core && this.refs) {
          this.dirty = false; const view = await this.core.snapshot();
          if (this.refs && !this.disposed) this.publishView(view);
        }
      } catch (error) { if (this.refs && !this.disposed) this.publish({ ...this.state, error: asError(error) }); }
      finally { this.refreshing = false; }
    })();
  }
  requireClient(): LocalCoreClient {
    if (this.state.status !== "ready" || !this.core || !this.refs || this.disposed) throw new Error("Project is not ready");
    return this.core;
  }
}

/** Structural comparison for scalar/array/plain-record projections; customize for other values. */
export function equalQuery(a: unknown, b: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) return false;
  if (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length)) return false;
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(k => Object.hasOwn(b, k) && equalQuery((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen));
}
