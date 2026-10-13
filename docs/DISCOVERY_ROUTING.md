# Routed rendezvous discovery

Status: included in v0.3.0. The public v0.2.0 artifact does not
include these options. This is a general-purpose discovery layer, independent
of an application's schema, roles, business invariants or UI.

## Configure a shared routing layout

```ts
import { P2PWebRTC } from 'sovereign-local-core';
import { NostrDiscovery } from 'sovereign-local-core/nostr';

// db is already open with its pinned project root and membership invitation.
const discovery = new NostrDiscovery({
  routing: { bucketCount: 64, sampleBuckets: 3, rotationIntervalMs: 3000 },
});
const sync = new P2PWebRTC(db, {
  discovery, maxPeers: 8, maxCandidates: 256, helloIntervalMs: 3000,
  // Supply deployment-specific STUN/TURN when necessary.
});
const removeStoragePeer = db.storage.addPeer(sync);
try { await sync.start(); }
catch (error) { removeStoragePeer(); sync.stop(); throw error; }
// On disposal: removeStoragePeer(); sync.stop(); then close the owning db.
```

Every routed participant must agree on `bucketCount`. Allowed counts are powers
of two from 2 to 4096, default 64. `sampleBuckets` selects 1–8 other presence
buckets, fewer than `bucketCount`; default `min(3, bucketCount - 1)`.
The rotation interval must be finite and within 100–2^31-1ms (the timer limit);
default 3s. Choose
presence cadence shorter than the sampling window, allowing for relay delay.
Very short intervals increase subscription and signing overhead.

Small sparse projects should use fewer buckets. For example, 8 buckets with
2 sampled buckets explore the other seven buckets over four sample windows.
The default 64/3 layout covers the other 63 buckets over 21 windows, about 63s
at the configured interval, excluding hashing/network delay. A 1024/3 layout
can take about 17 minutes for a full sweep: appropriate sampling density depends
on the number of **online** replicas, not total project membership. A sweep is
not a delivery deadline; changing population, sleeping tabs, relay failure and
unreachable RTC endpoints can prevent pairing.

Omitting `routing` retains legacy project-wide discovery. `P2PWebRTC` checks
`supportsRouting` and uses optional `startRouted` / `publishRouted` methods only
when explicitly enabled. The original `IDiscoveryProvider` methods and
`LocalCoreClient` API remain available. Legacy and routed participants have no
automatic bridge. Configuration mismatches can isolate discovery; coordinate
this opt-in change across replicas. No fallback silently broadcasts routed SDP.

## Presence buckets and persistent instance inboxes

The Worker still derives the secret rendezvous topic, seals binary messages,
signs their actor/session/recipient fields and validates memberships, expiration
and nonce replay. The adapter receives only that opaque topic, a fresh random
32-byte instance ID and already encrypted packets.

`discovery-routing.ts` hashes domain-separated binary tuples:

- Placement: `['slc/discovery-placement/v1', topic, instanceId]` determines the
  instance's presence bucket and sampling offset.
- Presence route: `['slc/discovery-bucket/v1', topic, bucketCount, bucketIndex]`.
- Inbox route: `['slc/discovery-inbox/v1', topic, recipientInstanceId]`.

No route contains the raw project ID, public ActorID or instance ID. The project
topic itself is not published as a Nostr tag in routed mode. A presence message
goes to its publisher's bucket; challenge/proof/SDP/ICE goes to the recipient's
inbox. Signaling does not depend on that recipient currently sampling the sender's
presence bucket. A new P2P instance obtains a new inbox; old directed packets
still cannot satisfy the new instance and mutual challenge checks.

Each relay WebSocket maintains **two** NIP-01 subscriptions:

1. A static subscription to the local inbox and local presence bucket.
2. A rotating subscription to at most eight other presence buckets.

Sample ranks advance sequentially with a hashed starting offset and omit the
local bucket; a bounded sweep visits every other bucket without keeping an
unbounded directory. Rotation sends CLOSE for the old sampled subscription and
REQ with a new ID. The inbox subscription remains active. Incoming events must
match a current subscription ID and its topics, and pass outer Schnorr signature
validation. A late event from a replaced sampled subscription is ignored, also
when rotation overlaps signature verification. Concurrent copies arriving from
multiple relays are deduplicated after verification.

This uses standard `#t` OR filters and `limit: 0` live subscriptions from
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), not a custom
relay extension. `startRouted` resolves when at least one static subscription
receives EOSE. Reconnection restores the static and latest sampled subscriptions.
One sequential rotation timer avoids overlapping hash jobs; stop cancels startup,
rotation/retry timers, pending relay ACKs and sockets. Bounds remain 8 relays,
32 queued receives per relay, 16 in-flight publishes and 32 KiB discovery packets.
The 4096-entry outer dedup and Worker nonce limits remain fail-closed; no live
nonce is evicted merely to admit traffic.

## Reproducible evidence

Run `npm run benchmark:discovery`; the checked-in
[raw model report](benchmarks/discovery-routing-node.json) records hardware,
configuration and scope. It uses the production placement and sampling code on
10,000 deterministic synthetic instance IDs, 1024 buckets, 3 sampled buckets,
30 aligned presence/rotation rounds over 90s. Counts include own presence:

| Presence-only model | Project-wide | Routed |
| --- | ---: | ---: |
| Publications | 300,000 | 300,000 |
| Aggregate event deliveries | 3,000,000,000 | 11,994,115 |
| Mean deliveries per receiver / 90s | 300,000 | 1,199.41 |
| p95 deliveries per receiver / 90s | 300,000 | 1,356 |
| Maximum deliveries per receiver / 90s | 300,000 | 1,584 |

This model shows **99.60% fewer deliveries**, not fewer publications, nor a
99.60% improvement in database latency. It excludes Schnorr/ECDSA, membership,
nonce checks, directed negotiation, socket buffering, actual public relays and
WAN/RTC/NAT. It is not a 10,000-user deployment, throughput measurement or proof
that all governance/key-epoch limits are satisfied. Presence-only counts fit
4096 in this workload; bursts, negotiations and adversarial routing can exceed
the unchanged replay limits. Timings in the report measure model execution.

Unit tests check deterministic separation/coverage/bounds, inbox-only delivery,
bounded subscription rotation, stale/wrong-route rejection, dedup across relays,
restart and startup/shutdown cancellation. Chrome tests use real wallet keys,
Workers, native WASM, OPFS and host-only DataChannels through a local mock NIP-01
relay: two replicas synchronize records, pull a file lazily and recover after a
fresh instance; six replicas bridge two saturated components and synchronize
subsequent writes after a node stops. Legacy discovery also remains tested.

## Remaining scale and trust boundaries

Routing is a delivery filter, **not authorization**. Changing or fabricating a
tag cannot forge the inner actor/recipient proof. Relays can still observe
client IPs, opaque tags, publishing keys, volume, timing and subscription changes;
they can drop traffic, ignore filters or flood clients. There is no anonymity
guarantee or availability proof. Public relays and TURN remain external services.
The discovery adapter never receives private or project AES keys.

For uniform placement, per-receiver presence work is approximately proportional
to online population times `(sampleBuckets + 1) / bucketCount`, with own-bucket
conditioning. A **fixed** bucket count still has quadratic aggregate growth.
Increasing buckets reduces fanout but lengthens sparse rendezvous. This version
does not automatically negotiate layouts, adapt counts, gossip addresses, limit
publication rates globally or prevent an authorized adversary from grinding
instances into crowded buckets/eclipsing bounded views. See
[neighbor exploration](SPARSE_OVERLAY.md) and [other scale limits](SCALABILITY.md).

The same routing provider can now serve the independent
[recovery channel](RECOVERY_ROUTING.md), with signed offer/selection and addressed
fragment pulls. Its topic and configuration are separate from normal discovery;
never reuse one provider instance across these lifecycles.
