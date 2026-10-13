import type { IDiscoveryProvider, IDiscoveryRecoveryCore } from "./discovery-provider.js";
import { MAX_DISCOVERY_PACKET } from "./discovery-provider.js";
import { recoveryPacketKind } from "./discovery-recovery-crypto.js";
import { fromBase64Url } from "./crypto-codec.js";

export interface DiscoveryRecoveryOptions {
  discovery: IDiscoveryProvider;
  /** Idle polls, default 30s; recovery is explicitly opt-in and uses a separate provider. */
  intervalMs?: number;
  responseTimeoutMs?: number;
  transferTimeoutMs?: number;
  onRecovered?: (keyId: string) => void;
  onError?: (error: Error) => void;
}
const errorOf = (e: unknown) => e instanceof Error ? e : new Error(String(e));
/** Blind relay pull loop. Crypto and durable governance admission belong to the core. */
export class DiscoveryRecovery {
  private running = false; private generation = 0; private queued = 0;
  private receiving: Promise<void> = Promise.resolve(); private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private waitVersion = 0;
  readonly stats = { completed: 0, requests: 0, responses: 0, rejected: 0, timeouts: 0 };
  private readonly interval: number; private readonly responseTimeout: number; private readonly transferTimeout: number;
  private readonly routed: boolean;
  constructor(private readonly core: IDiscoveryRecoveryCore, private readonly options: DiscoveryRecoveryOptions) {
    this.interval = options.intervalMs ?? 30000; this.responseTimeout = options.responseTimeoutMs ?? 15000; this.transferTimeout = options.transferTimeoutMs ?? 300000;
    if ([this.interval, this.responseTimeout, this.transferTimeout].some(n => !Number.isSafeInteger(n) || n < 100 || n > 2147483647)) throw new TypeError("Invalid recovery intervals");
    this.routed = options.discovery.supportsRouting === true;
    if (this.routed && (!options.discovery.startRouted || !options.discovery.publishRouted || !core.createRoutedDiscoveryRecoveryRequest || !core.handleRoutedDiscoveryRecoveryRequest)) throw new TypeError("Incomplete routed recovery provider/core; no broadcast fallback");
  }
  async start(): Promise<void> {
    if (this.running) return; this.running = true; const generation = ++this.generation;
    try {
      const { topic, instanceId } = await this.core.getDiscoveryRecoveryInfo(); this.assert(generation);
      if (this.routed) fromBase64Url(instanceId, 32);
      const receive = (packet: Uint8Array<ArrayBuffer>) => {
        if (!this.running || generation !== this.generation) return;
        if (!(packet instanceof Uint8Array) || packet.length > MAX_DISCOVERY_PACKET || this.queued >= 32) { this.stats.rejected++; return; }
        const copy = packet.slice(); this.queued++;
        this.receiving = this.receiving.then(async () => {
          this.assert(generation);
          if (recoveryPacketKind(copy) === "request") {
            if (this.routed) {
              const response = await this.core.handleRoutedDiscoveryRecoveryRequest!(copy); this.assert(generation);
              if (response) { if (!response.recipient) throw new Error("Routed recovery response has no inbox");
                await this.publish(response.packet, response.recipient, generation); this.stats.responses++; }
            } else {
              const response = await this.core.handleDiscoveryRecoveryRequest(copy); this.assert(generation);
              if (response) { await this.publish(response, null, generation); this.stats.responses++; }
            }
          } else {
            if (!this.active) return;
            const progress = await this.core.acceptDiscoveryRecoveryResponse(copy); this.assert(generation); if (!progress) return;
            if (progress.complete) {
              this.active = false; this.stats.completed++;
              try { this.options.onRecovered?.(progress.keyId!); } catch { /* Isolate observer. */ }
              this.schedule(this.interval, generation);
            } else if (progress.request) {
              if (Date.now() - this.startedAt > this.transferTimeout) throw new Error("Recovery transfer exceeded deadline");
              this.schedule(this.responseTimeout, generation);
              if (this.routed && !progress.recipient) throw new Error("Routed recovery pull has no responder inbox");
              await this.publish(progress.request, progress.recipient ?? null, generation); this.stats.requests++;
            }
          }
        }).catch(error => { if (this.running && generation === this.generation) { this.stats.rejected++; this.report(errorOf(error)); } })
          .finally(() => { this.queued--; });
      };
      if (this.routed) await this.options.discovery.startRouted!(topic, instanceId!, receive);
      else await this.options.discovery.start(topic, receive);
      this.assert(generation); await this.poll(generation);
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
  }
  private schedule(delay: number, generation: number) {
    if (this.timer !== null) clearTimeout(this.timer);
    const version = ++this.waitVersion;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || generation !== this.generation) return;
      this.receiving = this.receiving.then(async () => {
        if (!this.running || generation !== this.generation || version !== this.waitVersion) return;
        if (this.active) { this.active = false; this.stats.timeouts++; }
        await this.poll(generation);
      }).catch(e => { if (this.running && generation === this.generation) { this.report(errorOf(e)); this.schedule(this.interval, generation); } });
    }, delay);
  }
  private async poll(generation: number) {
    const packet = await (this.routed ? this.core.createRoutedDiscoveryRecoveryRequest!() : this.core.createDiscoveryRecoveryRequest()); this.assert(generation);
    this.active = true; this.startedAt = Date.now();
    // Break phase locking between repeated probes and rotating sparse subscriptions.
    // Fragment waits stay fixed; only the initial routed probe uses bounded jitter.
    const wait = this.routed ? Math.max(100, Math.floor(this.responseTimeout * (0.8 + Math.random() * 0.2))) : this.responseTimeout;
    this.schedule(wait, generation);
    await this.publish(packet, null, generation); this.stats.requests++;
  }
  private async publish(packet: Uint8Array<ArrayBuffer>, recipient: string | null, generation: number): Promise<void> {
    this.assert(generation);
    if (this.routed) await this.options.discovery.publishRouted!(packet, recipient);
    else await this.options.discovery.publish(packet);
    this.assert(generation);
  }
  stop(): void {
    this.running = false; this.generation++; this.active = false; this.waitVersion++;
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    this.options.discovery.stop(); void this.core.cancelDiscoveryRecovery().catch(() => {});
  }
  private assert(generation: number) { if (!this.running || generation !== this.generation) throw new Error("Recovery session replaced"); }
  private report(error: Error) { try { this.options.onError?.(error); } catch { /* Isolate observer. */ } }
}
