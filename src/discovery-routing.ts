import { encodeBinary } from "./binary-codec.js";
import { fromBase64Url, toBase64Url } from "./crypto-codec.js";

export interface DiscoveryRoutingOptions {
  /** Shared by every routed participant. Power of two, 2–4096; default 64. */
  bucketCount?: number;
  /** Other presence buckets sampled simultaneously, 1–8; default min(3, count-1). */
  sampleBuckets?: number;
  /** Sample rotation, 100–2^31-1ms; default 3000ms. Align presence cadence accordingly. */
  rotationIntervalMs?: number;
}
export type DiscoveryRoutingConfig = Required<DiscoveryRoutingOptions>;
export function normalizeDiscoveryRouting(value: DiscoveryRoutingOptions): Readonly<DiscoveryRoutingConfig> {
  const bucketCount = value.bucketCount ?? 64;
  const sampleBuckets = value.sampleBuckets ?? Math.min(3, bucketCount - 1);
  const rotationIntervalMs = value.rotationIntervalMs ?? 3000;
  if (!Number.isInteger(bucketCount) || bucketCount < 2 || bucketCount > 4096 || (bucketCount & (bucketCount - 1)) !== 0 ||
      !Number.isInteger(sampleBuckets) || sampleBuckets < 1 || sampleBuckets > 8 || sampleBuckets >= bucketCount ||
      !Number.isFinite(rotationIntervalMs) || rotationIntervalMs < 100 || rotationIntervalMs > 0x7fffffff) throw new TypeError("Invalid discovery routing bounds");
  return Object.freeze({ bucketCount, sampleBuckets, rotationIntervalMs });
}
async function address(parts: readonly (string | number)[]): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", encodeBinary(parts)));
}
/** Routing hints only. Inner signatures, membership and replay checks remain authoritative. */
export class DiscoveryRouting {
  private constructor(readonly topic: string, readonly instanceId: string, readonly config: Readonly<DiscoveryRoutingConfig>,
    readonly ownBucket: number, private readonly seed: number, readonly inbox: string, readonly presence: string) {}
  static async create(topic: string, instanceId: string, options: DiscoveryRoutingOptions): Promise<DiscoveryRouting> {
    fromBase64Url(topic, 32); fromBase64Url(instanceId, 32);
    const config = normalizeDiscoveryRouting(options);
    const hash = await crypto.subtle.digest("SHA-256", encodeBinary(["slc/discovery-placement/v1", topic, instanceId]));
    const view = new DataView(hash), ownBucket = view.getUint32(0) % config.bucketCount;
    const seed = view.getUint32(4) % (config.bucketCount - 1);
    const [inbox, presence] = await Promise.all([
      address(["slc/discovery-inbox/v1", topic, instanceId]),
      address(["slc/discovery-bucket/v1", topic, config.bucketCount, ownBucket]),
    ]);
    return new DiscoveryRouting(topic, instanceId, config, ownBucket, seed, inbox, presence);
  }
  /** Consecutive ranks visit every other bucket, without growing a peer/address directory. */
  sampleIndices(round: number): readonly number[] {
    if (!Number.isSafeInteger(round) || round < 0 || round > Math.floor(Number.MAX_SAFE_INTEGER / this.config.sampleBuckets)) throw new RangeError("Invalid routing round");
    const count = this.config.bucketCount - 1, indices: number[] = [];
    for (let i = 0; i < this.config.sampleBuckets; i++) {
      const rank = ((round % count) * this.config.sampleBuckets + this.seed + i) % count;
      indices.push(rank < this.ownBucket ? rank : rank + 1);
    }
    return Object.freeze(indices);
  }
  sampleTopics(round: number): Promise<string[]> {
    return Promise.all(this.sampleIndices(round).map(index => address(["slc/discovery-bucket/v1", this.topic, this.config.bucketCount, index])));
  }
  target(instanceId: string | null): Promise<string> {
    if (instanceId === null) return Promise.resolve(this.presence);
    fromBase64Url(instanceId, 32);
    return address(["slc/discovery-inbox/v1", this.topic, instanceId]);
  }
}
