import { projectItemsReference } from "./crdt.js";
import { BinaryProjection } from "./wasm-loader.js";
import { authenticateCheckpoint } from "./checkpoints.js";
import { EventIndex, normalizeSummary } from "./event-index.js";
import type { CommitNotification, EventBody, EventMetadata, IEvent, ILocalStore, IngestResult, ItemCommand, ProjectInvitation, Role, Snapshot, SyncSummary } from "./types.js";
import { nextInteger, normalizeCommand, normalizeEvent } from "./validation.js";
import { requireValidEvent, signEvent, type UnlockedIdentity } from "./identity.js";
import { AuthorizationError, certificateActors, verifyCertificate } from "./certificates.js";
import { fromBase64Url, toBase64Url } from "./crypto-codec.js";
import { normalizeChunkRequest, requestBytes, type ChunkRequest } from "./storage-format.js";
import { encryptFields, fieldsAAD, generateProjectKey, wrapProjectKey } from "./project-crypto.js";
import { payloadDigest, ProjectContext, type ProjectEvaluation } from "./project.js";
import { isDataType } from "./types.js";

export class LocalCore {
  private sequence = 0;
  private lamport = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failure: unknown;
  private readonly index = new EventIndex();
  private readonly listeners = new Set<(notification: CommitNotification) => void>();
  private history: IEvent[] | null = [];
  private eventCount = 0;
  private checkpointCount = 0;
  private replayedEvents = 0;
  private checkpointError: string | undefined;
  private state!: ProjectEvaluation;
  private view: Snapshot = projectItemsReference([], 0);
  private projector!: BinaryProjection;
  private constructor(private readonly store: ILocalStore, private identity: UnlockedIdentity | null, private readonly project: ProjectContext, private readonly checkpointInterval = 1000) {
    this.lamport = project?.certificate.issuedLamport ?? 0;
  }

  static async open(store: ILocalStore, identity: UnlockedIdentity, project: ProjectContext, options: { checkpointInterval?: number } = {}): Promise<LocalCore> {
    const interval = options.checkpointInterval ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1000000) throw new RangeError("Invalid checkpoint interval");
    const core = new LocalCore(store, identity, project, interval);
    try {
      if (!project || project.descriptor.projectId !== store.projectId || project.identity.actorId !== identity.actorId || identity.actorId !== store.actorId) throw new AuthorizationError("Project/identity does not own this database");
      core.projector = await BinaryProjection.create();
      const cp = store.checkpoint ? await authenticateCheckpoint(store.checkpoint.proof, project) : undefined;
      const events = store.readRecoveryEvents ? [...await store.readRecoveryEvents()] : [...await store.readEvents()];
      core.replayedEvents = events.length;
      if (cp) {
        core.index.restore(cp.index); core.lamport = cp.lamport; core.sequence = cp.sequence;
        core.eventCount = cp.eventCount; core.checkpointCount = cp.eventCount; core.history = null;
        core.state = await project.restorePolicy(cp.controls, cp.certificates);
        core.projector.restore(cp.native);
        if (events.some(e => !isDataType(e.type))) {
          core.history = [...await store.readEvents()];
          core.state = await project.evaluateBinary(core.history);
          core.projector.reset(); core.projector.applyAll(core.state.blocks);
        } else {
          core.state = await project.extend(core.state, events);
          core.projector.applyAll(core.state.blocks);
        }
      } else {
        core.history = events; core.state = await project.evaluateBinary(events);
        core.projector.applyAll(core.state.blocks);
      }
      for (const block of core.state.blocks) block.fill(0);
      await core.index.assertCompatible(events);
      for (const event of events) {
        const known = core.index.has(event); await core.index.record(event); if (!known) core.eventCount++;
        core.lamport = Math.max(core.lamport, event.lamport);
        if (event.actorId === store.actorId) core.sequence = Math.max(core.sequence, event.sequence);
      }
      core.view = core.projector.snapshot(core.lamport);
      cp?.native.fill(0);
      return core;
    } catch (error) { core.projector?.close(); try { await store.close(); } catch { /* Preserve recovery error. */ } throw error; }
  }
  get actorId(): string { return this.store.actorId; }
  get projectId(): string { return this.store.projectId; }
  get recovery() { return { ...this.store.recovery, checkpointEvents: this.checkpointCount, replayedEvents: this.replayedEvents }; }
  get checkpointStatus() { return { events: this.checkpointCount, lastError: this.checkpointError }; }
  private metadata(): EventMetadata {
    return { schemaVersion: 3, projectId: this.projectId, actorId: this.actorId, sequence: nextInteger(this.sequence),
      lamport: nextInteger(this.lamport), id: `${this.actorId}:${nextInteger(this.sequence)}`, certificate: this.project.certificate };
  }
  dispatch(value: ItemCommand): Promise<{ event: IEvent; snapshot: Snapshot }> {
    let command: ItemCommand;
    try { command = normalizeCommand(value); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      const metadata = this.metadata(), key = this.state.keys.get(this.state.currentKeyId);
      if (!key) throw new AuthorizationError("No current project key; membership revoked");
      const encryptedFields = await encryptFields(command.type === "ITEM_DELETED" ? {} : command.fields,
        fieldsAAD(metadata, command.type, command.itemId, key.id), key);
      return this.writeLocal(metadata, { type: command.type, itemId: command.itemId, keyId: key.id, encryptedFields });
    });
  }
  inviteMember(actorId: string, role: Role = "Member"): Promise<{ invitation: ProjectInvitation; event: IEvent; snapshot: Snapshot }> {
    return this.operation(async () => {
      const metadata = this.metadata();
      const invitation = await this.project.invite(actorId, role, metadata.lamport, this.state);
      return { ...await this.writeLocal(metadata, { type: "MEMBER_INVITED", invitation }), invitation };
    });
  }
  revokeMember(actorId: string): Promise<{ event: IEvent; snapshot: Snapshot }> {
    return this.operation(async () => {
      if (this.actorId !== this.project.descriptor.rootActorId) throw new AuthorizationError("Only project root may revoke");
      if (actorId === this.actorId || !this.state.certificates.has(actorId)) throw new AuthorizationError("Unknown member or root revocation");
      await this.loadHistory();
      const refreshed = await this.project.evaluateBinary(this.history!); for (const block of refreshed.blocks) block.fill(0); this.state = refreshed;
      const metadata = this.metadata(), key = await generateProjectKey();
      try {
        const allowedHistory = [];
        for (const e of this.history!) if (this.state.eligible.has(e.id) && certificateActors(e.certificate).includes(actorId)) allowedHistory.push({ id: e.id, digest: await payloadDigest(e) });
        const revoked = new Set(this.state.revocations.flatMap(e => e.type === "MEMBER_REVOKED" ? [e.revocation.targetActorId] : []));
        revoked.add(actorId);
        const envelopes = [];
        for (const [subject, certificate] of this.state.certificates) if (!certificateActors(certificate).some(actor => revoked.has(actor))) envelopes.push(await wrapProjectKey(key, this.projectId, subject));
        return await this.writeLocal(metadata, { type: "MEMBER_REVOKED", revocation: { targetActorId: actorId, allowedHistory, keyId: key.id, envelopes } });
      } finally { key.bytes.fill(0); }
    });
  }
  private async writeLocal(metadata: EventMetadata, body: EventBody): Promise<{ event: IEvent; snapshot: Snapshot }> {
    const event = await signEvent({ ...metadata, ...body }, this.identity!);
    const prospective = isDataType(event.type) ? await this.project.extend(this.state, [event]) :
      await this.project.evaluateBinary([...await this.loadHistory(), event]);
    if (!prospective.eligible.has(event.id)) throw new AuthorizationError("Event permission revoked");
    await this.commit(event, "local", prospective);
    return { event, snapshot: this.view };
  }
  private async commit(event: IEvent, source: "local" | "remote", state: ProjectEvaluation): Promise<void> {
    let view: Snapshot;
    try {
      if (!isDataType(event.type)) this.projector.reset();
      this.projector.applyAll(state.blocks);
      view = this.projector.snapshot(Math.max(this.lamport, event.lamport));
    } catch (error) {
      // Allocation/snapshot failure may leave unpublished native state; require recovery.
      // Invalid ordinary input is staged atomically in C++ and leaves its state unchanged.
      if (!isDataType(event.type) || !(error instanceof Error && error.name === "NativeMergeError" && (error as { status?: number }).status === 1)) this.failure = error;
      throw error;
    } finally { for (const block of state.blocks) block.fill(0); }
    try {
      await this.store.append(event);
      this.history?.push(event); this.state = state; this.eventCount++;
      await this.index.record(event);
      this.lamport = Math.max(this.lamport, event.lamport);
      if (event.actorId === this.actorId) this.sequence = Math.max(this.sequence, event.sequence);
      this.view = view;
    } catch (error) { this.failure = error; throw error; }
    await this.maybeCheckpoint();
    const notification = Object.freeze({ source, event });
    for (const listener of this.listeners) { try { listener(notification); } catch { /* Isolate observers. */ } }
  }
  private async loadHistory(): Promise<IEvent[]> {
    return this.history ??= [...await this.store.readEvents()];
  }
  private async maybeCheckpoint(): Promise<void> {
    if (!this.store.saveCheckpoint || this.store.checkpointEnabled === false || this.eventCount - this.checkpointCount < this.checkpointInterval) return;
    let native: Uint8Array<ArrayBuffer> | undefined;
    try {
      native = this.projector.checkpoint();
      await this.store.saveCheckpoint({ eventCount: this.eventCount, lamport: this.lamport, sequence: this.sequence,
        index: this.index.export(), controls: [...this.state.governance], certificates: [...this.state.certificates.values()], native });
      this.checkpointCount = this.eventCount; this.checkpointError = undefined;
    } catch (error) {
      // The authoritative event was already flushed. A failed optional cache must not turn it into an uncertain commit.
      this.checkpointError = String(error);
    } finally { native?.fill(0); }
  }

  snapshot(): Promise<Snapshot> { return this.operation(() => this.view); }
  getProjectInfo() { return this.operation(() => ({ descriptor: this.project.descriptor, certificate: this.project.certificate, currentKeyId: this.state.currentKeyId })); }
  /** Worker-internal non-extractable key handle; never exposed by LocalCoreClient RPC. */
  storageKey(keyId?: string): Promise<{ keyId: string; key: CryptoKey }> {
    return this.operation(() => {
      this.requireStorageMember(this.project.certificate);
      const key = this.state.keys.get(keyId ?? this.state.currentKeyId);
      if (!key) throw new AuthorizationError("No authorized storage key for epoch");
      return { keyId: key.id, key: key.key };
    });
  }
  private requireStorageMember(certificate: import("./types.js").Certificate): void {
    if (this.state.revocations.some(e => e.type === "MEMBER_REVOKED" && certificateActors(certificate).includes(e.revocation.targetActorId))) throw new AuthorizationError("Storage membership revoked");
  }
  createChunkRequest(fileId: string, index: number, hash: string): Promise<ChunkRequest> {
    return this.operation(async () => {
      this.requireStorageMember(this.project.certificate);
      const request = normalizeChunkRequest({ version: 1, requestId: crypto.randomUUID(), projectId: this.projectId,
        rootActorId: this.project.descriptor.rootActorId, genesisKeyId: this.project.descriptor.genesisKeyId,
        actorId: this.actorId, certificate: this.project.certificate, fileId, index, hash, signature: "A".repeat(86) });
      const signature = toBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.identity!.privateKey, requestBytes(request)));
      return normalizeChunkRequest({ ...request, signature });
    });
  }
  authorizeChunkRequest(value: ChunkRequest): Promise<void> {
    return this.operation(async () => {
      this.requireStorageMember(this.project.certificate);
      const request = normalizeChunkRequest(value), descriptor = this.project.descriptor;
      if (request.projectId !== this.projectId || request.rootActorId !== descriptor.rootActorId || request.genesisKeyId !== descriptor.genesisKeyId) throw new AuthorizationError("Chunk request project mismatch");
      const certificate = await verifyCertificate(request.certificate, descriptor);
      if (certificate.subject !== request.actorId) throw new AuthorizationError("Chunk request actor mismatch");
      this.requireStorageMember(certificate);
      const key = await crypto.subtle.importKey("raw", fromBase64Url(request.actorId.slice(5), 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(request.signature, 64), requestBytes(request))) throw new AuthorizationError("Invalid chunk request signature");
    });
  }
  readEvents(): Promise<readonly IEvent[]> {
    return this.operation(async () => {
      const events = await this.store.readEvents();
      await this.project.evaluate(events);
      return events;
    });
  }
  onCommit(listener: (notification: CommitNotification) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSyncSummary(): Promise<SyncSummary> { return this.operation(() => this.index.summary()); }
  readMissingEvents(value: SyncSummary): Promise<readonly IEvent[]> {
    let summary: SyncSummary;
    try { summary = normalizeSummary(value); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      const events = await this.store.readEvents(), state = await this.project.evaluate(events);
      return events.filter(event => state.eligible.has(event.id) && event.sequence > (summary[event.actorId] ?? 0));
    });
  }
  ingestEvents(values: readonly unknown[]): Promise<IngestResult> {
    let events: IEvent[];
    try {
      if (!Array.isArray(values) || values.length > 64) throw new RangeError("A sync batch may contain at most 64 events");
      events = values.map(normalizeEvent);
    } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      await Promise.all(events.map(e => requireValidEvent(e, this.projectId)));
      await this.index.assertCompatible(events);
      const newEvents = events.filter((e, i) => !this.index.has(e) && events.findIndex(other => other.id === e.id) === i);
      const governance = newEvents.some(e => !isDataType(e.type));
      const prospective = governance ? await this.project.evaluateBinary([...await this.loadHistory(), ...newEvents]) :
        await this.project.extend(this.state, events);
      try {
        for (const e of events) if (!prospective.eligible.has(e.id)) throw new AuthorizationError("Event permission revoked");
        const validation = await BinaryProjection.create();
        try { validation.applyAll(prospective.blocks); } finally { validation.close(); }
      }
      finally { for (const block of prospective.blocks) block.fill(0); }
      newEvents.sort((a, b) => Number(isDataType(a.type)) - Number(isDataType(b.type)) || a.lamport - b.lamport || a.sequence - b.sequence);
      let applied = 0;
      for (const event of newEvents) {
        const state = isDataType(event.type) ? await this.project.extend(this.state, [event]) :
          await this.project.evaluateBinary([...await this.loadHistory(), event]);
        await this.commit(event, "remote", state); applied++;
      }
      return { applied, summary: this.index.summary(), snapshot: this.view };
    });
  }
  close(): Promise<void> {
    this.closing = true; this.listeners.clear();
    return this.enqueue(async () => { try { await this.store.close(); } finally { this.identity = null; this.projector.close(); this.project.close(); for (const key of this.state.keys.values()) key.bytes.fill(0); } });
  }
  private operation<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Core is closing"));
    return this.enqueue(() => { if (this.failure !== undefined) throw new Error("Core is faulted; close and reopen", { cause: this.failure }); return fn(); });
  }
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
}
