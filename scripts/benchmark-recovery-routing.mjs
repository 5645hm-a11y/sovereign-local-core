import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { cpus, platform } from "node:os";
import assert from "node:assert/strict";
import { DiscoveryRouting } from "../dist/discovery-routing.js";
import { toBase64Url } from "../dist/crypto-codec.js";

const count = 10000, bucketCount = 1024, sampleBuckets = 3, fragmentPairs = 64;
const topic = toBase64Url(new Uint8Array(32).fill(47)), directory = [], started = performance.now();
for (let i = 0; i < count; i++) {
  const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(28, i);
  directory.push(await DiscoveryRouting.create(topic, toBase64Url(bytes), { bucketCount, sampleBuckets, rotationIntervalMs: 3000 }));
}
const derivationMs = performance.now() - started, occupancy = new Uint32Array(bucketCount);
for (const d of directory) occupancy[d.ownBucket]++;
let probeDeliveries = 0;
const probesPerReceiver = directory.map(d => {
  const deliveries = occupancy[d.ownBucket] + d.sampleIndices(0).reduce((sum, b) => sum + occupancy[b], 0);
  probeDeliveries += deliveries; return deliveries;
}).sort((a, b) => a - b);
// Worst offer count for this sample round: every non-self delivered probe elicits one small offer.
// A selected transfer has one addressed requester and one addressed responder per fragment pair.
const offerPackets = probeDeliveries - count, addressedFragmentPackets = count * fragmentPairs * 2;
assert.equal(new Set(directory.map(d => d.inbox)).size, count);
const routedDeliveries = probeDeliveries + offerPackets + addressedFragmentPackets;
// Compare the same idealized probe + selected-fragment workload sent on a project-wide topic.
// This deliberately excludes extra broadcast responders; it is not an old-protocol timing measurement.
const hypotheticalBroadcastDeliveries = count * count * (1 + 2 * fragmentPairs);
assert.ok(routedDeliveries < hypotheticalBroadcastDeliveries / 1000);
const report = {
  date: new Date().toISOString(), node: process.version, platform: platform(), cpu: cpus()[0]?.model,
  scope: "Delivery-count model using production bucket/sample/inbox derivation for 10,000 synthetic IDs. One probe per ID in one sample round; assumes every non-self probe delivery receives a small offer, exactly one selected responder per requester and 64 fragment request/response pairs. Does not exercise 10k wallets, membership, live relays, ECDH, signatures, worker/OPFS, nonce budgets, transfer time, memory or WAN. Offer availability and successful selection are assumptions, not demonstrated liveness.",
  count, bucketCount, sampleBuckets, fragmentPairs, derivationMs,
  probePublications: count, probeDeliveries, offerPackets, offerDeliveries: offerPackets,
  addressedFragmentPackets, addressedFragmentDeliveries: addressedFragmentPackets,
  routedDeliveries, hypotheticalBroadcastDeliveries,
  deliveryReductionPercent: (1 - routedDeliveries / hypotheticalBroadcastDeliveries) * 100,
  probeDeliveriesPerReceiver: { mean: probeDeliveries / count, p50: probesPerReceiver[Math.floor(count * .5)], p95: probesPerReceiver[Math.floor(count * .95)], maximum: probesPerReceiver.at(-1) },
  subscriptionsPerRelay: 2, concurrentProbeBuckets: sampleBuckets + 1, speculativeServingCursorsPerProbe: 0,
  limitations: "Fixed bucket counts still give quadratic aggregate probe growth. Multiple offers, hostile placement, blind spots, mismatched layouts, slow sampling and stale/malicious first offers affect liveness. Payload sizes and relay billing are not measured. Inbox delivery assumes filter-honoring relays, unique random instance IDs and one selected responder.",
};
await mkdir(new URL("../docs/benchmarks/", import.meta.url), { recursive: true });
await writeFile(new URL("../docs/benchmarks/recovery-routing-node.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
