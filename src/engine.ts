import { EMPTY_QUERY_POSITION, QueryCursorInvalidatedError, normalizeQueryOptions, type QueryCursorHandle, type QueryOptions, type QueryPage, type QueryPosition } from "./query.js";
import { BinaryProjection } from "./wasm-loader.js";
import { authenticateCheckpoint } from "./checkpoints.js";
import { EventIndex, normalizeSummary, MAX_PAGED_SYNC_ACTORS } from "./event-index.js";
import type { CommitNotification, EventBody, EventMetadata, IEvent, ILocalStore, IngestResult, ItemCommand, ProjectInvitation, Role, Snapshot, SyncSummary, SyncCursorHandle, SyncEventPage, StoredEventScan } from "./types.js";
import { LOG_PAGE_BYTES, LOG_PAGE_RECORDS, MAX_RECORD_BYTES } from "./framed-log.js";
import { encodeWire } from "./binary-events.js";
import { nextInteger, normalizeCommand, normalizeEvent } from "./validation.js";
import { requireValidEvent, signEvent, type UnlockedIdentity } from "./identity.js";
import { AuthorizationError, EpochIncompleteError, certificateActors, verifyCertificate } from "./certificates.js";
import { fromBase64Url, toBase64Url } from "./crypto-codec.js";
import { normalizeChunkRequest, requestBytes, type ChunkRequest } from "./storage-format.js";
import { encryptFields, fieldsAAD, generateProjectKey, wrapProjectKey } from "./project-crypto.js";
import { payloadDigest, ProjectContext, type ProjectEvaluation } from "./project.js";
import { isDataType } from "./types.js";
import { deriveDiscoveryMaterial, discoveryPayload, sealDiscoveryPayload, decryptDiscoveryPayload, DiscoveryReplayWindow, type DiscoveryMaterial } from "./discovery-crypto.js";
import type { DiscoverySignal, VerifiedDiscoverySignal } from "./discovery-provider.js";
import { encodeBinary } from "./binary-codec.js";
import { buildEpochPages, epochPageCount, MAX_EPOCH_ENTRIES } from "./epoch-pages.js";
import { DiscoveryRecoveryEngine, copyRecoveryPacket } from "./discovery-recovery-engine.js";

const MAX_SYNC_CURSORS = 32;
interface SyncCursor {
  readonly id: string; readonly end: number; readonly summary: SyncSummary;
  readonly revision: number; readonly controls: readonly IEvent[];
  controlAt: number; offset: number; phase: "controls" | "log";
  timer: number;
  readonly scan?: StoredEventScan;
}
export class SyncCursorInvalidatedError extends Error {
  constructor() { super("Sync governance changed; reconnect from durable receipt"); this.name = "SyncCursorInvalidatedError"; }
}

export class LocalCore {
  private readonly discoveryReplays = new DiscoveryReplayWindow();
  private discoveryMaterial: { keyId: string; value: DiscoveryMaterial } | undefined;
  private recoveryEngine: DiscoveryRecoveryEngine | undefined;
  private readonly discoveryCertificates = new Map<string, import("./types.js").Certificate>();
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
  private view: Snapshot | undefined;
  private readonly queryCursors = new Map<string, { revision: number; lamport: number; options: Required<QueryOptions>; position: QueryPosition; timer: number }>();
  private projector!: BinaryProjection;
  private governanceRevision = 0;
  private readonly syncCursors = new Map<string, SyncCursor>();
  private constructor(private readonly store: ILocalStore, private identity: UnlockedIdentity | null, private readonly project: ProjectContext, private readonly checkpointInterval = 1000, private readonly syncCursorIdleTimeoutMs = 60000) {
    this.lamport = project?.certificate.issuedLamport ?? 0;
  }

  static async open(store: ILocalStore, identity: UnlockedIdentity, project: ProjectContext, options: { checkpointInterval?: number; syncCursorIdleTimeoutMs?: number } = {}): Promise<LocalCore> {
    const interval = options.checkpointInterval ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1000000) throw new RangeError("Invalid checkpoint interval");
    const idle = options.syncCursorIdleTimeoutMs ?? 60000;
    if (!Number.isSafeInteger(idle) || idle < 1 || idle > 300000) throw new RangeError("Invalid sync cursor idle timeout");
    const core = new LocalCore(store, identity, project, interval, idle);
    try {
      if (!project || project.descriptor.projectId !== store.projectId || project.identity.actorId !== identity.actorId || identity.actorId !== store.actorId) throw new AuthorizationError("Project/identity does not own this database");
      core.projector = await BinaryProjection.create(project.descriptor.policies);
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
          core.projector.reset(); core.projector.applyAuthorized(core.state.blocks, core.state.roles);
        } else {
          core.state = await project.extend(core.state, events);
          core.projector.applyAuthorized(core.state.blocks, core.state.roles);
        }
      } else {
        core.history = events; core.state = await project.evaluateBinary(events);
        core.projector.applyAuthorized(core.state.blocks, core.state.roles);
      }
      for (const block of core.state.blocks) block.fill(0);
      await core.index.assertCompatible(events);
      for (const event of events) {
        const known = core.index.has(event); await core.index.record(event); if (!known) core.eventCount++;
        core.lamport = Math.max(core.lamport, event.lamport);
        if (event.actorId === store.actorId) core.sequence = Math.max(core.sequence, event.sequence);
      }
      // Full views are decoded lazily; open RPC explicitly requests the legacy snapshot.
      cp?.native.fill(0);
      return core;
    } catch (error) { core.projector?.close(); try { await store.close(); } catch { /* Preserve recovery error. */ } throw error; }
  }
  get actorId(): string { return this.store.actorId; }
  get projectId(): string { return this.store.projectId; }
  /** Namespace admission only; normal dispatch/signature/native validation still applies. */
  assertStorageItemDomain(itemId: string): void { this.project.assertItemDomain(itemId); }
  get recovery() { return { ...this.store.recovery, checkpointEvents: this.checkpointCount, replayedEvents: this.replayedEvents }; }
  get checkpointStatus() { return { events: this.checkpointCount, lastError: this.checkpointError }; }
  private metadata(): EventMetadata {
    return { schemaVersion: 3, projectId: this.projectId, actorId: this.actorId, sequence: nextInteger(this.sequence),
      lamport: nextInteger(this.lamport), id: `${this.actorId}:${nextInteger(this.sequence)}`, certificate: this.project.certificate };
  }
  dispatch(value: ItemCommand): Promise<{ event: IEvent; snapshot: Snapshot }> { return this.dispatchItem(value, true); }
  dispatchCommitted(value: ItemCommand): Promise<import("./types.js").CommitReceipt> { return this.dispatchItem(value, false); }
  private dispatchItem(value: ItemCommand, materialize: true): Promise<{ event: IEvent; snapshot: Snapshot }>;
  private dispatchItem(value: ItemCommand, materialize: false): Promise<import("./types.js").CommitReceipt>;
  private dispatchItem(value: ItemCommand, materialize: boolean): Promise<{ event: IEvent; snapshot: Snapshot } | import("./types.js").CommitReceipt> {
    let command: ItemCommand;
    try { command = normalizeCommand(value); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      this.project.assertItemDomain(command.itemId);
      const metadata = this.metadata(), key = this.state.keys.get(this.state.currentKeyId);
      if (this.state.pendingEpochs.some(p => p.keyId === this.state.currentKeyId)) throw new EpochIncompleteError();
      if (!key) throw new AuthorizationError("No current project key; membership revoked");
      const encryptedFields = await encryptFields(command.type === "ITEM_DELETED" ? {} : command.fields,
        fieldsAAD(metadata, command.type, command.itemId, key.id), key);
      const body = { type: command.type, itemId: command.itemId, keyId: key.id, encryptedFields };
      if (materialize) return this.writeLocal(metadata, body);
      const event = await this.persistLocal(metadata, body, false);
      return { event, lamport: this.lamport, revision: this.eventCount };
    });
  }
  inviteMember(actorId: string, role: Role = "Member"): Promise<{ invitation: ProjectInvitation; event: IEvent; snapshot: Snapshot }> {
    return this.operation(async () => {
      const metadata = this.metadata();
      const invitation = await this.project.invite(actorId, role, metadata.lamport, this.state);
      return { ...await this.writeLocal(metadata, { type: "MEMBER_INVITED", invitation }), invitation };
    });
  }
  revokeMember(actorId: string, options: import("./types.js").RevokeOptions = {}): Promise<import("./types.js").RevokeResult> {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(k => k !== "paged") ||
        (options.paged !== undefined && typeof options.paged !== "boolean")) return Promise.reject(new TypeError("Invalid revocation options"));
    const forcePaged = options.paged === true;
    return this.operation(async () => {
      if (this.actorId !== this.project.descriptor.rootActorId) throw new AuthorizationError("Only project root may revoke");
      if (actorId === this.actorId || !this.state.certificates.has(actorId)) throw new AuthorizationError("Unknown member or root revocation");
      if (this.state.pendingEpochs.length) throw new AuthorizationError("Complete pending epoch pages before another rotation");
      await this.loadHistory();
      const refreshed = await this.project.evaluateBinary(this.history!); for (const block of refreshed.blocks) block.fill(0); this.state = refreshed;
      const metadata = this.metadata(), key = await generateProjectKey();
      try {
        const allowedHistory = [];
        for (const e of this.history!) if (this.state.eligible.has(e.id) && certificateActors(e.certificate).includes(actorId)) allowedHistory.push({ id: e.id, digest: await payloadDigest(e) });
        const revoked = new Set(this.state.revocations.flatMap(e => e.type === "MEMBER_REVOKED" ? [e.revocation.targetActorId] : []));
        revoked.add(actorId);
        const recipients = [...this.state.certificates].filter(([, certificate]) => !certificateActors(certificate).some(actor => revoked.has(actor)));
        if (recipients.length > MAX_EPOCH_ENTRIES || allowedHistory.length > MAX_EPOCH_ENTRIES) throw new RangeError("Paged rotation exceeds 65,536-entry bounds");
        const envelopes = [];
        for (const [subject] of recipients) envelopes.push(await wrapProjectKey(key, this.projectId, subject));
        const inlineBody = { type: "MEMBER_REVOKED" as const, revocation: { targetActorId: actorId, allowedHistory, keyId: key.id, envelopes } };
        if (!forcePaged && allowedHistory.length <= 4096 && envelopes.length <= 4096 &&
            encodeWire({ ...metadata, ...inlineBody, signature: "A".repeat(86) }).length <= MAX_RECORD_BYTES) return await this.writeLocal(metadata, inlineBody);
        const pageCount = epochPageCount(envelopes.length) + epochPageCount(allowedHistory.length);
        const sequence = nextInteger(this.sequence + pageCount), lamport = nextInteger(this.lamport + pageCount);
        const manifestId = `${this.actorId}:${sequence}`, epochId = `epoch_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
        const plan = await buildEpochPages(this.projectId, key.id, actorId, epochId, envelopes, allowedHistory);
        // Prepare/flush every page before the manifest. Crash here leaves the old epoch active.
        for (const epochPage of plan.pages) {
          const page = await signEvent({ ...this.metadata(), schemaVersion: 4, type: "KEY_EPOCH_PAGE", epochPage }, this.identity!);
          await this.commit(page, "local", await this.project.prepareEpochPages(this.state, [page]), true);
        }
        const result = await this.writeLocal({ ...metadata, schemaVersion: 4, sequence, lamport, id: manifestId },
          { type: "MEMBER_REVOKED", revocation: { targetActorId: actorId, keyId: key.id, envelopes: [], allowedHistory: [], epoch: plan.commitment } });
        return { ...result, pageCount };
      } finally { key.bytes.fill(0); }
    });
  }
  private async writeLocal(metadata: EventMetadata, body: EventBody): Promise<{ event: IEvent; snapshot: Snapshot }> {
    const event = await this.persistLocal(metadata, body, true);
    return { event, snapshot: this.getView() };
  }
  private async persistLocal(metadata: EventMetadata, body: EventBody, materialize: boolean): Promise<IEvent> {
    const event = await signEvent({ ...metadata, ...body }, this.identity!);
    const prospective = isDataType(event.type) ? await this.project.extend(this.state, [event]) :
      await this.project.evaluateBinary([...await this.loadHistory(), event]);
    if (!prospective.eligible.has(event.id)) throw new AuthorizationError("Event permission revoked");
    await this.commit(event, "local", prospective, false, materialize);
    return event;
  }
  private async commit(event: IEvent, source: "local" | "remote", state: ProjectEvaluation, preparation = false, materialize = true): Promise<void> {
    let view: Snapshot | undefined;
    try {
      if (!isDataType(event.type) && !preparation) this.projector.reset();
      this.projector.applyAuthorized(state.blocks, state.roles);
      if (materialize) view = this.projector.snapshot(Math.max(this.lamport, event.lamport));
    } catch (error) {
      // Allocation/snapshot failure may leave unpublished native state; require recovery.
      // Invalid ordinary input is staged atomically in C++ and leaves its state unchanged.
      if (!isDataType(event.type) || !(error instanceof Error && error.name === "NativeMergeError" && [1, 3].includes((error as { status?: number }).status ?? 0))) this.failure = error;
      throw error;
    } finally { for (const block of state.blocks) block.fill(0); }
    try {
      await this.store.append(event);
      this.history?.push(event); this.state = state; this.eventCount++;
      if (!isDataType(event.type)) this.governanceRevision++;
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

  private getView(): Snapshot { return this.view ??= this.projector.snapshot(this.lamport); }
  snapshot(): Promise<Snapshot> { return this.operation(() => this.getView()); }
  openQueryCursor(value: QueryOptions): Promise<QueryCursorHandle> {
    let options: Required<QueryOptions>;
    try { options = normalizeQueryOptions(value); } catch (error) { return Promise.reject(error); }
    return this.operation(() => {
      if (this.queryCursors.size >= 32) throw new RangeError("Query cursor capacity exceeded");
      const id = crypto.randomUUID(), revision = this.eventCount;
      const cursor = { revision, lamport: this.lamport, options, position: EMPTY_QUERY_POSITION, timer: 0 };
      this.queryCursors.set(id, cursor); this.refreshQueryCursor(id);
      return Object.freeze({ id, revision });
    });
  }
  readQueryCursor(id: string): Promise<QueryPage> {
    return this.operation(() => {
      const cursor = this.queryCursors.get(id);
      if (!cursor) throw new Error("Unknown, completed or expired query cursor");
      if (cursor.revision !== this.eventCount) { this.dropQueryCursor(id); throw new QueryCursorInvalidatedError(); }
      try {
        const { next, ...page } = this.projector.queryPage(cursor.options, cursor.position);
        cursor.position = next;
        if (page.done) this.dropQueryCursor(id); else this.refreshQueryCursor(id);
        return Object.freeze({ ...page, kind: cursor.options.kind, revision: cursor.revision, lamport: cursor.lamport });
      } catch (error) { this.dropQueryCursor(id); throw error; }
    });
  }
  closeQueryCursor(id: string): Promise<void> { return this.enqueue(() => { this.dropQueryCursor(id); }); }
  private refreshQueryCursor(id: string): void {
    const cursor = this.queryCursors.get(id); if (!cursor) return;
    globalThis.clearTimeout(cursor.timer);
    cursor.timer = globalThis.setTimeout(() => this.dropQueryCursor(id), this.syncCursorIdleTimeoutMs);
  }
  private dropQueryCursor(id: string): void {
    const cursor = this.queryCursors.get(id);
    if (cursor) { globalThis.clearTimeout(cursor.timer); this.queryCursors.delete(id); }
  }
  getProjectInfo() { return this.operation(() => ({ descriptor: this.project.descriptor, certificate: this.project.certificate,
    currentKeyId: this.state.currentKeyId, pendingEpochs: this.state.pendingEpochs })); }
  /** Recipient-encrypted bootstrap only; no raw project or wallet keys. */
  getBootstrapInvitation(): Promise<ProjectInvitation> { return this.operation(() => this.project.invitation); }
  getMemberCertificate(actorId: string): Promise<import("./types.js").Certificate | null> { return this.operation(() => this.state.certificates.get(actorId) ?? null); }
  isDiscoveryPeerAuthorized(actorId: string): Promise<boolean> {
    return this.operation(() => {
      const c = this.state.certificates.get(actorId) ?? this.discoveryCertificates.get(actorId); if (!c) return false;
      try { this.requireStorageMember(c); return true; } catch { return false; }
    });
  }
  private recoveryChannel(): DiscoveryRecoveryEngine {
    return this.recoveryEngine ??= new DiscoveryRecoveryEngine(this.project.descriptor, this.project.certificate, this.identity!, {
      state: () => this.state, revision: () => this.governanceRevision,
      requireMember: c => this.requireStorageMember(c),
      eligible: e => this.project.isEventEligible(e, this.state.revocations, this.state.epochs),
      ingest: async e => { await this.ingestNormalized([e]); },
    });
  }
  getDiscoveryRecoveryInfo(): Promise<{ topic: string; instanceId: string }> { return this.operation(() => this.recoveryChannel().info()); }
  createDiscoveryRecoveryRequest(): Promise<Uint8Array<ArrayBuffer>> { return this.operation(() => this.recoveryChannel().begin()); }
  createRoutedDiscoveryRecoveryRequest(): Promise<Uint8Array<ArrayBuffer>> { return this.operation(() => this.recoveryChannel().begin(true)); }
  handleDiscoveryRecoveryRequest(packet: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
    let copy: Uint8Array<ArrayBuffer>;
    try { copy = copyRecoveryPacket(packet); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => (await this.recoveryChannel().serve(copy))?.packet ?? null);
  }
  handleRoutedDiscoveryRecoveryRequest(packet: Uint8Array<ArrayBuffer>): Promise<import("./discovery-provider.js").RecoveryReply | null> {
    let copy: Uint8Array<ArrayBuffer>;
    try { copy = copyRecoveryPacket(packet); } catch (error) { return Promise.reject(error); }
    return this.operation(() => this.recoveryChannel().serve(copy, true));
  }
  acceptDiscoveryRecoveryResponse(packet: Uint8Array<ArrayBuffer>): Promise<import("./discovery-provider.js").RecoveryProgress | null> {
    let copy: Uint8Array<ArrayBuffer>;
    try { copy = copyRecoveryPacket(packet); } catch (error) { return Promise.reject(error); }
    return this.operation(() => this.recoveryChannel().accept(copy));
  }
  cancelDiscoveryRecovery(): Promise<void> { return this.operation(() => { this.recoveryEngine?.cancel(); }); }
  private async rendezvous(): Promise<DiscoveryMaterial> {
    this.requireStorageMember(this.project.certificate);
    const key = this.state.keys.get(this.state.currentKeyId);
    if (this.state.pendingEpochs.some(p => p.keyId === this.state.currentKeyId)) throw new EpochIncompleteError();
    if (!key) throw new AuthorizationError("No current discovery key");
    if (this.discoveryMaterial?.keyId !== key.id) this.discoveryMaterial = { keyId: key.id, value: await deriveDiscoveryMaterial(this.project.descriptor, key) };
    return this.discoveryMaterial.value;
  }
  getDiscoveryInfo(): Promise<{ topic: string; keyId: string; actorId: string }> {
    return this.operation(async () => ({ topic: (await this.rendezvous()).topic, keyId: this.state.currentKeyId, actorId: this.actorId }));
  }
  sealDiscovery(signal: DiscoverySignal): Promise<Uint8Array<ArrayBuffer>> {
    return this.operation(async () => sealDiscoveryPayload(discoveryPayload(this.project.descriptor, this.state.currentKeyId,
      this.actorId, this.project.certificate, signal), await this.rendezvous(), this.identity!.privateKey));
  }
  openDiscovery(packet: Uint8Array<ArrayBuffer>): Promise<VerifiedDiscoverySignal> {
    return this.operation(async () => {
      const { payload, signature } = await decryptDiscoveryPayload(packet, await this.rendezvous());
      if (payload.projectId !== this.projectId || payload.rootActorId !== this.project.descriptor.rootActorId || payload.keyId !== this.state.currentKeyId) throw new AuthorizationError("Discovery project/epoch mismatch");
      const certificate = await verifyCertificate(payload.certificate, this.project.descriptor);
      if (certificate.subject !== payload.actorId) throw new AuthorizationError("Discovery certificate/actor mismatch");
      this.requireStorageMember(certificate);
      const key = await crypto.subtle.importKey("raw", fromBase64Url(payload.actorId.slice(5), 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, encodeBinary(payload))) throw new AuthorizationError("Invalid discovery signature");
      this.discoveryReplays.accept(payload);
      if (this.discoveryCertificates.size >= 256 && !this.discoveryCertificates.has(payload.actorId)) this.discoveryCertificates.delete(this.discoveryCertificates.keys().next().value!);
      this.discoveryCertificates.set(payload.actorId, certificate);
      return { actorId: payload.actorId, signal: payload.signal };
    });
  }
  /** Worker-internal non-extractable key handle; never exposed by LocalCoreClient RPC. */
  storageKey(keyId?: string): Promise<{ keyId: string; key: CryptoKey }> {
    return this.operation(() => {
      this.requireStorageMember(this.project.certificate);
      const key = this.state.keys.get(keyId ?? this.state.currentKeyId);
      if (this.state.pendingEpochs.some(p => p.keyId === (keyId ?? this.state.currentKeyId))) throw new EpochIncompleteError();
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
    return this.missingEvents(value, 4096);
  }
  readMissingEventsPaged(value: SyncSummary): Promise<readonly IEvent[]> {
    return this.missingEvents(value, MAX_PAGED_SYNC_ACTORS);
  }
  private missingEvents(value: SyncSummary, maximumActors: number): Promise<readonly IEvent[]> {
    let summary: SyncSummary;
    try { summary = normalizeSummary(value, maximumActors); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      const events = await this.store.readEvents(), state = await this.project.evaluate(events);
      return events.filter(event => state.eligible.has(event.id) && event.sequence > (summary[event.actorId] ?? 0));
    });
  }
  /** No whole-log array or decrypted fields are allocated for cursor catch-up. */
  openSyncCursor(value: SyncSummary): Promise<SyncCursorHandle | null> {
    let summary: SyncSummary;
    try { summary = normalizeSummary(value, MAX_PAGED_SYNC_ACTORS); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      this.requireStorageMember(this.project.certificate);
      if ((!this.store.readEventPage && !this.store.openMissingEventScan) || this.store.endOffset === undefined) return null;
      if (this.syncCursors.size >= MAX_SYNC_CURSORS) throw new RangeError("Sync cursor capacity exceeded");
      const id = crypto.randomUUID(), end = this.store.endOffset;
      if (!Number.isSafeInteger(end) || end < 0) throw new Error("Store returned an invalid committed log boundary");
      let scan: StoredEventScan | undefined;
      try { scan = await this.store.openMissingEventScan?.(summary, end); }
      catch (error) { this.failure = error; throw error; }
      const cursor: SyncCursor = { id, end, summary, revision: this.governanceRevision,
        controls: this.state.governance, controlAt: 0, offset: 0, phase: "controls", timer: 0, ...(scan ? { scan } : {}) };
      this.syncCursors.set(id, cursor); this.refreshSyncCursor(cursor);
      return Object.freeze({ id, endOffset: end });
    });
  }
  readSyncCursor(cursorId: string): Promise<SyncEventPage> {
    return this.operation(async () => {
      const cursor = this.syncCursors.get(cursorId);
      if (!cursor) throw new Error("Unknown, completed or expired sync cursor");
      if (cursor.revision !== this.governanceRevision) { this.dropSyncCursor(cursorId); throw new SyncCursorInvalidatedError(); }
      this.requireStorageMember(this.project.certificate);
      globalThis.clearTimeout(cursor.timer); // Idle timeout excludes active cryptographic reads.
      try {
        let events: readonly IEvent[], scannedRecords = 0, scannedBytes = 0, scanDone = false;
        const controls = cursor.phase === "controls";
        if (controls) {
          // Authenticated controls already live in the current policy/checkpoint.
          // Send epochs first even when their physical append order follows data.
          const page: IEvent[] = []; let bytes = 0;
          while (cursor.controlAt < cursor.controls.length && page.length < LOG_PAGE_RECORDS && bytes < LOG_PAGE_BYTES) {
            const control = cursor.controls[cursor.controlAt]!, size = encodeWire(control).length;
            if (size > MAX_RECORD_BYTES) throw new Error("Governance record exceeds cursor limit");
            if (page.length && bytes + size > LOG_PAGE_BYTES) break;
            page.push(control); bytes += size; cursor.controlAt++;
          }
          events = page;
          if (cursor.controlAt === cursor.controls.length) cursor.phase = "log";
        } else if (cursor.scan) {
          const page = await cursor.scan.readPage();
          if (typeof page.done !== "boolean" || !Array.isArray(page.events) || (!page.events.length && !page.done) || page.events.length > LOG_PAGE_RECORDS || page.scannedRecords !== page.events.length || !Number.isSafeInteger(page.scannedBytes) || page.scannedBytes < page.scannedRecords * 17 || page.scannedBytes > MAX_RECORD_BYTES + 16 || (page.scannedBytes > LOG_PAGE_BYTES && page.scannedRecords !== 1)) throw new Error("Store violated indexed cursor contract");
          events = page.events; scannedRecords = page.scannedRecords; scannedBytes = page.scannedBytes; scanDone = page.done;
        } else {
          const page = await this.store.readEventPage!(cursor.offset, cursor.end);
          if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < cursor.offset || page.nextOffset > cursor.end ||
              (page.nextOffset === cursor.offset && cursor.offset !== cursor.end) || page.events.length > LOG_PAGE_RECORDS ||
              !Number.isSafeInteger(page.scannedRecords) || page.scannedRecords < page.events.length || page.scannedRecords > LOG_PAGE_RECORDS ||
              page.scannedBytes !== page.nextOffset - cursor.offset ||
              page.scannedBytes > MAX_RECORD_BYTES + 16 || (page.scannedBytes > LOG_PAGE_BYTES && page.scannedRecords !== 1)) throw new Error("Store violated bounded cursor contract");
          events = page.events; scannedRecords = page.scannedRecords; scannedBytes = page.scannedBytes;
          cursor.offset = page.nextOffset;
        }
        // The authenticated index proves prior admission/decryption/native RLS.
        // Recheck disk signatures/chains and exact content; never trust CRC alone.
        const verified = await Promise.all(events.map(event => this.project.authenticateEvent(event)));
        await this.index.assertCompatible(verified);
        const outgoing: IEvent[] = [];
        for (const event of verified) {
          if (!this.index.has(event)) throw new Error("Cursor record is absent from authenticated durable index");
          if (!controls && !isDataType(event.type)) continue;
          if (event.sequence > (cursor.summary[event.actorId] ?? 0) && await this.project.isEventEligible(event, this.state.revocations, this.state.epochs)) outgoing.push(event);
        }
        const done = cursor.phase === "log" && (cursor.scan ? scanDone : cursor.offset === cursor.end);
        if (done) this.dropSyncCursor(cursorId); else this.refreshSyncCursor(cursor);
        return Object.freeze({ events: Object.freeze(outgoing), done, scannedRecords, scannedBytes });
      } catch (error) { this.dropSyncCursor(cursorId); this.failure = error; throw error; }
    });
  }
  closeSyncCursor(cursorId: string): Promise<void> { return this.enqueue(() => { this.dropSyncCursor(cursorId); }); }
  private refreshSyncCursor(cursor: SyncCursor): void {
    globalThis.clearTimeout(cursor.timer);
    if (this.closing || this.syncCursors.get(cursor.id) !== cursor) return;
    cursor.timer = globalThis.setTimeout(() => this.dropSyncCursor(cursor.id), this.syncCursorIdleTimeoutMs);
  }
  private dropSyncCursor(id: string): void {
    const cursor = this.syncCursors.get(id);
    if (cursor) { globalThis.clearTimeout(cursor.timer); cursor.scan?.close(); this.syncCursors.delete(id); }
  }
  ingestEvents(values: readonly unknown[]): Promise<IngestResult> { return this.ingestInput(values, true); }
  ingestCommitted(values: readonly unknown[]): Promise<import("./types.js").IngestReceipt> { return this.ingestInput(values, false); }
  private ingestInput(values: readonly unknown[], materialize: true): Promise<IngestResult>;
  private ingestInput(values: readonly unknown[], materialize: false): Promise<import("./types.js").IngestReceipt>;
  private ingestInput(values: readonly unknown[], materialize: boolean): Promise<IngestResult | import("./types.js").IngestReceipt> {
    let events: IEvent[];
    try {
      if (!Array.isArray(values) || values.length > 64) throw new RangeError("A sync batch may contain at most 64 events");
      events = values.map(normalizeEvent);
    } catch (error) { return Promise.reject(error); }
    return this.operation<IngestResult | import("./types.js").IngestReceipt>(() => materialize ? this.ingestNormalized(events) : this.ingestNormalized(events, false));
  }
  private ingestNormalized(events: IEvent[]): Promise<IngestResult>;
  private ingestNormalized(events: IEvent[], materialize: false): Promise<import("./types.js").IngestReceipt>;
  private async ingestNormalized(events: IEvent[], materialize = true): Promise<IngestResult | import("./types.js").IngestReceipt> {
      await Promise.all(events.map(e => requireValidEvent(e, this.projectId)));
      await this.index.assertCompatible(events);
      const newEvents = events.filter((e, i) => !this.index.has(e) && events.findIndex(other => other.id === e.id) === i);
      if (events.length && events.every(e => e.type === "KEY_EPOCH_PAGE" && !this.state.revocations.some(r => r.type === "MEMBER_REVOKED" && r.revocation.epoch?.id === e.epochPage.epochId))) {
        await this.project.prepareEpochPages(this.state, events); // Validate the complete batch before any append.
        newEvents.sort((a, b) => a.lamport - b.lamport || a.sequence - b.sequence);
        for (const event of newEvents) await this.commit(event, "remote", await this.project.prepareEpochPages(this.state, [event]), true, materialize);
        const receipt = { applied: newEvents.length, summary: this.index.summary(), lamport: this.lamport, revision: this.eventCount };
        return materialize ? { applied: receipt.applied, summary: receipt.summary, snapshot: this.getView() } : receipt;
      }
      // Known controls still need governance authorization; they cannot be fed
      // to the item-only delta path during conservative legacy catch-up.
      const governance = events.some(e => !isDataType(e.type));
      const prospective = governance ? await this.project.evaluateBinary([...await this.loadHistory(), ...newEvents]) :
        await this.project.extend(this.state, events);
      try {
        for (const e of events) if (!prospective.eligible.has(e.id)) throw new AuthorizationError("Event permission revoked");
        const validation = await BinaryProjection.create(this.project.descriptor.policies);
        try { validation.applyAuthorized(prospective.blocks, prospective.roles); } finally { validation.close(); }
      }
      finally { for (const block of prospective.blocks) block.fill(0); }
      newEvents.sort((a, b) => Number(isDataType(a.type)) - Number(isDataType(b.type)) || a.lamport - b.lamport || a.sequence - b.sequence);
      let applied = 0;
      for (const event of newEvents) {
        const state = isDataType(event.type) ? await this.project.extend(this.state, [event]) :
          await this.project.evaluateBinary([...await this.loadHistory(), event]);
        await this.commit(event, "remote", state, false, materialize); applied++;
      }
      const receipt = { applied, summary: this.index.summary(), lamport: this.lamport, revision: this.eventCount };
      return materialize ? { applied: receipt.applied, summary: receipt.summary, snapshot: this.getView() } : receipt;
  }
  close(): Promise<void> {
    this.closing = true; this.listeners.clear();
    for (const id of this.queryCursors.keys()) this.dropQueryCursor(id);
    for (const id of this.syncCursors.keys()) this.dropSyncCursor(id);
    return this.enqueue(async () => {
      this.recoveryEngine?.cancel();
      for (const id of this.queryCursors.keys()) this.dropQueryCursor(id);
      this.discoveryCertificates.clear();
      // Accepted operations may have opened a cursor after close() was queued.
      for (const id of this.syncCursors.keys()) this.dropSyncCursor(id);
      try { await this.store.close(); } finally { this.identity = null; this.projector.close(); this.project.close(); for (const key of this.state.keys.values()) key.bytes.fill(0); }
    });
  }
  private operation<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Core is closing"));
    return this.enqueue(() => { if (this.failure !== undefined) throw new Error("Core is faulted; close and reopen", { cause: this.failure }); return fn(); });
  }
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
}
