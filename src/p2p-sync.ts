import { encodeWire, decodeWire } from "./binary-events.js";
import type { IEvent, ISyncCore, SyncSummary } from "./types.js";
import { CHUNK_BYTES, CHUNK_OVERHEAD, normalizeChunkRequest, chunkHash,
  type ChunkRequest, type IChunkProvider } from "./storage-format.js";

export type P2PState = "offline" | "connecting" | "syncing" | "online" | "stopped";
export interface P2PSyncOptions {
  roomId: string;
  signalingUrl: string;
  /** Explicit deployment configuration: no implicit third-party STUN/TURN service. */
  iceServers?: RTCIceServer[];
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  acknowledgementTimeoutMs?: number;
  onError?: (error: Error) => void;
  /** Defaults to core.serveChunk when supported; cryptography/storage stay in its Worker. */
  storage?: IChunkProvider;
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
  id: string;
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  candidates: RTCIceCandidateInit[];
  closed: boolean;
  sendQueue: Promise<void>;
  receiveQueue: Promise<void>;
  outboundQueue: Promise<void>;
  helloSent: Promise<void>;
  acks: Map<string, PendingAck>;
  sendId: number;
  receiveId: number;
  assembly: Assembly | null;
  sawHello: boolean;
  sentDone: boolean;
  receivedDone: boolean;
  deadline: number | null;
  disconnectTimer: number | null;
  chunk: { requestId: string; hash: string; resolve: (bytes: Uint8Array<ArrayBuffer>) => void; reject: (error: Error) => void; cleanup: () => void } | null;
  servingChunk: boolean;
  queuedReceives: number;
}

const MAGIC = 0x31505353; // SSP1
const FRAME_HEADER = 16;
const FRAME_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;

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

/** Two-peer transport. All durable state, incoming event validation and CRDT work belong to ISyncCore. */
export class P2PSync {
  private socket: WebSocket | null = null;
  private pair: Pair | null = null;
  private running = false;
  private manualChannel = false;
  private chunkQueue: Promise<void> = Promise.resolve();
  private queuedChunkRequests = 0;
  private retryTimer: number | null = null;
  private socketDeadline: number | null = null;
  private retryAttempt = 0;
  private unsubscribe: (() => void) | null = null;
  private currentState: P2PState = "offline";
  private errorMessage: string | null = null;
  private readonly observers = new Set<(state: P2PState) => void>();
  private readonly counters: P2PStats = { eventsSent: 0, eventsReceived: 0, eventsApplied: 0, batchesSent: 0, pairings: 0, chunksRequested: 0, chunksSent: 0, chunksReceived: 0 };
  private readonly options: Required<Omit<P2PSyncOptions, "onError" | "storage">> & Pick<P2PSyncOptions, "onError" | "storage">;
  private readonly wake = () => { if (this.running && !this.isOpen()) this.reconnect(); };

  constructor(private readonly core: ISyncCore, options: P2PSyncOptions) {
    if (!/^[A-Za-z0-9_-]{22,128}$/.test(options.roomId)) throw new TypeError("Use a random 22–128 character room token");
    if (!["ws:", "wss:"].includes(new URL(options.signalingUrl).protocol)) throw new TypeError("A WebSocket URL is required");
    this.options = {
      ...options,
      iceServers: options.iceServers ?? [],
      reconnectBaseMs: options.reconnectBaseMs ?? 250,
      reconnectMaxMs: options.reconnectMaxMs ?? 15000,
      acknowledgementTimeoutMs: options.acknowledgementTimeoutMs ?? 15000,
    };
    for (const value of [this.options.reconnectBaseMs, this.options.reconnectMaxMs, this.options.acknowledgementTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError("Timeouts must be positive");
    }
  }

  get state(): P2PState { return this.currentState; }
  get lastError(): string | null { return this.errorMessage; }
  get stats(): Readonly<P2PStats> { return { ...this.counters }; }

  onStateChange(observer: (state: P2PState) => void): () => void {
    this.observers.add(observer);
    observer(this.currentState);
    return () => { this.observers.delete(observer); };
  }

  start(): void {
    if (this.running) return;
    this.manualChannel = false;
    this.running = true;
    this.watchCommits();
    globalThis.addEventListener("online", this.wake);
    this.connectSocket();
  }
  private watchCommits(): void {
    this.unsubscribe = this.core.onCommit(notification => {
      // Imported events are not echoed. Reconnection anti-entropy handles missed local commits.
      const pair = this.pair;
      if (notification.source !== "local" || !pair || pair.channel?.readyState !== "open") return;
      this.outbound(pair, async () => {
        await pair.helloSent;
        await this.sendBatch(pair, [notification.event]);
      });
    });
  }
  /** Existing reliable DataChannel integration; also permits deterministic channel mocks. */
  connectDataChannel(channel: RTCDataChannel, connection: RTCPeerConnection | null = null): void {
    if (this.running) throw new Error("Stop the transport before supplying a DataChannel");
    this.running = true; this.manualChannel = true; this.watchCommits();
    const pair = this.makePair(crypto.randomUUID(), connection); this.pair = pair;
    this.counters.pairings++; this.setState("connecting"); this.attachChannel(pair, channel);
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

  stop(): void {
    this.running = false;
    this.unsubscribe?.(); this.unsubscribe = null;
    globalThis.removeEventListener?.("online", this.wake);
    this.clearRetry();
    this.closePair();
    const socket = this.socket; this.socket = null;
    socket?.close();
    this.setState("stopped");
  }

  /** Force a new pairing; normal socket/ICE failures call the same recovery path automatically. */
  reconnect(): void {
    if (!this.running) return;
    if (this.manualChannel) { this.stop(); return; }
    this.clearRetry();
    this.closePair();
    const socket = this.socket; this.socket = null;
    socket?.close();
    this.connectSocket();
  }

  private connectSocket(): void {
    if (!this.running) return;
    if (!this.isOpen()) this.setState("connecting");
    const socket = new WebSocket(this.options.signalingUrl);
    this.socket = socket;
    let signalQueue: Promise<void> = Promise.resolve();
    this.socketDeadline = globalThis.setTimeout(() => {
      if (this.socket === socket) socket.close();
    }, 10000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (this.socketDeadline !== null) globalThis.clearTimeout(this.socketDeadline);
      this.socketDeadline = null;
      socket.send(JSON.stringify({ kind: "join", roomId: this.options.roomId }));
    };
    socket.onmessage = event => {
      signalQueue = signalQueue.then(async () => {
        if (this.socket === socket) await this.handleSignal(JSON.parse(event.data));
      }).catch(error => {
        if (this.socket === socket) this.fail(this.pair, errorOf(error));
      });
    };
    socket.onerror = () => { /* onclose schedules retry; no application payload uses this socket. */ };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.socketDeadline !== null) globalThis.clearTimeout(this.socketDeadline);
      this.socketDeadline = null;
      // An established data channel can continue during a signaling outage.
      if (!this.isOpen()) { this.closePair(); this.setState("offline"); }
      this.scheduleRetry();
    };
  }

  private async handleSignal(message: Record<string, unknown>): Promise<void> {
    if (message.kind === "joined") return;
    if (message.kind === "waiting") {
      if (!this.isOpen()) { this.closePair(); this.setState("offline"); }
      return;
    }
    if (message.kind === "paired") {
      if (typeof message.session !== "string" || typeof message.offerer !== "boolean") throw new Error("Invalid pairing");
      await this.beginPair(message.session, message.offerer);
      return;
    }
    const pair = this.pair;
    if (message.kind !== "signal" || !pair || message.session !== pair.id) return;
    if (!pair.pc) throw new Error("An externally supplied channel has no signaling connection");
    if (typeof message.body !== "string") throw new Error("Invalid signaling body");
    const signal = JSON.parse(message.body);
    if (signal.type === "description") {
      if (!["offer", "answer"].includes(signal.description?.type) || typeof signal.description.sdp !== "string") {
        throw new Error("Invalid session description");
      }
      await pair.pc.setRemoteDescription(signal.description);
      this.assertPair(pair);
      for (const candidate of pair.candidates.splice(0)) await pair.pc.addIceCandidate(candidate);
      if (signal.description.type === "offer") {
        await pair.pc.setLocalDescription(await pair.pc.createAnswer());
        this.sendSignal(pair, { type: "description", description: pair.pc.localDescription });
      }
    } else if (signal.type === "candidate") {
      if (!signal.candidate || typeof signal.candidate.candidate !== "string") throw new Error("Invalid ICE candidate");
      if (pair.pc.remoteDescription) await pair.pc.addIceCandidate(signal.candidate);
      else {
        if (pair.candidates.length >= 256) throw new Error("Too many pending ICE candidates");
        pair.candidates.push(signal.candidate);
      }
    } else throw new Error("Unknown signaling body");
  }

  private async beginPair(id: string, offerer: boolean): Promise<void> {
    this.closePair();
    this.setState("connecting");
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const pair = this.makePair(id, pc);
    this.pair = pair;
    this.counters.pairings++;
    pair.deadline = globalThis.setTimeout(() => this.fail(pair, new Error("Peer connection timed out; check STUN/TURN configuration")), 20000);
    pc.onicecandidate = event => {
      if (!event.candidate || pair.closed) return;
      try { this.sendSignal(pair, { type: "candidate", candidate: event.candidate.toJSON() }); }
      catch (error) { this.fail(pair, errorOf(error)); }
    };
    pc.onconnectionstatechange = () => {
      if (pair.closed) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.fail(pair, new Error(`Peer connection ${pc.connectionState}`));
      } else if (pc.connectionState === "disconnected") {
        this.setState("offline");
        if (pair.disconnectTimer === null) pair.disconnectTimer = globalThis.setTimeout(() => {
          this.fail(pair, new Error("Peer remained disconnected"));
        }, 2000);
      } else if (pc.connectionState === "connected") {
        if (pair.disconnectTimer !== null) globalThis.clearTimeout(pair.disconnectTimer);
        pair.disconnectTimer = null;
        this.maybeOnline(pair);
      }
    };
    pc.ondatachannel = event => {
      if (pair.closed) { event.channel.close(); return; }
      if (offerer || pair.channel || event.channel.label !== "events-v1") {
        event.channel.close(); this.fail(pair, new Error("Unexpected data channel")); return;
      }
      this.attachChannel(pair, event.channel);
    };
    if (offerer) {
      this.attachChannel(pair, pc.createDataChannel("events-v1", { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      this.sendSignal(pair, { type: "description", description: pc.localDescription });
    }
  }
  private makePair(id: string, pc: RTCPeerConnection | null): Pair {
    return {
      id, pc, channel: null, candidates: [], closed: false,
      sendQueue: Promise.resolve(), receiveQueue: Promise.resolve(), outboundQueue: Promise.resolve(),
      helloSent: Promise.resolve(), acks: new Map(), sendId: 0, receiveId: 0, assembly: null,
      sawHello: false, sentDone: false, receivedDone: false, deadline: null, disconnectTimer: null,
      chunk: null, servingChunk: false, queuedReceives: 0,
    };
  }

  private attachChannel(pair: Pair, channel: RTCDataChannel): void {
    pair.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    let openedOnce = false;
    const opened = () => {
      if (pair.closed || openedOnce) return;
      openedOnce = true;
      if (!channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
        this.fail(pair, new Error("Reliable ordered delivery is required")); return;
      }
      if (pair.deadline !== null) globalThis.clearTimeout(pair.deadline);
      pair.deadline = globalThis.setTimeout(() => this.fail(pair, new Error("Sync handshake timed out")), 20000);
      this.setState("syncing");
      pair.helloSent = this.core.getSyncSummary().then(summary => this.send(pair, { v: 2, type: "hello", summary }));
      pair.helloSent.catch(error => this.fail(pair, errorOf(error)));
    };
    channel.onopen = opened;
    channel.onmessage = event => {
      if (pair.closed) return;
      try {
        const message = this.receiveFrame(pair, event.data);
        if (!message) return;
        if (++pair.queuedReceives > 32) throw new Error("Peer receive queue exceeded bounded capacity");
        pair.receiveQueue = pair.receiveQueue.then(async () => {
          try { this.assertPair(pair); await this.handleWire(pair, message); }
          finally { pair.queuedReceives--; }
        }).catch(error => this.fail(pair, errorOf(error)));
      } catch (error) { this.fail(pair, errorOf(error)); }
    };
    channel.onclose = () => this.fail(pair, new Error("Data channel closed"));
    channel.onerror = () => this.fail(pair, new Error("Data channel error"));
    if (channel.readyState === "open") queueMicrotask(opened);
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
      if (pair.servingChunk) throw new Error("Only one chunk may be served at a time");
      const provider = this.options.storage ?? ("serveChunk" in this.core ? this.core as ISyncCore & IChunkProvider : undefined);
      pair.servingChunk = true;
      // Never block the receive queue on a response send: the opposite direction needs ACK/pull processing.
      void (async () => {
        let data: Uint8Array<ArrayBuffer> | null = null;
        try { data = provider ? await provider.serveChunk(message.request) : null; } catch { /* Uniform unavailable/unauthorized reply. */ }
        if (data && data.length > CHUNK_BYTES + CHUNK_OVERHEAD) throw new Error("Provider exceeded chunk limit");
        await this.send(pair, { v: 2, type: "CHUNK_RESPONSE", requestId: message.request.requestId, hash: message.request.hash, data });
        if (data) this.counters.chunksSent++;
      })().catch(error => this.fail(pair, errorOf(error))).finally(() => { pair.servingChunk = false; });
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
      await this.send(pair, { v: 2, type: "ack", batchId: message.batchId });
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
    const result = pair.sendQueue.then(async () => {
      this.assertPair(pair);
      const bytes = encodeWire(message);
      if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("Sync message exceeds 2 MiB");
      const channel = pair.channel!;
      const negotiated = pair.pc?.sctp?.maxMessageSize;
      const frameBytes = Math.min(FRAME_BYTES, negotiated && negotiated > 0 ? negotiated : FRAME_BYTES);
      if (frameBytes <= FRAME_HEADER) throw new Error("Negotiated SCTP message size too small");
      const id = ++pair.sendId;
      if (id > 0xffffffff) throw new Error("Transport message counter exhausted");
      for (let offset = 0; offset < bytes.length; offset += frameBytes - FRAME_HEADER) {
        this.assertPair(pair);
        if (channel.bufferedAmount > HIGH_WATER) await this.waitForDrain(pair, channel);
        this.assertPair(pair);
        if (channel.readyState !== "open") throw new Error("Data channel is not open");
        const payload = bytes.subarray(offset, offset + frameBytes - FRAME_HEADER);
        const frame = new Uint8Array(FRAME_HEADER + payload.length);
        const header = new DataView(frame.buffer);
        header.setUint32(0, MAGIC, true); header.setUint32(4, id, true);
        header.setUint32(8, bytes.length, true); header.setUint32(12, offset, true);
        frame.set(payload, FRAME_HEADER);
        channel.send(frame);
      }
    });
    pair.sendQueue = result.catch(() => {});
    return result;
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

  private waitForDrain(pair: Pair, channel: RTCDataChannel): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        globalThis.clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", drained);
        channel.removeEventListener("close", closed);
      };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error("Channel closed during backpressure")); };
      const timer = globalThis.setTimeout(() => { cleanup(); reject(new Error("Data channel stalled")); }, 15000);
      channel.addEventListener("bufferedamountlow", drained);
      channel.addEventListener("close", closed);
      if (pair.closed || channel.readyState !== "open") closed();
      else if (channel.bufferedAmount <= LOW_WATER) drained();
    });
  }

  private outbound(pair: Pair, operation: () => Promise<void>): void {
    pair.outboundQueue = pair.outboundQueue.then(async () => {
      this.assertPair(pair);
      await operation();
    }).catch(error => this.fail(pair, errorOf(error)));
  }

  private sendSignal(pair: Pair, body: unknown): void {
    this.assertPair(pair);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Signaling unavailable during negotiation");
    this.socket.send(JSON.stringify({ kind: "signal", session: pair.id, body: JSON.stringify(body) }));
  }

  private maybeOnline(pair: Pair): void {
    if (pair.closed || pair.channel?.readyState !== "open" || !pair.sentDone || !pair.receivedDone) return;
    if (pair.deadline !== null) globalThis.clearTimeout(pair.deadline);
    pair.deadline = null;
    this.retryAttempt = 0;
    this.errorMessage = null;
    this.setState("online");
  }

  private assertPair(pair: Pair): void {
    if (!this.running || pair.closed || this.pair !== pair) throw new Error("Pairing was replaced");
  }

  private fail(pair: Pair | null, error: Error): void {
    if (!this.running || (pair && (pair.closed || this.pair !== pair))) return;
    this.errorMessage = error.message;
    try { this.options.onError?.(error); } catch { /* Isolate observers. */ }
    this.closePair();
    this.setState("offline");
    const socket = this.socket; this.socket = null;
    socket?.close();
    if (this.manualChannel) { this.running = false; this.unsubscribe?.(); this.unsubscribe = null; return; }
    this.scheduleRetry();
  }

  private closePair(): void {
    const pair = this.pair; this.pair = null;
    if (!pair) return;
    pair.closed = true;
    if (pair.deadline !== null) globalThis.clearTimeout(pair.deadline);
    if (pair.disconnectTimer !== null) globalThis.clearTimeout(pair.disconnectTimer);
    for (const ack of pair.acks.values()) {
      globalThis.clearTimeout(ack.timer); ack.reject(new Error("Pairing closed before acknowledgement"));
    }
    pair.acks.clear(); pair.assembly = null;
    if (pair.chunk) { pair.chunk.cleanup(); pair.chunk.reject(new Error("Pairing closed during chunk pull")); pair.chunk = null; }
    pair.channel?.close(); pair.pc?.close();
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer !== null) return;
    const delay = Math.min(this.options.reconnectMaxMs, this.options.reconnectBaseMs * 2 ** Math.min(this.retryAttempt++, 16));
    this.retryTimer = globalThis.setTimeout(() => {
      this.retryTimer = null;
      this.connectSocket();
    }, delay * (0.8 + Math.random() * 0.4));
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) globalThis.clearTimeout(this.retryTimer);
    if (this.socketDeadline !== null) globalThis.clearTimeout(this.socketDeadline);
    this.retryTimer = null; this.socketDeadline = null;
  }

  private isOpen(): boolean { return this.pair?.channel?.readyState === "open"; }

  private setState(state: P2PState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const observer of this.observers) {
      try { observer(state); } catch { /* Isolate observers. */ }
    }
  }
}
