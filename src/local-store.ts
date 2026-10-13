import { EventIndex, normalizeSummary, MAX_PAGED_SYNC_ACTORS } from "./event-index.js";
import { LogOffsetIndex, type LogLocation } from "./log-offset-index.js";
import type { CoreCheckpoint, CheckpointData, CheckpointJournal } from "./checkpoints.js";
import { FramedLog, inspectFrames, LogCorruptionError, type SyncFile } from "./framed-log.js";
import type { AppendResult, IEvent, ILocalStore, RecoveryReport, StoredEventPage, StoredEventScan, SyncSummary } from "./types.js";
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
  private locations: LogOffsetIndex;
  private locationsComplete: boolean;
  get checkpointEnabled(): boolean { return !!this.checkpoints; }
  get endOffset(): number { this.assertOpen(); return this.log.endOffset; }

  private constructor(
    private readonly log: FramedLog,
    readonly actorId: string,
    readonly projectId: string,
    readonly recovery: RecoveryReport,
    readonly checkpoint: CoreCheckpoint | undefined,
    private readonly file: SyncFile,
    private readonly checkpoints: CheckpointJournal | undefined,
    private readonly release: () => void | Promise<void>,
    restoredLocations?: LogOffsetIndex,
  ) {
    if (checkpoint) this.index.restore(checkpoint.index);
    this.locations = restoredLocations ?? new LogOffsetIndex();
    this.locationsComplete = !checkpoint || !!checkpoint.logLocations;
  }

  static async open(file: SyncFile, identity: StoreIdentity, release: () => void | Promise<void> = () => {}, validateHistory?: (events: readonly IEvent[], checkpoint?: CoreCheckpoint) => Promise<unknown>, checkpoints?: CheckpointJournal): Promise<LocalEventStore> {
    const log = new FramedLog(file);
    try {
      normalizeActorId(identity.actorId); normalizeProjectId(identity.projectId);
      // Validate crypto before recovery is allowed to trim an incomplete tail.
      const checkpoint = await checkpoints?.load(file);
      // Address coverage must also validate before incomplete-tail repair.
      const restoredLocations = checkpoint?.logLocations ? LogOffsetIndex.decode(checkpoint.logLocations, checkpoint.index, checkpoint.offset) : undefined;
      const start = checkpoint?.offset ?? 0;
      const preview: IEvent[] = [];
      const locations: LogLocation[] = [];
      inspectFrames(file, (value, offset, nextOffset) => {
        const record = parseRecord(value, offset);
        if (record.kind === "event") { preview.push(record.event); locations.push({ id: record.event.id, offset, length: nextOffset - offset }); }
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
        Object.freeze({ eventCount: index.export().length, discardedTailBytes: tailBytes }), checkpoint, file, checkpoints, release, restoredLocations);
      for (const event of preview) await store.index.record(event);
      for (const location of locations) store.locations.add(location);
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
    const offset = this.log.endOffset;
    this.log.append({ kind: "event", event });
    await this.index.record(event);
    this.locations.add({ id: event.id, offset, length: this.log.endOffset - offset });
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

  async readEventPage(start: number, end: number): Promise<StoredEventPage> {
    this.assertOpen();
    const page = this.log.readPage(start, end), events: IEvent[] = [];
    for (const { value, offset } of page.records) {
      const record = parseRecord(value, offset);
      if (record.kind === "event") events.push(record.event);
      else if (offset !== 0 || record.actorId !== this.actorId || record.projectId !== this.projectId) throw new LogCorruptionError(offset, "cursor identity mismatch");
    }
    return { events: Object.freeze(events), nextOffset: page.nextOffset,
      scannedRecords: page.records.length, scannedBytes: page.scannedBytes };
  }

  async readRecoveryEvents(): Promise<readonly IEvent[]> {
    this.assertOpen();
    const events: IEvent[] = [];
    inspectFrames(this.file, (value, offset) => { const record = parseRecord(value, offset); if (record.kind === "event") events.push(record.event); }, this.checkpoint?.offset ?? 0);
    return events;
  }
  async openMissingEventScan(value: SyncSummary, end: number): Promise<StoredEventScan> {
    this.assertOpen();
    const summary = normalizeSummary(value, MAX_PAGED_SYNC_ACTORS);
    if (!Number.isSafeInteger(end) || end < 0 || end > this.log.endOffset) throw new RangeError("Invalid indexed scan fence");
    if (!this.locationsComplete) {
      // Old checkpoints have no addresses. Rebuild once, in bounded pages,
      // against their authenticated content index. Publish only after completion.
      const rebuilt = new LogOffsetIndex(); let at = 0;
      const committedEnd = this.log.endOffset;
      while (at < committedEnd) {
        const page = this.log.readPage(at, committedEnd), events: IEvent[] = [];
        for (const entry of page.records) {
          const record = parseRecord(entry.value, entry.offset);
          if (record.kind === "event") {
            events.push(await requireValidEvent(record.event, this.projectId));
            rebuilt.add({ id: record.event.id, offset: entry.offset, length: entry.nextOffset - entry.offset });
          } else if (entry.offset !== 0 || record.actorId !== this.actorId || record.projectId !== this.projectId) throw new LogCorruptionError(entry.offset, "indexed identity mismatch");
        }
        await this.index.assertCompatible(events);
        if (events.some(e => !this.index.has(e))) throw new LogCorruptionError(at, "indexed event absent from durable admission index");
        at = page.nextOffset;
      }
      this.locations = rebuilt; this.locationsComplete = true;
    }
    const scan = this.locations.scan(summary, end);
    return {
      readPage: async () => {
        this.assertOpen(); const page = scan.next(), events: IEvent[] = []; let scannedBytes = 0;
        for (const entry of page.entries) {
          const record = parseRecord(this.log.readRecord(entry.offset, entry.length, end), entry.offset);
          if (record.kind !== "event" || record.event.id !== entry.id) throw new LogCorruptionError(entry.offset, "indexed event identity mismatch");
          events.push(record.event); scannedBytes += entry.length;
        }
        return { events: Object.freeze(events), done: page.done, scannedRecords: events.length, scannedBytes };
      },
      close: () => scan.close(),
    };
  }
  async saveCheckpoint(data: CheckpointData): Promise<void> {
    this.assertOpen();
    await this.checkpoints?.save(this.file, this.log.endOffset, data, this.locationsComplete ? this.locations.encode(data.index) : undefined);
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
