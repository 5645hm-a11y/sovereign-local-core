import { SyncSession } from "./sync-session.js";
import { rtcByteLink } from "./rtc-byte-link.js";
import type { ISyncCore } from "./types.js";
import type { ChunkRequest, IChunkProvider } from "./storage-format.js";

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

interface Pair { id: string; pc: RTCPeerConnection | null; channel: RTCDataChannel | null; candidates: RTCIceCandidateInit[]; closed: boolean; deadline: number | null; disconnectTimer: number | null; session: SyncSession | null; }
function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
/** Two-peer transport. All durable state, incoming event validation and CRDT work belong to ISyncCore. */
export class P2PSync {
  private socket: WebSocket | null = null;
  private pair: Pair | null = null;
  private running = false;
  private manualChannel = false;
  private retryTimer: number | null = null;
  private socketDeadline: number | null = null;
  private retryAttempt = 0;
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
  get stats(): Readonly<P2PStats> { const stats = { ...this.counters }, live = this.pair?.session?.stats; if (live) for (const key of Object.keys(live) as (keyof P2PStats)[]) if (key !== "pairings") stats[key] += live[key]; return stats; }

  onStateChange(observer: (state: P2PState) => void): () => void {
    this.observers.add(observer);
    observer(this.currentState);
    return () => { this.observers.delete(observer); };
  }

  start(): void {
    if (this.running) return;
    this.manualChannel = false;
    this.running = true;
    globalThis.addEventListener("online", this.wake);
    this.connectSocket();
  }
  /** Existing reliable DataChannel integration; also permits deterministic channel mocks. */
  connectDataChannel(channel: RTCDataChannel, connection: RTCPeerConnection | null = null): void {
    if (this.running) throw new Error("Stop the transport before supplying a DataChannel");
    this.running = true; this.manualChannel = true;
    const pair = this.makePair(crypto.randomUUID(), connection); this.pair = pair;
    this.counters.pairings++; this.setState("connecting"); this.attachChannel(pair, channel);
  }
  requestChunk(value: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return this.pair?.session?.requestChunk(value, signal) ?? Promise.reject(new Error("No online peer for chunk request"));
  }
  stop(): void {
    this.running = false;
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
  private makePair(id: string, pc: RTCPeerConnection | null): Pair { return { id, pc, channel: null, candidates: [], closed: false, deadline: null, disconnectTimer: null, session: null }; }
  private attachChannel(pair: Pair, channel: RTCDataChannel): void {
    pair.channel = channel; let openedOnce = false;
    const opened = () => {
      if (pair.closed || openedOnce) return; openedOnce = true;
      try {
        if (pair.deadline !== null) clearTimeout(pair.deadline); pair.deadline = null;
        const session = new SyncSession(this.core, { acknowledgementTimeoutMs: this.options.acknowledgementTimeoutMs,
          ...(this.options.storage ? { storage: this.options.storage } : {}), onError: error => this.fail(pair, error) });
        pair.session = session;
        session.onStateChange(state => { if (pair.closed) return; if (state === "online") this.maybeOnline(pair); else if (state === "syncing") this.setState(state); });
        session.connect(rtcByteLink(channel, pair.pc));
      } catch (error) { this.fail(pair, errorOf(error)); }
    };
    channel.onopen = opened; channel.onclose = () => this.fail(pair, new Error("Data channel closed")); channel.onerror = () => this.fail(pair, new Error("Data channel error"));
    if (channel.readyState === "open") queueMicrotask(opened);
  }
  private sendSignal(pair: Pair, body: unknown): void {
    this.assertPair(pair);
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Signaling unavailable during negotiation");
    this.socket.send(JSON.stringify({ kind: "signal", session: pair.id, body: JSON.stringify(body) }));
  }

  private maybeOnline(pair: Pair): void {
    if (pair.closed || pair.session?.state !== "online") return;
    this.retryAttempt = 0; this.errorMessage = null; this.setState("online");
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
    if (this.manualChannel) { this.running = false; return; }
    this.scheduleRetry();
  }

  private closePair(): void {
    const pair = this.pair; this.pair = null;
    if (!pair) return;
    pair.closed = true;
    if (pair.deadline !== null) globalThis.clearTimeout(pair.deadline);
    if (pair.disconnectTimer !== null) globalThis.clearTimeout(pair.disconnectTimer);
    if (pair.session) { const stats = pair.session.stats; for (const key of Object.keys(stats) as (keyof P2PStats)[]) if (key !== "pairings") this.counters[key] += stats[key]; pair.session.stop(); }
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
