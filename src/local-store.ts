import { EventIndex } from "./event-index.js";
import type { CoreCheckpoint, CheckpointData, CheckpointJournal } from "./checkpoints.js";
import { FramedLog, inspectFrames, LogCorruptionError, type SyncFile } from "./framed-log.js";
import type { AppendResult, IEvent, ILocalStore, RecoveryReport } from "./types.js";
import { normalizeEvent } from "./validation.js";
import { normalizeActorId, normalizeProjectId } from "./crypto-codec.js";
import { requireValidEvent } from "./identity.js";

export interface StoreIdentity { actorId: string; projectId: string }

function parseRecord(value: unknown, offset: number):
  | { kind: "identity"; actorId: string; projectId: string }
  | { kind: "event"; event: IEvent } {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (record.kind === "identity" && (record.version === 1 || record.version === 2)) {
      throw new LogCorruptionError(offset, "legacy log requires explicit migration to a new encrypted database");
    }
    if (record.kind === "identity" && record.version === 3 &&
        Object.keys(record).sort().join(",") === "actorId,kind,projectId,version") {
      return { kind: "identity", actorId: normalizeActorId(record.actorId), projectId: normalizeProjectId(record.projectId) };
    }
    if (record.kind === "event" && Object.keys(record).sort().join(",") === "event,kind") {
      return { kind: "event", event: normalizeEvent(record.event) };
    }
    throw new Error();
  } catch (error) {
    if (error instanceof LogCorruptionError) throw error;
    throw new LogCorruptionError(offset, "unsupported or invalid record");
  }
}

/** The log's first flushed record binds its owner/project to an already persisted vault. */
export class LocalEventStore implements ILocalStore {
  private closed = false;
  private readonly index = new EventIndex();
  get checkpointEnabled(): boolean { return !!this.checkpoints; }

  private constructor(
    private readonly log: FramedLog,
    readonly actorId: string,
    readonly projectId: string,
    readonly recovery: RecoveryReport,
    readonly checkpoint: CoreCheckpoint | undefined,
    private readonly file: SyncFile,
    private readonly checkpoints: CheckpointJournal | undefined,
    private readonly release: () => void | Promise<void>,
  ) {
    if (checkpoint) this.index.restore(checkpoint.index);
  }

  static async open(file: SyncFile, identity: StoreIdentity, release: () => void | Promise<void> = () => {}, validateHistory?: (events: readonly IEvent[], checkpoint?: CoreCheckpoint) => Promise<unknown>, checkpoints?: CheckpointJournal): Promise<LocalEventStore> {
    const log = new FramedLog(file);
    try {
      normalizeActorId(identity.actorId); normalizeProjectId(identity.projectId);
      // Validate crypto before recovery is allowed to trim an incomplete tail.
      const checkpoint = await checkpoints?.load(file);
      const start = checkpoint?.offset ?? 0;
      const preview: IEvent[] = [];
      inspectFrames(file, (value, offset) => {
        const record = parseRecord(value, offset);
        if (record.kind === "event") preview.push(record.event);
      }, start);
      for (const event of preview) await requireValidEvent(event, identity.projectId);
      await validateHistory?.(preview, checkpoint);
      let actorId: string | undefined = checkpoint ? identity.actorId : undefined;
      const index = new EventIndex(); if (checkpoint) index.restore(checkpoint.index);
      await index.assertCompatible(preview); // Semantic equivocation is checked before tail repair.
      for (const event of preview) await index.record(event);
      const tailBytes = log.recover((value, offset) => {
        const record = parseRecord(value, offset);
        if (record.kind === "identity") {
          if (actorId !== undefined || offset !== 0) throw new LogCorruptionError(offset, "misplaced identity");
          if (record.actorId !== identity.actorId || record.projectId !== identity.projectId) throw new LogCorruptionError(offset, "vault identity or project does not match database owner");
          actorId = record.actorId;
        } else if (!actorId) throw new LogCorruptionError(offset, "missing identity");
      }, start);
      if (actorId === undefined) {
        actorId = identity.actorId;
        log.append({ kind: "identity", version: 3, actorId, projectId: identity.projectId });
      }
      const store = new LocalEventStore(log, actorId, identity.projectId,
        Object.freeze({ eventCount: index.export().length, discardedTailBytes: tailBytes }), checkpoint, file, checkpoints, release);
      for (const event of preview) await store.index.record(event);
      return store;
    } catch (error) {
      try { checkpoints?.close(); log.close(); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  async append(value: IEvent): Promise<AppendResult> {
    this.assertOpen();
    const copy = normalizeEvent(value);
    const event = await requireValidEvent(copy, this.projectId);
    this.assertOpen();
    await this.index.assertCompatible([event]);
    if (this.index.has(event)) {
      this.log.read(() => {});
      return { appended: false };
    }
    this.log.append({ kind: "event", event });
    await this.index.record(event);
    return { appended: true };
  }

  async readEvents(): Promise<readonly IEvent[]> {
    this.assertOpen();
    const events: IEvent[] = [];
    this.log.read((value, offset) => {
      const record = parseRecord(value, offset);
      if (record.kind === "event") events.push(record.event);
    });
    return Object.freeze(events);
  }

  async readRecoveryEvents(): Promise<readonly IEvent[]> {
    this.assertOpen();
    const events: IEvent[] = [];
    inspectFrames(this.file, (value, offset) => { const record = parseRecord(value, offset); if (record.kind === "event") events.push(record.event); }, this.checkpoint?.offset ?? 0);
    return events;
  }
  async saveCheckpoint(data: CheckpointData): Promise<void> {
    this.assertOpen();
    await this.checkpoints?.save(this.file, this.log.endOffset, data);
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try { this.log.close(); } finally {
        this.checkpoint?.native.fill(0);
        try { this.checkpoints?.close(); } finally { await this.release(); }
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Store is closed");
  }
}
