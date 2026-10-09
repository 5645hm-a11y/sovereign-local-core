import { schnorr, etc } from "@noble/secp256k1";
import { fromBase64Url, toBase64Url } from "./crypto-codec.js";
import { MAX_DISCOVERY_PACKET, type IDiscoveryProvider } from "./discovery-provider.js";

export const PUBLIC_NOSTR_RELAYS = Object.freeze(["wss://nos.lol", "wss://relay.primal.net"]);
export interface NostrDiscoveryOptions { relays?: readonly string[]; kind?: number; timeoutMs?: number; onError?: (error: Error) => void }
interface NostrEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
interface Relay {
  socket: WebSocket; ready: boolean; subscription: string; deadline: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null; attempts: number; queued: number; queue: Promise<void>;
  acks: Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>;
}
const utf8 = new TextEncoder();
function eventBytes(e: Omit<NostrEvent, "id" | "sig">): Uint8Array<ArrayBuffer> { return utf8.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])); }
async function digest(e: Omit<NostrEvent, "id" | "sig">): Promise<Uint8Array<ArrayBuffer>> { return new Uint8Array(await crypto.subtle.digest("SHA-256", eventBytes(e))); }

/** Optional NIP-01 adapter. All application content is already sealed by the Worker. */
export class NostrDiscovery implements IDiscoveryProvider {
  private readonly options: Required<Omit<NostrDiscoveryOptions, "onError">> & Pick<NostrDiscoveryOptions, "onError">;
  private readonly relays = new Map<string, Relay>();
  private readonly seen = new Map<string, number>();
  private key: Uint8Array | null = null; private publicKey = ""; private topic = "";
  private running = false; private generation = 0; private receiver: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  private ready: (() => void) | null = null; private queuedPublishes = 0;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelStartup: ((error: Error) => void) | null = null;
  readonly stats = { published: 0, received: 0, rejected: 0, reconnects: 0 };
  constructor(options: NostrDiscoveryOptions = {}) {
    const relays = [...new Set(options.relays ?? PUBLIC_NOSTR_RELAYS)];
    if (!relays.length || relays.length > 8) throw new TypeError("Select 1–8 Nostr relays");
    for (const relay of relays) {
      const url = new URL(relay);
      if (url.username || url.password || (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new TypeError("Nostr relays require WSS (WS only for local tests)");
    }
    this.options = { ...options, relays, kind: options.kind ?? 20000, timeoutMs: options.timeoutMs ?? 8000 };
    if (!Number.isInteger(this.options.kind) || this.options.kind < 20000 || this.options.kind >= 30000 || this.options.kind === 22242) throw new TypeError("An application ephemeral kind is required");
    if (!Number.isFinite(this.options.timeoutMs) || this.options.timeoutMs <= 0) throw new TypeError("Invalid discovery timeout");
  }
  async start(topic: string, receive: (packet: Uint8Array<ArrayBuffer>) => void): Promise<void> {
    fromBase64Url(topic, 32); this.stop(); this.running = true; const generation = this.generation;
    const pair = schnorr.keygen(); this.key = pair.secretKey; this.publicKey = etc.bytesToHex(pair.publicKey);
    this.topic = topic; this.receiver = receive;
    try {
      await new Promise<void>((resolve, reject) => {
        this.cancelStartup = reject;
        this.startupTimer = setTimeout(() => reject(new Error("No Nostr relay acknowledged the subscription")), this.options.timeoutMs);
        this.ready = () => { if (this.startupTimer !== null) clearTimeout(this.startupTimer); this.startupTimer = null; this.ready = null; this.cancelStartup = null; resolve(); };
        for (const url of this.options.relays) this.connect(url, generation, 0);
      });
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
    if (generation !== this.generation) throw new Error("Discovery startup was cancelled");
  }
  private connect(url: string, generation: number, attempts: number): void {
    if (!this.running || generation !== this.generation) return;
    const socket = new WebSocket(url);
    const relay: Relay = { socket, ready: false, subscription: crypto.randomUUID(), deadline: null, retry: null, attempts,
      queued: 0, queue: Promise.resolve(), acks: new Map() };
    this.relays.set(url, relay);
    relay.deadline = setTimeout(() => socket.close(), this.options.timeoutMs);
    socket.onopen = () => {
      if (!this.current(url, relay, generation)) return;
      socket.send(JSON.stringify(["REQ", relay.subscription, { kinds: [this.options.kind], "#t": [this.topic], since: Math.floor(Date.now() / 1000) - 90, limit: 0 }]));
    };
    socket.onmessage = event => {
      if (!this.current(url, relay, generation)) return;
      if (typeof event.data !== "string" || event.data.length > 64 * 1024 || relay.queued >= 32) { this.stats.rejected++; socket.close(); return; }
      relay.queued++;
      relay.queue = relay.queue.then(() => this.receive(relay, event.data, generation)).catch(error => { this.stats.rejected++; this.report(error); })
        .finally(() => { relay.queued--; });
    };
    socket.onerror = () => { /* onclose owns retry; no payload is logged. */ };
    socket.onclose = () => {
      if (!this.current(url, relay, generation)) return;
      relay.ready = false; if (relay.deadline !== null) clearTimeout(relay.deadline);
      for (const pending of relay.acks.values()) { clearTimeout(pending.timer); pending.resolve(false); } relay.acks.clear();
      this.stats.reconnects++;
      relay.retry = setTimeout(() => this.connect(url, generation, attempts + 1), Math.min(15000, 500 * 2 ** Math.min(attempts, 5)) * (0.8 + Math.random() * 0.4));
    };
  }
  private current(url: string, relay: Relay, generation: number): boolean { return this.running && generation === this.generation && this.relays.get(url) === relay; }
  private async receive(relay: Relay, text: string, generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || relay.socket.readyState !== WebSocket.OPEN) return;
    const message: unknown = JSON.parse(text);
    if (!Array.isArray(message)) throw new Error("Invalid Nostr envelope");
    if (message[0] === "EOSE" && message[1] === relay.subscription) {
      relay.ready = true; if (relay.deadline !== null) clearTimeout(relay.deadline); relay.deadline = null; this.ready?.(); return;
    }
    if (message[0] === "OK" && typeof message[1] === "string") {
      const pending = relay.acks.get(message[1]);
      if (pending) { clearTimeout(pending.timer); relay.acks.delete(message[1]); pending.resolve(message[2] === true); }
      return;
    }
    if (message[0] === "CLOSED" && message[1] === relay.subscription) { this.report(new Error("Relay closed discovery subscription")); relay.socket.close(); return; }
    if (message[0] !== "EVENT" || message[1] !== relay.subscription) return;
    const e = message[2] as NostrEvent;
    if (!e || !/^[0-9a-f]{64}$/.test(e.id) || !/^[0-9a-f]{64}$/.test(e.pubkey) || !/^[0-9a-f]{128}$/.test(e.sig) || e.kind !== this.options.kind ||
      !Number.isSafeInteger(e.created_at) || Math.abs(Math.floor(Date.now() / 1000) - e.created_at) > 90 ||
      !Array.isArray(e.tags) || e.tags.length > 4 || e.tags.some(tag => !Array.isArray(tag) || tag.length !== 2 || tag.some(value => typeof value !== "string" || value.length > 128)) ||
      !e.tags.some(tag => tag[0] === "t" && tag[1] === this.topic) || typeof e.content !== "string" || e.content.length > Math.ceil(MAX_DISCOVERY_PACKET * 8 / 6)) throw new Error("Invalid Nostr event");
    const now = Date.now(); for (const [id, expiry] of this.seen) if (expiry < now) this.seen.delete(id);
    if (this.seen.has(e.id)) return;
    const hash = await digest(e);
    if (etc.bytesToHex(hash) !== e.id || !await schnorr.verifyAsync(etc.hexToBytes(e.sig), hash, etc.hexToBytes(e.pubkey))) throw new Error("Invalid Nostr event signature");
    const packet = fromBase64Url(e.content);
    if (packet.length > MAX_DISCOVERY_PACKET || this.seen.size >= 4096) throw new Error("Nostr receive limit exceeded");
    if (!this.running || generation !== this.generation) return;
    this.seen.set(e.id, now + 120000); this.stats.received++; this.receiver?.(packet);
  }
  async publish(packet: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.running || !this.key || !(packet instanceof Uint8Array) || packet.length > MAX_DISCOVERY_PACKET) throw new Error("Discovery is stopped or packet is oversized");
    if (this.queuedPublishes >= 16) throw new Error("Nostr publish queue is full");
    this.queuedPublishes++; const generation = this.generation;
    try {
      const created_at = Math.floor(Date.now() / 1000);
      const event = { pubkey: this.publicKey, created_at, kind: this.options.kind,
        tags: [["t", this.topic], ["expiration", String(created_at + 60)]], content: toBase64Url(packet) };
      const hash = await digest(event), id = etc.bytesToHex(hash), sig = etc.bytesToHex(await schnorr.signAsync(hash, this.key));
      if (!this.running || generation !== this.generation) throw new Error("Discovery was replaced");
      const wire = JSON.stringify(["EVENT", { ...event, id, sig }]);
      const ready = [...this.relays.values()].filter(relay => relay.ready && relay.socket.readyState === WebSocket.OPEN);
      if (!ready.length) throw new Error("No available Nostr relay");
      const pending = ready.map(relay => new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { relay.acks.delete(id); resolve(false); }, this.options.timeoutMs);
        relay.acks.set(id, { resolve, timer });
        try { relay.socket.send(wire); } catch { clearTimeout(timer); relay.acks.delete(id); resolve(false); }
      }).then(ok => { if (!ok) throw new Error("Relay rejected publishing"); return true; }));
      try { await Promise.any(pending); }
      catch { throw new Error("All Nostr relays rejected or timed out publishing"); }
      finally { for (const relay of ready) { const ack = relay.acks.get(id); if (ack) { clearTimeout(ack.timer); relay.acks.delete(id); ack.resolve(false); } } }
      this.stats.published++;
    } finally { this.queuedPublishes--; }
  }
  stop(): void {
    this.running = false; this.generation++; this.ready = null; this.receiver = null;
    if (this.startupTimer !== null) clearTimeout(this.startupTimer); this.startupTimer = null;
    this.cancelStartup?.(new Error("Discovery startup was cancelled")); this.cancelStartup = null;
    for (const relay of this.relays.values()) {
      if (relay.deadline !== null) clearTimeout(relay.deadline); if (relay.retry !== null) clearTimeout(relay.retry);
      for (const ack of relay.acks.values()) { clearTimeout(ack.timer); ack.resolve(false); }
      relay.socket.onclose = null; relay.socket.onmessage = null; relay.socket.onopen = null; relay.socket.close();
    }
    this.relays.clear(); this.seen.clear(); this.key?.fill(0); this.key = null;
  }
  private report(value: unknown): void { try { this.options.onError?.(value instanceof Error ? value : new Error(String(value))); } catch { /* Isolate observers. */ } }
}
