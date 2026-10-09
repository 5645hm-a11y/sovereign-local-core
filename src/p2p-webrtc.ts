import { SyncSession, type P2PState, type P2PStats } from "./sync-session.js";
import { rtcByteLink } from "./rtc-byte-link.js";
import { discoveryToken } from "./discovery-crypto.js";
import type { DiscoverySignal, IDiscoveryCore, IDiscoveryProvider, VerifiedDiscoverySignal } from "./discovery-provider.js";
import type { ISyncCore } from "./types.js";
import type { ChunkRequest, IChunkProvider } from "./storage-format.js";

export const GOOGLE_STUN_SERVERS: readonly RTCIceServer[] = Object.freeze([{ urls: "stun:stun.l.google.com:19302" }]);
export interface P2PWebRTCOptions {
  discovery: IDiscoveryProvider;
  /** Overrides Google STUN; [] permits host-only operation. TURN credentials are supplied by the app. */
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** Simultaneous authenticated edges, default 8, maximum 32. */
  maxPeers?: number;
  connectionTimeoutMs?: number;
  acknowledgementTimeoutMs?: number;
  helloIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  storage?: IChunkProvider;
  onError?: (error: Error) => void;
}
export interface MeshPeer { readonly instanceId: string; readonly actorId: string; readonly state: P2PState }
interface Pair {
  id: string; remote: string; actor: string; offerer: boolean; challenge: string; response: string;
  closed: boolean; pc: RTCPeerConnection | null; channel: RTCDataChannel | null; sync: SyncSession | null;
  candidates: RTCIceCandidateInit[]; candidateIds: Set<string>; description: RTCSessionDescriptionInit | null;
  remoteDescription: RTCSessionDescriptionInit | null;
  deadline: ReturnType<typeof setTimeout>; disconnect: ReturnType<typeof setTimeout> | null;
}
const errorOf = (value: unknown) => value instanceof Error ? value : new Error(String(value));
/** Bounded mesh: one authenticated, independently reconnectable SyncSession per peer. */
export class P2PWebRTC {
  private running = false; private generation = 0; private peerId = "";
  private readonly pairs = new Map<string, Pair>();
  private readonly backoff = new Map<string, { attempt: number; until: number }>();
  private get pair(): Pair | null { return this.pairs.values().next().value ?? null; }
  private receiveQueue: Promise<void> = Promise.resolve(); private queued = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private queuedSignals = 0;
  private helloTimer: ReturnType<typeof setInterval> | null = null; private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0; private currentState: P2PState = "offline"; private errorMessage: string | null = null;
  private readonly observers = new Set<(state: P2PState) => void>();
  private readonly counters: P2PStats = { eventsSent: 0, eventsReceived: 0, eventsApplied: 0, batchesSent: 0, pairings: 0, chunksRequested: 0, chunksSent: 0, chunksReceived: 0 };
  readonly discoveryStats = { accepted: 0, rejected: 0, lastRejection: null as string | null };
  private readonly config: Required<Pick<P2PWebRTCOptions, "maxPeers" | "connectionTimeoutMs" | "helloIntervalMs" | "reconnectBaseMs" | "reconnectMaxMs">>;
  private readonly wake = () => { if (this.running) void this.advertise().catch(error => this.report(errorOf(error))); };
  constructor(private readonly core: ISyncCore & IDiscoveryCore, private readonly options: P2PWebRTCOptions) {
    this.config = { maxPeers: options.maxPeers ?? 8, connectionTimeoutMs: options.connectionTimeoutMs ?? 20000, helloIntervalMs: options.helloIntervalMs ?? 3000,
      reconnectBaseMs: options.reconnectBaseMs ?? 500, reconnectMaxMs: options.reconnectMaxMs ?? 15000 };
    if (Object.values(this.config).some(n => !Number.isFinite(n) || n <= 0) || !Number.isInteger(this.config.maxPeers) || this.config.maxPeers > 32) throw new TypeError("Connection intervals must be positive");
    if (options.iceTransportPolicy !== undefined && !["all", "relay"].includes(options.iceTransportPolicy)) throw new TypeError("Invalid ICE policy");
  }
  get state(): P2PState { return this.currentState; }
  get lastError(): string | null { return this.errorMessage; }
  get peers(): readonly MeshPeer[] {
    return Object.freeze([...this.pairs.values()].map(p => Object.freeze({ instanceId: p.remote, actorId: p.actor, state: p.sync?.state ?? "connecting" as P2PState })));
  }
  get stats(): Readonly<P2PStats> {
    const counters = { ...this.counters };
    for (const pair of this.pairs.values()) {
      const current = pair.sync?.stats;
      if (current) for (const key of Object.keys(current) as (keyof P2PStats)[]) if (key !== "pairings") counters[key] += current[key];
    }
    return counters;
  }
  onStateChange(observer: (state: P2PState) => void): () => void { this.observers.add(observer); observer(this.currentState); return () => { this.observers.delete(observer); }; }
  async start(): Promise<void> {
    if (this.running) return; this.running = true; const generation = ++this.generation;
    this.peerId = discoveryToken(); this.setState("connecting"); globalThis.addEventListener?.("online", this.wake);
    try {
      const info = await this.core.getDiscoveryInfo(); this.assertGeneration(generation);
      await this.options.discovery.start(info.topic, packet => {
        if (!this.running || generation !== this.generation) return;
        if (this.queued >= 64) { this.discoveryStats.rejected++; return; }
        this.queued++;
        this.receiveQueue = this.receiveQueue.then(async () => {
          this.assertGeneration(generation);
          let value: VerifiedDiscoverySignal;
          try { value = await this.core.openDiscovery(packet); }
          catch (error) { this.discoveryStats.rejected++; this.discoveryStats.lastRejection = errorOf(error).name; return; }
          this.assertGeneration(generation); this.discoveryStats.accepted++;
          try { await this.receive(value); }
          catch (error) { const pair = this.pairs.get(value.signal.from); if (pair) this.failPair(pair, errorOf(error)); else this.report(errorOf(error)); }
        }).catch(error => { if (this.running && generation === this.generation) this.report(errorOf(error)); }).finally(() => { this.queued--; });
      });
      this.assertGeneration(generation);
      // Presence remains active while online so late joiners can discover edges.
      this.helloTimer = setInterval(this.wake, this.config.helloIntervalMs);
      await this.advertise();
    } catch (error) { if (this.running && generation === this.generation) this.fail(errorOf(error)); throw error; }
  }
  private advertise(): Promise<void> { return this.send({ kind: "hello", from: this.peerId, to: null, session: null, challenge: null, response: null, description: null, candidate: null }); }
  private async receive({ actorId, signal: s }: VerifiedDiscoverySignal): Promise<void> {
    if (s.from === this.peerId || (s.to !== null && s.to !== this.peerId)) return;
    if (s.kind === "hello") {
      if (this.peerId > s.from || !this.canPair(s.from, actorId)) return; // Deterministic offerer.
      const pair = this.pairs.get(s.from) ?? this.makePair(s.from, actorId, true, discoveryToken(), discoveryToken(), "");
      if (pair.actor !== actorId || pair.sync?.state === "online") return;
      if (pair.description) await this.sendPair(pair, "offer", { description: pair.description });
      else if (!pair.pc) await this.sendPair(pair, "challenge");
      return;
    }
    if (s.kind === "challenge") {
      const old = this.pairs.get(s.from);
      if (s.from >= this.peerId || !this.canPair(s.from, actorId) || (old && (old.actor !== actorId || old.id !== s.session))) return;
      const pair = old ?? this.makePair(s.from, actorId, false, s.session!, s.challenge!, discoveryToken());
      if (pair.challenge !== s.challenge || pair.sync?.state === "online") return;
      await this.sendPair(pair, "proof"); return;
    }
    const pair = this.pairs.get(s.from);
    if (!pair || pair.closed || pair.remote !== s.from || pair.actor !== actorId || pair.id !== s.session || pair.challenge !== s.challenge) return;
    if (s.kind === "proof") {
      if (!pair.offerer || (pair.response && pair.response !== s.response)) return;
      pair.response = s.response!;
      if (!pair.pc) {
        const pc = this.connectPeer(pair);
        await pc.setLocalDescription(await pc.createOffer()); this.assertPair(pair);
        pair.description = pc.localDescription!.toJSON(); await this.sendPair(pair, "offer", { description: pair.description });
      }
      return;
    }
    // Both challenges must be echoed before SDP/ICE touches RTCPeerConnection.
    if (!pair.response || pair.response !== s.response) { this.discoveryStats.rejected++; return; }
    if (s.kind === "ice") {
      const candidate = s.candidate!, id = JSON.stringify(candidate);
      if (pair.candidateIds.has(id)) return;
      if (pair.candidateIds.size >= 256) throw new Error("Too many ICE candidates");
      pair.candidateIds.add(id);
      if (pair.pc?.remoteDescription) await pair.pc.addIceCandidate(candidate); else pair.candidates.push(candidate);
      return;
    }
    if (s.kind === "offer" && !pair.offerer) {
      const pc = pair.pc ?? this.connectPeer(pair);
      if (pair.remoteDescription) {
        if (pair.remoteDescription.sdp !== s.description!.sdp) throw new Error("SDP changed within a signed session");
        if (pair.description) await this.sendPair(pair, "answer", { description: pair.description }); return;
      }
      await pc.setRemoteDescription(s.description!); this.assertPair(pair);
      pair.remoteDescription = s.description!; // ICE mutates pc.remoteDescription; retain the signed original.
      for (const candidate of pair.candidates.splice(0)) await pc.addIceCandidate(candidate);
      await pc.setLocalDescription(await pc.createAnswer()); this.assertPair(pair);
      pair.description = pc.localDescription!.toJSON(); await this.sendPair(pair, "answer", { description: pair.description });
    } else if (s.kind === "answer" && pair.offerer && pair.pc) {
      if (pair.remoteDescription) { if (pair.remoteDescription.sdp !== s.description!.sdp) throw new Error("Answer changed within a signed session"); return; }
      await pair.pc.setRemoteDescription(s.description!); this.assertPair(pair);
      pair.remoteDescription = s.description!;
      for (const candidate of pair.candidates.splice(0)) await pair.pc.addIceCandidate(candidate);
    }
  }
  private makePair(remote: string, actor: string, offerer: boolean, id: string, challenge: string, response: string): Pair {
    const pair: Pair = { remote, actor, offerer, id, challenge, response, closed: false, pc: null, channel: null, sync: null, candidates: [], candidateIds: new Set(), description: null, remoteDescription: null,
      deadline: setTimeout(() => { if (this.pairs.get(pair.remote) === pair) this.failPair(pair, new Error("Peer negotiation timed out; check relays and STUN/TURN")); }, this.config.connectionTimeoutMs), disconnect: null };
    this.pairs.set(remote, pair); this.counters.pairings++; this.refreshState(); return pair;
  }
  private connectPeer(pair: Pair): RTCPeerConnection {
    this.assertPair(pair);
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers ?? [...GOOGLE_STUN_SERVERS], iceTransportPolicy: this.options.iceTransportPolicy ?? "all" }); pair.pc = pc;
    pc.onicecandidate = event => {
      if (!event.candidate || pair.closed) return;
      const c = event.candidate.toJSON();
      const candidate = { candidate: c.candidate ?? "", sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, usernameFragment: c.usernameFragment ?? null };
      void this.sendPair(pair, "ice", { candidate }).catch(error => { this.failPair(pair, errorOf(error)); });
    };
    pc.onconnectionstatechange = () => {
      if (pair.closed) return;
      if (["failed", "closed"].includes(pc.connectionState)) this.failPair(pair, new Error(`Peer connection ${pc.connectionState}`));
      else if (pc.connectionState === "disconnected") {
        pair.disconnect ??= setTimeout(() => this.failPair(pair, new Error("Peer remained disconnected")), 2000); this.refreshState();
      } else if (pc.connectionState === "connected") { if (pair.disconnect !== null) clearTimeout(pair.disconnect); pair.disconnect = null; this.refreshState(); }
    };
    pc.ondatachannel = event => {
      if (pair.closed) { event.channel.close(); return; }
      if (pair.offerer || pair.channel || event.channel.label !== "events-v1") { event.channel.close(); this.failPair(pair, new Error("Unexpected DataChannel")); return; }
      this.attach(pair, event.channel);
    };
    if (pair.offerer) this.attach(pair, pc.createDataChannel("events-v1", { ordered: true }));
    return pc;
  }
  private attach(pair: Pair, channel: RTCDataChannel): void {
    pair.channel = channel; let opened = false;
    const start = () => {
      if (pair.closed || opened) return; opened = true;
      try {
        clearTimeout(pair.deadline);
        const sync = new SyncSession(this.core, { forwardRemote: true, ...(this.options.acknowledgementTimeoutMs ? { acknowledgementTimeoutMs: this.options.acknowledgementTimeoutMs } : {}),
          ...(this.options.storage ? { storage: this.options.storage } : {}), onError: error => this.failPair(pair, error) });
        pair.sync = sync;
        sync.onStateChange(state => { if (pair.closed) return; if (state === "online") { this.retryAttempt = 0; this.backoff.delete(pair.remote); this.errorMessage = null; } this.refreshState(); });
        sync.connect(rtcByteLink(channel, pair.pc));
      } catch (error) { this.failPair(pair, errorOf(error)); }
    };
    channel.onopen = start; channel.onclose = () => this.failPair(pair, new Error("Data channel closed"));
    channel.onerror = () => this.failPair(pair, new Error("Data channel error"));
    if (channel.readyState === "open") queueMicrotask(start);
  }
  private sendPair(pair: Pair, kind: DiscoverySignal["kind"], body: Partial<Pick<DiscoverySignal, "description" | "candidate">> = {}): Promise<void> {
    this.assertPair(pair);
    return this.send({ kind, from: this.peerId, to: pair.remote, session: pair.id, challenge: pair.challenge, response: kind === "challenge" ? null : pair.response,
      description: body.description ?? null, candidate: body.candidate ?? null }, pair);
  }
  private send(signal: DiscoverySignal, pair?: Pair): Promise<void> {
    if (this.queuedSignals >= 64) return Promise.reject(new Error("Signaling send queue is full"));
    this.queuedSignals++;
    const generation = this.generation;
    const result = this.sendQueue.then(async () => {
      this.assertGeneration(generation); if (pair) this.assertPair(pair);
      const packet = await this.core.sealDiscovery(signal); this.assertGeneration(generation); if (pair) this.assertPair(pair);
      await this.options.discovery.publish(packet);
    });
    this.sendQueue = result.catch(() => {}); return result.finally(() => { this.queuedSignals--; });
  }
  async requestChunk(value: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const peers = [...this.pairs.values()].filter(p => p.sync?.state === "online");
    let last = new Error("No online peer for chunk request");
    for (const pair of peers) { signal?.throwIfAborted(); try { return await pair.sync!.requestChunk(value, signal); } catch (error) { last = errorOf(error); } }
    signal?.throwIfAborted(); throw last;
  }
  stop(): void { this.shutdown(); this.setState("stopped"); }
  reconnect(): void { if (!this.running) return; this.shutdown(); void this.start().catch(() => {}); }
  private shutdown(): void {
    this.running = false; this.generation++; globalThis.removeEventListener?.("online", this.wake);
    if (this.helloTimer !== null) clearInterval(this.helloTimer); if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.helloTimer = null; this.retryTimer = null;
    for (const pair of [...this.pairs.values()]) this.closePair(pair);
    this.backoff.clear(); this.options.discovery.stop();
  }
  private canPair(remote: string, actor: string): boolean {
    const old = this.pairs.get(remote); if (old) return old.actor === actor;
    if (this.pairs.size >= this.config.maxPeers || (this.backoff.get(remote)?.until ?? 0) > Date.now()) return false;
    return ![...this.pairs.values()].some(p => p.actor === actor);
  }
  private closePair(pair: Pair): void {
    if (pair.closed) return; pair.closed = true;
    if (this.pairs.get(pair.remote) === pair) this.pairs.delete(pair.remote);
    clearTimeout(pair.deadline); if (pair.disconnect !== null) clearTimeout(pair.disconnect);
    if (pair.sync) { const stats = pair.sync.stats; for (const key of Object.keys(stats) as (keyof P2PStats)[]) if (key !== "pairings") this.counters[key] += stats[key]; pair.sync.stop(); }
    pair.channel?.close(); pair.pc?.close();
  }
  private failPair(pair: Pair, error: Error): void {
    if (!this.running || pair.closed || this.pairs.get(pair.remote) !== pair) return;
    this.errorMessage = error.message; this.closePair(pair);
    const attempt = Math.min((this.backoff.get(pair.remote)?.attempt ?? 0) + 1, 6);
    if (this.backoff.size >= 128) this.backoff.delete(this.backoff.keys().next().value!);
    const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * 2 ** (attempt - 1));
    this.backoff.set(pair.remote, { attempt, until: Date.now() + delay * (0.8 + Math.random() * 0.4) });
    this.refreshState(); this.report(error);
  }
  private refreshState(): void {
    if (!this.running) return;
    const pairs = [...this.pairs.values()];
    if (pairs.some(p => p.sync?.state === "online" && p.pc?.connectionState !== "disconnected")) this.setState("online");
    else if (pairs.some(p => p.sync?.state === "syncing")) this.setState("syncing"); else this.setState("connecting");
  }
  private fail(error: Error): void {
    if (!this.running) return; this.errorMessage = error.message; this.shutdown(); this.setState("offline"); this.report(error);
    const delay = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * 2 ** Math.min(this.retryAttempt++, 6));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.start().catch(() => {}); }, delay * (0.8 + Math.random() * 0.4));
  }
  private assertPair(pair: Pair): void { if (!this.running || pair.closed || this.pairs.get(pair.remote) !== pair) throw new Error("Peer session replaced"); }
  private assertGeneration(generation: number): void { if (!this.running || generation !== this.generation) throw new Error("Discovery session replaced"); }
  private report(error: Error): void { try { this.options.onError?.(error); } catch { /* Isolate observers. */ } }
  private setState(state: P2PState): void { if (state === this.currentState) return; this.currentState = state; for (const observer of this.observers) try { observer(state); } catch { /* Isolate observers. */ } }
}
