import type { CommitNotification, IdentityOpenOptions, IEvent, IngestResult, ISyncCore, ItemCommand, ProjectInvitation, ProjectDescriptor, Certificate, Role, RecoveryReport, Snapshot, SyncSummary } from "./types.js";
import { normalizeEvent } from "./validation.js";
import { P2PStorage } from "./storage-client.js";
import type { FileManifest, ChunkRequest, UploadOptions } from "./storage-format.js";
import { createCoreWorker, type LocalCoreClientOptions } from "./worker-factory.js";
export type { LocalCoreClientOptions } from "./worker-factory.js";

export interface OpenResult { actorId: string; projectId: string; recovery: RecoveryReport; snapshot: Snapshot }
interface Reply { id: number; ok: boolean; result?: unknown; error?: { name: string; message: string } }
interface ProgressReply { kind: "progress"; id: number; progress: import("./storage-format.js").StorageProgress }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: UploadOptions["onProgress"] }

/** Browser-facing API. Files and CRDT state live exclusively in its Dedicated Worker. */
export class LocalCoreClient implements ISyncCore {
  readonly storage = new P2PStorage(this);
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private counter = 0;
  private stopped = false;
  private readonly listeners = new Set<(notification: CommitNotification) => void>();

  constructor(options: LocalCoreClientOptions = {}) {
    this.worker = createCoreWorker(options);
    this.worker.onmessage = (message: MessageEvent<Reply | ProgressReply | (CommitNotification & { kind: "commit" })>) => {
      const reply = message.data;
      if ("kind" in reply && reply.kind === "progress" && "id" in reply) {
        try { this.pending.get(reply.id)?.progress?.(reply.progress); } catch { /* Isolate observers. */ }
        return;
      }
      if ("kind" in reply && reply.kind === "commit") {
        const notification = Object.freeze({ source: reply.source, event: normalizeEvent(reply.event) });
        for (const listener of this.listeners) {
          try { listener(notification); } catch { /* Isolate observers. */ }
        }
        return;
      }
      if (!("id" in reply)) return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.result);
      else {
        const error = new Error(reply.error?.message ?? "Worker operation failed");
        error.name = reply.error?.name ?? "Error";
        pending.reject(error);
      }
    };
    this.worker.onerror = (event) => this.terminate(new Error(event.message || "Worker failed"));
    this.worker.onmessageerror = () => this.terminate(new Error("Worker message could not be decoded"));
  }

  open(databaseName: string, options: IdentityOpenOptions): Promise<OpenResult> { return this.call("open", { databaseName, options }); }
  createProject(databaseName: string, options: IdentityOpenOptions): Promise<OpenResult> { return this.call("createProject", { databaseName, options }); }
  identify(options: Omit<IdentityOpenOptions, "projectId" | "invitation">): Promise<{ actorId: string }> { return this.call("identify", { options }); }
  inviteMember(actorId: string, role: Role = "Member"): Promise<{ invitation: ProjectInvitation; event: IEvent; snapshot: Snapshot }> { return this.call("inviteMember", { actorId, role }); }
  revokeMember(actorId: string): Promise<{ event: IEvent; snapshot: Snapshot }> { return this.call("revokeMember", { actorId }); }
  getProjectInfo(): Promise<{ descriptor: ProjectDescriptor; certificate: Certificate; currentKeyId: string }> { return this.call("getProjectInfo"); }
  dispatch(command: ItemCommand): Promise<{ event: IEvent; snapshot: Snapshot }> {
    return this.call("dispatch", { command });
  }
  snapshot(): Promise<Snapshot> { return this.call("snapshot"); }
  readEvents(): Promise<readonly IEvent[]> { return this.call("readEvents"); }
  getSyncSummary(): Promise<SyncSummary> { return this.call("getSyncSummary"); }
  readMissingEvents(summary: SyncSummary): Promise<readonly IEvent[]> { return this.call("readMissingEvents", { summary }); }
  ingestEvents(events: readonly unknown[]): Promise<IngestResult> { return this.call("ingestEvents", { events }); }
  uploadFile(blob: Blob, options: UploadOptions = {}): Promise<{ manifest: FileManifest; event: IEvent; snapshot: Snapshot }> {
    const { onProgress, signal, ...uploadOptions } = options;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const result = this.call<{ manifest: FileManifest; event: IEvent; snapshot: Snapshot }>("uploadFile", { blob, uploadOptions }, [], onProgress);
    const targetId = this.counter;
    const abort = () => { if (!this.stopped) this.worker.postMessage({ method: "cancelUpload", targetId }); };
    signal?.addEventListener("abort", abort, { once: true });
    return result.finally(() => signal?.removeEventListener("abort", abort));
  }
  fileInfo(fileId: string): Promise<FileManifest> { return this.call("fileInfo", { fileId }); }
  readFileChunk(fileId: string, index: number, manifestDigest?: string): Promise<Uint8Array<ArrayBuffer> | null> { return this.call("readFileChunk", { fileId, index, manifestDigest }); }
  acceptFileChunk(fileId: string, index: number, bytes: Uint8Array<ArrayBuffer>, manifestDigest?: string): Promise<Uint8Array<ArrayBuffer>> { return this.call("acceptFileChunk", { fileId, index, bytes, manifestDigest }, [bytes.buffer]); }
  createChunkRequest(fileId: string, index: number, manifestDigest?: string): Promise<ChunkRequest> { return this.call("createChunkRequest", { fileId, index, manifestDigest }); }
  serveChunk(chunkRequest: ChunkRequest): Promise<Uint8Array<ArrayBuffer> | null> { return this.call("serveChunk", { chunkRequest }); }
  onCommit(listener: (notification: CommitNotification) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    try { await this.call("close"); }
    finally { this.terminate(); }
  }

  /** Abrupt worker shutdown for lifecycle tests; never substitutes for awaiting dispatch. */
  terminate(reason = new Error("Worker terminated; pending commits may have completed")): void {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.listeners.clear();
  }

  private call<T>(method: string, arguments_: Record<string, unknown> = {}, transfer: Transferable[] = [], progress?: UploadOptions["onProgress"]): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Client is closed"));
    const id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, ...(progress ? { progress } : {}) });
      try { this.worker.postMessage({ id, method, ...arguments_ }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
}
