import { encodeWire, decodeWire } from "./binary-events.js";
import type { IEvent, ISyncCore, SyncSummary } from "./types.js";
import { CHUNK_BYTES, CHUNK_OVERHEAD, normalizeChunkRequest, chunkHash,
  type ChunkRequest, type IChunkProvider } from "./storage-format.js";
export type P2PState = "offline" | "connecting" | "syncing" | "online" | "stopped";
export interface ByteLink {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly maxFrameBytes?: number;
  close(): void | Promise<void>;
}
export interface SyncSessionOptions {
  /** Mesh relaying: imported durable commits are forwarded; dedup suppresses loops. */
  forwardRemote?: boolean;
  acknowledgementTimeoutMs?: number;
  storage?: IChunkProvider;
  onError?: (error: Error) => void;
}
export interface P2PStats {
  eventsSent: number;
  eventsReceived: number;
  eventsApplied: number;
  batchesSent: number;
  pairings: number;
  chunksRequested: number;
  chunksSent: number;
  chunksReceived: number;
}

type WireMessage =
  | { v: 2; type: "hello"; summary: SyncSummary }
  | { v: 2; type: "batch"; batchId: string; events: readonly unknown[] }
  | { v: 2; type: "ack"; batchId: string }
  | { v: 2; type: "done" }
  | { v: 2; type: "CHUNK_REQUEST"; request: ChunkRequest }
  | { v: 2; type: "CHUNK_RESPONSE"; requestId: string; hash: string; data: Uint8Array<ArrayBuffer> | null };
interface PendingAck { resolve: () => void; reject: (error: Error) => void; timer: number }
interface Assembly { id: number; bytes: Uint8Array; offset: number }
interface Pair {
  closed: boolean; sendQueue: Promise<void>; outboundQueue: Promise<void>; helloSent: Promise<void>;
  acks: Map<string, PendingAck>; sendId: number; receiveId: number; assembly: Assembly | null;
  sawHello: boolean; sentDone: boolean; receivedDone: boolean; deadline: number | null;
  chunk: { requestId: string; hash: string; resolve: (bytes: Uint8Array<ArrayBuffer>) => void; reject: (error: Error) => void; cleanup: () => void } | null;
  servingChunks: number; chunkServeQueue: Promise<void>;
}
const MAGIC = 0x31505353; // SSP1
const FRAME_HEADER = 16;
const FRAME_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function wireMessage(value: unknown): WireMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sync envelope");
  const message = value as Record<string, unknown>;
  if (message.v !== 2) throw new Error("Unsupported sync version");
  if (message.type === "hello" && message.summary && typeof message.summary === "object") {
    // The core, not the transport, validates the actual watermark map.
    return message as unknown as WireMessage;
  }
  if (message.type === "done") return { v: 2, type: "done" };
  if (message.type === "CHUNK_REQUEST") return { v: 2, type: message.type, request: normalizeChunkRequest(message.request) };
  if (message.type === "CHUNK_RESPONSE") {
    if (typeof message.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(message.requestId) ||
        (message.data !== null && (!(message.data instanceof Uint8Array) || message.data.length < CHUNK_OVERHEAD || message.data.length > CHUNK_BYTES + CHUNK_OVERHEAD))) throw new Error("Invalid chunk response");
    return { v: 2, type: message.type, requestId: message.requestId, hash: chunkHash(message.hash), data: message.data as Uint8Array<ArrayBuffer> | null };
  }
  if (typeof message.batchId !== "string" || message.batchId.length > 64) throw new Error("Invalid batch id");
  if (message.type === "ack") return { v: 2, type: "ack", batchId: message.batchId };
  if (message.type === "batch" && Array.isArray(message.events) && message.events.length <= 64) {
    return { v: 2, type: "batch", batchId: message.batchId, events: message.events };
  }
  throw new Error("Invalid sync message");
}

/** Binary sync over any ordered byte stream. Never stores or materializes data. */
export class SyncSession {
  private pair: Pair | null = null; private running = false; private link: ByteLink | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private unsubscribe: (() => void) | null = null;
  private chunkQueue: Promise<void> = Promise.resolve(); private queuedChunkRequests = 0;
  private pendingOutbound = 0;
  private pendingSends = 0;
  private currentState: P2PState = "offline"; private errorMessage: string | null = null;
  private readonly observers = new Set<(state: P2PState) => void>();
  private readonly counters: P2PStats = { eventsSent: 0, eventsReceived: 0, eventsApplied: 0, batchesSent: 0, pairings: 0, chunksRequested: 0, chunksSent: 0, chunksReceived: 0 };
  private readonly options: SyncSessionOptions & { acknowledgementTimeoutMs: number };
  constructor(private readonly core: ISyncCore, options: SyncSessionOptions = {}) {
    this.options = { ...options, acknowledgementTimeoutMs: options.acknowledgementTimeoutMs ?? 15000 };
    if (!Number.isFinite(this.options.acknowledgementTimeoutMs) || this.options.acknowledgementTimeoutMs <= 0) throw new TypeError("Invalid ACK timeout");
  }
  get state(): P2PState { return this.currentState; }
  get lastError(): string | null { return this.errorMessage; }
  get stats(): Readonly<P2PStats> { return { ...this.counters }; }
  onStateChange(observer: (state: P2PState) => void): () => void { this.observers.add(observer); observer(this.currentState); return () => { this.observers.delete(observer); }; }
  connect(link: ByteLink): void {
    if (this.running) throw new Error("Stop the session before supplying another link");
    const size = link.maxFrameBytes ?? FRAME_BYTES;
    if (!Number.isInteger(size) || size <= FRAME_HEADER || size > FRAME_BYTES) throw new Error("Invalid link frame bound");
    this.link = link; this.reader = link.readable.getReader(); this.writer = link.writable.getWriter(); this.running = true;
    const pair: Pair = { closed: false, sendQueue: Promise.resolve(), outboundQueue: Promise.resolve(), helloSent: Promise.resolve(),
      acks: new Map(), sendId: 0, receiveId: 0, assembly: null, sawHello: false, sentDone: false, receivedDone: false,
      deadline: null, chunk: null, servingChunks: 0, chunkServeQueue: Promise.resolve() };
    this.pair = pair; this.counters.pairings++; this.watchCommits(); this.setState("syncing");
    pair.deadline = globalThis.setTimeout(() => this.fail(pair, new Error("Sync handshake timed out")), 20000);
    pair.helloSent = this.core.getSyncSummary().then(summary => this.send(pair, { v: 2, type: "hello", summary }));
    void pair.helloSent.catch(error => this.fail(pair, errorOf(error)));
    void this.readLoop(pair, this.reader).catch(error => this.fail(pair, errorOf(error)));
  }
  private async readLoop(pair: Pair, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const prefix = new Uint8Array(4); let prefixAt = 0, frame: Uint8Array | null = null, frameAt = 0;
    while (!pair.closed) {
      const { value, done } = await reader.read(); this.assertPair(pair);
      if (done) throw new Error("Byte stream closed");
      if (!(value instanceof Uint8Array) || value.length > 4 * 1024 * 1024) throw new Error("Invalid or oversized stream chunk");
      let offset = 0;
      while (offset < value.length) {
        if (!frame) {
          const count = Math.min(4 - prefixAt, value.length - offset); prefix.set(value.subarray(offset, offset + count), prefixAt); prefixAt += count; offset += count;
          if (prefixAt !== 4) continue;
          const length = new DataView(prefix.buffer).getUint32(0, true);
          if (length <= FRAME_HEADER || length > FRAME_BYTES) throw new Error("Invalid stream frame length");
          frame = new Uint8Array(length); frameAt = 0; prefixAt = 0;
        }
        const count = Math.min(frame.length - frameAt, value.length - offset); frame.set(value.subarray(offset, offset + count), frameAt); frameAt += count; offset += count;
        if (frameAt === frame.length) {
          const message = this.receiveFrame(pair, frame.buffer); frame = null;
          if (message) { this.assertPair(pair); await this.handleWire(pair, message); }
        }
      }
    }
  }
  private watchCommits(): void {
    this.unsubscribe = this.core.onCommit(notification => {
      // Deduplicated imports emit no commit, so forwarding cannot create an infinite echo.
      const pair = this.pair;
      if ((!this.options.forwardRemote && notification.source !== "local") || !pair || pair.closed) return;
      this.outbound(pair, async () => {
        await pair.helloSent;
        await this.sendBatch(pair, [notification.event]);
      });
    });
  }
  /** Serialize concurrent file readers; at most eight small requests wait, one chunk is active. */
  async requestChunk(value: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    const request = normalizeChunkRequest(value);
    if (this.queuedChunkRequests >= 8) throw new Error("Chunk pull queue is full");
    this.queuedChunkRequests++;
    const result = this.chunkQueue.then(() => this.pullChunk(request, signal));
    this.chunkQueue = result.then(() => {}, () => {});
    try { return await result; } finally { this.queuedChunkRequests--; }
  }
  /** Exactly one outstanding chunk pull per pair, keeping large transfers bounded. */
  private async pullChunk(value: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    const request = normalizeChunkRequest(value), pair = this.pair;
    if (!pair || this.currentState !== "online" || pair.closed) throw new Error("No online peer for chunk request");
    if (pair.chunk) throw new Error("A chunk request is already outstanding for this peer");
    return new Promise((resolve, reject) => {
      const finish = (error: Error) => {
        if (pair.chunk?.requestId !== request.requestId) return;
        pair.chunk.cleanup(); pair.chunk = null; reject(error);
      };
      const abort = () => finish(errorOf(signal?.reason ?? new Error("Chunk request aborted")));
      const timer = globalThis.setTimeout(() => finish(new Error("Chunk request timed out")), this.options.acknowledgementTimeoutMs);
      const cleanup = () => { globalThis.clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      pair.chunk = { requestId: request.requestId, hash: request.hash, resolve, reject, cleanup };
      signal?.addEventListener("abort", abort, { once: true });
      this.counters.chunksRequested++;
      void this.send(pair, { v: 2, type: "CHUNK_REQUEST", request }).catch(error => finish(errorOf(error)));
    });
  }

  private async handleWire(pair: Pair, message: WireMessage): Promise<void> {
    if (message.type === "CHUNK_RESPONSE") {
      if (!pair.sawHello) throw new Error("Handshake required before chunks");
      const pending = pair.chunk;
      // Late replies after timeout/cancel belong to a completed request, never a new pull.
      if (!pending || pending.requestId !== message.requestId) return;
      pending.cleanup(); pair.chunk = null;
      if (pending.hash !== message.hash || !message.data) pending.reject(new Error("Peer has no matching chunk"));
      else { this.counters.chunksReceived++; pending.resolve(message.data); }
      return;
    }
    if (message.type === "CHUNK_REQUEST") {
      if (!pair.sawHello) throw new Error("Handshake required before chunks");
      // A delivered response can cause the next request before its write Promise
      // settles. Permit one queued successor, but load only one chunk at a time.
      if (pair.servingChunks >= 2) throw new Error("Chunk serve queue is full");
      const provider = this.options.storage ?? ("serveChunk" in this.core ? this.core as ISyncCore & IChunkProvider : undefined);
      pair.servingChunks++;
      // Never block the receive queue on a response send: the opposite direction needs ACK/pull processing.
      const serving = pair.chunkServeQueue.then(async () => {
        this.assertPair(pair);
        let data: Uint8Array<ArrayBuffer> | null = null;
        try { data = provider ? await provider.serveChunk(message.request) : null; } catch { /* Uniform unavailable/unauthorized reply. */ }
        if (data && data.length > CHUNK_BYTES + CHUNK_OVERHEAD) throw new Error("Provider exceeded chunk limit");
        await this.send(pair, { v: 2, type: "CHUNK_RESPONSE", requestId: message.request.requestId, hash: message.request.hash, data });
        if (data) this.counters.chunksSent++;
      }).finally(() => { pair.servingChunks--; });
      pair.chunkServeQueue = serving.catch(error => this.fail(pair, errorOf(error)));
      return;
    }
    if (message.type === "hello") {
      if (pair.sawHello) throw new Error("Repeated handshake");
      pair.sawHello = true;
      if (pair.deadline !== null) globalThis.clearTimeout(pair.deadline);
      pair.deadline = null; // Catch-up is bounded per ACK, not by total log replay time.
      const missing = await this.core.readMissingEvents(message.summary);
      this.assertPair(pair);
      // Do not await ACKs in the receive queue: that would deadlock ACK processing.
      this.outbound(pair, async () => {
        await pair.helloSent;
        for (const batch of this.batches(missing)) await this.sendBatch(pair, batch);
        await this.send(pair, { v: 2, type: "done" });
        pair.sentDone = true;
        this.maybeOnline(pair);
      });
    } else if (message.type === "batch") {
      if (!pair.sawHello) throw new Error("Handshake required before events");
      const result = await this.core.ingestEvents(message.events);
      this.assertPair(pair);
      this.counters.eventsReceived += message.events.length;
      this.counters.eventsApplied += result.applied;
      // Durable ACK: engine validation, append, flush and merge all completed first.
      // Keep reading while the ACK drains. Full-duplex streams can otherwise
      // deadlock when both receive loops wait for each other's writable side.
      void this.send(pair, { v: 2, type: "ack", batchId: message.batchId }).catch(error => this.fail(pair, errorOf(error)));
    } else if (message.type === "ack") {
      const pending = pair.acks.get(message.batchId);
      if (!pending) throw new Error("Unknown acknowledgement");
      pair.acks.delete(message.batchId);
      globalThis.clearTimeout(pending.timer);
      pending.resolve();
    } else {
      if (!pair.sawHello) throw new Error("Handshake required before catch-up completion");
      pair.receivedDone = true;
      this.maybeOnline(pair);
    }
  }

  private *batches(events: readonly IEvent[]): Generator<IEvent[]> {
    let batch: IEvent[] = [];
    let size = 0;
    for (const event of events) {
      const bytes = encodeWire(event).length;
      if (batch.length && (batch.length === 64 || size + bytes > 128 * 1024)) {
        yield batch; batch = []; size = 0;
      }
      batch.push(event); size += bytes;
    }
    if (batch.length) yield batch;
  }

  private async sendBatch(pair: Pair, events: readonly IEvent[]): Promise<void> {
    this.assertPair(pair);
    const batchId = crypto.randomUUID();
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        pair.acks.delete(batchId);
        reject(new Error("Durable acknowledgement timed out"));
      }, this.options.acknowledgementTimeoutMs);
      pair.acks.set(batchId, { resolve, reject, timer });
    });
    this.counters.eventsSent += events.length;
    this.counters.batchesSent++;
    try {
      await Promise.all([this.send(pair, { v: 2, type: "batch", batchId, events }), acknowledged]);
    } finally {
      const pending = pair.acks.get(batchId);
      if (pending) { globalThis.clearTimeout(pending.timer); pair.acks.delete(batchId); }
    }
  }

  private send(pair: Pair, message: WireMessage): Promise<void> {
    if (this.pendingSends >= 32) return Promise.reject(new Error("Bounded sync send queue exceeded"));
    this.pendingSends++;
    const result = pair.sendQueue.then(async () => {
      this.assertPair(pair);
      const bytes = encodeWire(message);
      if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("Sync message exceeds 2 MiB");
      const frameBytes = Math.min(FRAME_BYTES, this.link!.maxFrameBytes ?? FRAME_BYTES);
      if (frameBytes <= FRAME_HEADER) throw new Error("Link frame size too small");
      const id = ++pair.sendId;
      if (id > 0xffffffff) throw new Error("Transport message counter exhausted");
      for (let offset = 0; offset < bytes.length; offset += frameBytes - FRAME_HEADER) {
        this.assertPair(pair);
        this.assertPair(pair);
        const payload = bytes.subarray(offset, offset + frameBytes - FRAME_HEADER);
        const frame = new Uint8Array(FRAME_HEADER + payload.length);
        const header = new DataView(frame.buffer);
        header.setUint32(0, MAGIC, true); header.setUint32(4, id, true);
        header.setUint32(8, bytes.length, true); header.setUint32(12, offset, true);
        frame.set(payload, FRAME_HEADER);
        const framed = new Uint8Array(frame.length + 4);
        new DataView(framed.buffer).setUint32(0, frame.length, true); framed.set(frame, 4);
        await this.writer!.write(framed);
      }
    });
    pair.sendQueue = result.catch(() => {});
    return result.finally(() => { this.pendingSends--; });
  }

  private receiveFrame(pair: Pair, data: unknown): WireMessage | null {
    if (!(data instanceof ArrayBuffer) || data.byteLength <= FRAME_HEADER || data.byteLength > FRAME_BYTES) {
      throw new Error("Invalid transport frame");
    }
    const header = new DataView(data);
    const id = header.getUint32(4, true), total = header.getUint32(8, true), offset = header.getUint32(12, true);
    if (header.getUint32(0, true) !== MAGIC || total < 1 || total > MAX_MESSAGE_BYTES) throw new Error("Invalid frame header");
    if (!pair.assembly) {
      if (id !== pair.receiveId + 1 || offset !== 0) throw new Error("Unexpected transport sequence");
      pair.assembly = { id, bytes: new Uint8Array(total), offset: 0 };
    }
    const assembly = pair.assembly;
    const payload = new Uint8Array(data, FRAME_HEADER);
    if (assembly.id !== id || assembly.bytes.length !== total || offset !== assembly.offset || offset + payload.length > total) {
      throw new Error("Invalid fragment ordering");
    }
    assembly.bytes.set(payload, offset); assembly.offset += payload.length;
    if (assembly.offset !== total) return null;
    pair.assembly = null; pair.receiveId = id;
    return wireMessage(decodeWire(assembly.bytes));
  }

  private outbound(pair: Pair, operation: () => Promise<void>): void {
    if (this.pendingOutbound >= 32) { this.fail(pair, new Error("Live sync queue exceeded bounded capacity; reconnect for durable catch-up")); return; }
    this.pendingOutbound++;
    pair.outboundQueue = pair.outboundQueue.then(async () => {
      this.assertPair(pair);
      await operation();
    }).catch(error => this.fail(pair, errorOf(error))).finally(() => { this.pendingOutbound--; });
  }

  stop(): void {
    this.running = false; this.unsubscribe?.(); this.unsubscribe = null;
    const pair = this.pair; this.pair = null;
    if (pair) {
      pair.closed = true; if (pair.deadline !== null) clearTimeout(pair.deadline);
      for (const ack of pair.acks.values()) { clearTimeout(ack.timer); ack.reject(new Error("Pairing closed before acknowledgement")); }
      pair.acks.clear(); pair.assembly = null;
      if (pair.chunk) { pair.chunk.cleanup(); pair.chunk.reject(new Error("Pairing closed during chunk pull")); pair.chunk = null; }
    }
    const reader = this.reader, writer = this.writer, link = this.link;
    this.reader = null; this.writer = null; this.link = null;
    void reader?.cancel().catch(() => {}).finally(() => reader.releaseLock());
    void writer?.abort().catch(() => {}).finally(() => writer.releaseLock());
    if (link) void Promise.resolve(link.close()).catch(() => {});
    this.setState("stopped");
  }
  private maybeOnline(pair: Pair): void { if (!pair.closed && pair.sentDone && pair.receivedDone) { this.errorMessage = null; this.setState("online"); } }
  private assertPair(pair: Pair): void { if (!this.running || pair.closed || this.pair !== pair) throw new Error("Pairing was replaced"); }
  private fail(pair: Pair, error: Error): void {
    if (!this.running || pair.closed || this.pair !== pair) return;
    this.errorMessage = error.message; this.stop(); this.setState("offline");
    try { this.options.onError?.(error); } catch { /* Isolate observers. */ }
  }
  private setState(state: P2PState): void {
    if (state === this.currentState) return; this.currentState = state;
    for (const observer of this.observers) try { observer(state); } catch { /* Isolate observers. */ }
  }
}
