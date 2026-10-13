import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cpus, platform } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { DiscoveryRouting } from "../dist/discovery-routing.js";
import { toBase64Url } from "../dist/crypto-codec.js";

const count = 10000, rounds = 30, bucketCount = 1024, sampleBuckets = 3;
const hash = async value => toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const topic = await hash("slc/routing-benchmark/project/v1"), directory = [];
const start = performance.now();
for (let offset = 0; offset < count; offset += 128) directory.push(...await Promise.all(
  Array.from({ length: Math.min(128, count - offset) }, async (_, i) =>
    DiscoveryRouting.create(topic, await hash(`slc/routing-benchmark/instance/${offset + i}`), { bucketCount, sampleBuckets }))));
const addressDerivationMs = performance.now() - start;
const occupancy = new Uint32Array(bucketCount);
for (const d of directory) occupancy[d.ownBucket]++;
const perReceiver = directory.map(d => {
  let deliveries = 0;
  for (let round = 0; round < rounds; round++) {
    deliveries += occupancy[d.ownBucket];
    for (const bucket of d.sampleIndices(round)) deliveries += occupancy[bucket];
  }
  return deliveries;
}).sort((a, b) => a - b);
const routed = perReceiver.reduce((a, b) => a + b, 0), broadcast = count * count * rounds;
assert.ok(routed < broadcast / 100); assert.ok(perReceiver.at(-1) < 4096);
const report = {
  date: new Date().toISOString(), node: process.version, platform: platform(), cpu: cpus()[0]?.model,
  scope: "Deterministic routing fanout model over 10,000 synthetic instance IDs using production placement/sample code. Not 10,000 authorized wallets, running sockets, WebRTC connections or a throughput/peak-RAM benchmark. Assumes uniform presence cadence, matching configuration, filter-honoring relays and no adversarial bucket placement. Includes own presence; excludes directed negotiation, signatures, replay validation, certificates, relay ACKs and traffic bursts.",
  count, rounds, bucketCount, sampleBuckets, helloIntervalMs: 3000, rotationIntervalMs: 3000,
  addressDerivationMs, routingSimulationMs: performance.now() - start - addressDerivationMs,
  bucketOccupancy: { minimum: Math.min(...occupancy), maximum: Math.max(...occupancy) },
  subscriptionsPerRelay: 2, concurrentPresenceBuckets: sampleBuckets + 1,
  presencePublications: count * rounds, projectWideDeliveries: broadcast, routedDeliveries: routed,
  deliveryReductionPercent: (1 - routed / broadcast) * 100,
  perReceiver90Seconds: { mean: routed / count, p50: perReceiver[Math.floor(count * .5)], p95: perReceiver[Math.floor(count * .95)], maximum: perReceiver.at(-1), projectWide: count * rounds },
  limitations: "Fixed bucketCount still yields quadratic aggregate delivery growth. This presence-only scenario fitting 4096 cached nonces is not a complete replay-budget or scalability proof. Public relay and WAN/TURN behavior are unmeasured; slow sampling can delay sparse projects.",
};
await mkdir(new URL("../docs/benchmarks/", import.meta.url), { recursive: true });
await writeFile(new URL("../docs/benchmarks/discovery-routing-node.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
