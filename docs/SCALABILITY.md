# General-purpose scale: current bounds and next protocol work

This core is intended for many application types. Read isolation, cryptographic
authorization, durable histories and synchronization must work independently of
any particular domain-specific example. Supporting arbitrary project sizes is a
design objective, not a property established by the current release or tests.

## Bounds observed in the source

| Boundary | Current implementation | Consequence |
| --- | --- | --- |
| Direct WebRTC edges | Default 8, maximum 32 per adapter; v0.3.0 idle neighbor rotation | Bounds local sockets; does not guarantee a connected large swarm |
| Neighbor candidate hints | Version 0.3.0 default 256, maximum 4,096; 120s TTL | Bounded local view; presence broadcast/replay budgets still constrain discovery |
| Discovery replay window | 4,096 unexpired nonces; 60s packet TTL + 30s skew retention | Fails closed at capacity; broadcast presence can bind before candidate/actor limits |
| Sync frontier | v0.2.0/legacy summaries: 4,096 actors. Version 0.3.0 paged mode: 128 actors / 32 KiB per page, 262,144 total | New wire protocol passes 10k synthetic actors; total frontier memory remains linear |
| Source log cursor | 64 records / 128 KiB target per page; one record up to 1 MiB plus header; 32 cursors / core | Indexed selection skips known frames; resident address/admission indexes remain O(events) |
| Invariant history | 100,000 candidates / 128 MiB raw commands per native policy session | A lifetime-history bound, not a record or user-count guarantee |
| WASM linear memory | 512 MiB per runtime; allocation may fail earlier | Workload/fragmentation-sensitive; host RSS also includes JS/runtime data |
| Revocation witness/envelopes | Inline: 4,096 each; v0.3.0 paged: 65,536 each, 128 / 96 KiB per page | Removes single-record bottleneck; full-plan memory and keyring limits remain |
| Log record / sync frame | 1 MiB / 2 MiB | Byte bounds can bind before entry-count bounds |
| Invitation keyring | At most 128 key envelopes | Long epoch histories also need a scalable keyring protocol |
| Version 0.3.0 discovery recovery | Optional routed probes/inboxes; plain broadcast retained; 16 KiB fragments, 8 selected cursors, 65,536 controls | No speculative cursors for routed probes; adaptive/rate budgets and whole-cache memory remain work |
| Read-domain facade | 16 domains / 64 routing prefixes, one Worker per opened domain | Initial namespace/resource bound; not unlimited collections/shards |

Unchanged v0.2.0 source bounds: [event index](https://github.com/5645hm-a11y/sovereign-local-core/blob/v0.2.0/src/event-index.ts),
[validation](https://github.com/5645hm-a11y/sovereign-local-core/blob/v0.2.0/src/validation.ts),
[log](https://github.com/5645hm-a11y/sovereign-local-core/blob/v0.2.0/src/framed-log.ts),
[transport](https://github.com/5645hm-a11y/sovereign-local-core/blob/v0.2.0/src/sync-session.ts),
[mesh](https://github.com/5645hm-a11y/sovereign-local-core/blob/v0.2.0/src/p2p-webrtc.ts),
[key envelopes](https://github.com/5645hm-a11y/sovereign-local-core/blob/v0.2.0/src/project-crypto.ts).
Version 0.3.0 contracts: [read domains](READ_DOMAINS.md),
[business replay measurements](INVARIANTS_BENCHMARKS.md),
[paged sync frontiers](SYNC_FRONTIERS.md), [bounded log cursors](SYNC_CURSORS.md),
[authenticated address indexes](SYNC_INDEX.md), [neighbor exploration](SPARSE_OVERLAY.md),
[paged key epochs](PAGED_EPOCHS.md).

Actors are writing identities/devices, not necessarily distinct human users.
More readers, more devices, longer retained histories and larger records stress
different boundaries. Neither increasing a constant nor testing three devices
proves an arbitrary-size project. Current adapters advertise broadly and cap
edges; connectedness under saturation or churn is not proven.

## Implemented wire paging and remaining work

### 1. Paged anti-entropy and partial replication

Version 0.3.0 [paged frontiers](SYNC_FRONTIERS.md) replace the flat wire handshake
with a versioned generation, exact actor/page counts, ordered ranges and per-page
ACKs. Tests cover 10k synthetic writers, holes, interrupted/repeated pages,
reconnection and mixed versions, plus actual Chrome transport/Worker recovery with
synthetic hints. Incomplete frontiers cannot start event transfer or report online.
This removes the 4,096-actor **wire handshake** boundary when both ends upgrade,
while imposing a new explicit total bound. It does not remove other scale bounds.

Version 0.3.0 [log cursors](SYNC_CURSORS.md) now read bounded source pages without a
full missing-event array or plaintext replay, verifying signatures and authenticated
durable admission proofs. The next page waits for the peer's durable batch ACK.
Standard stores now use [authenticated actor-offset indexes](SYNC_INDEX.md) to
read only missing frames, restored from signed checkpoints or rebuilt once for
old checkpoints. Remaining: disk-resident bounded indexes, prefix/Merkle ranges,
bounded total frontier memory and periodic anti-entropy. Cold prefix verification
and sequential fallback still scan history; custom cores/stores and explicit bulk
APIs can retain the full-array path. Avoid treating page bounds as proof of
constant whole-core memory or full-history speedup.

Add collection/shard subscriptions with independently authorized keys/logs, so
each client need not hold all rows and lifetime events of an entire project.
Define which replicas are eligible to run a given invariant and how its relevant
history reaches them. A partial replica cannot claim a global unique/exclusive
result without additional authority or coordination.

Acceptance: at least 10,000 synthetic writing actors, interrupted pages, duplicate
pages, holes, equivocation, missing ranges, mixed versions, peer churn and bounded
in-flight bytes. Compare recovered summaries and rows against an authoritative
reference history. Measure memory and wire bytes, not only connections established.

### 2. Connected sparse overlays

Separate project membership from live neighbors. Use authenticated bounded peer
sampling, discovery diversity, rotating a small number of neighbors and periodic
anti-entropy. Avoid a full-mesh requirement and popular-peer saturation. Preserve
per-edge resource limits and isolate failing/unauthorized peers.

Version 0.3.0 [neighbor exploration](SPARSE_OVERLAY.md) now retains bounded authenticated
hints and replaces one locally idle edge per interval, with residency, cooldown and
active ACK/chunk safeguards. Round-robin proposals and collision handling allow
previously saturated groups to attempt bridging. This is not a connected-backbone
proof: discovery diversity, gossip, ongoing anti-entropy, authorized eclipse attacks
and public-relay/NAT behavior remain work.

Opt-in [routed discovery](DISCOVERY_ROUTING.md) now divides presence into hashed
buckets, samples a bounded rotating set and addresses SDP/ICE to per-instance
inboxes. It reduces delivery fanout in the recorded synthetic model; fixed bucket
counts still yield quadratic aggregate growth and mismatched layouts can isolate
peers. Neither the synthetic model nor the six-wallet Chrome test proves 10k-member
governance, WAN throughput, safe nonce budgets under all traffic or unlimited scale.

Topology tests must include isolated initial components, synchronized joins,
random/chosen failures, NAT/TURN conditions and delayed relay delivery. Demonstrate
eventual bridging under stated reachability assumptions. Do not infer global
availability from one edge reporting `online`; offline peers cannot supply data.

### 3. Paged group key epochs and governance

Version 0.3.0 [paged key epochs](PAGED_EPOCHS.md) now implement root-signed Merkle
commitments for recipient envelopes and exact historical witnesses. Each page
contains at most 128 entries / 96 KiB. Root preparation flushes precede the final
manifest; partial receivers enforce revocation immediately and cannot activate
the new key until every committed page verifies. Tests cover crash/retry,
checkpoints, newer-key invitation bypass, revoked delegations and 4,097 genuine
witness events. A 10k synthetic record fixture validates page bounds/proofs;
it does not establish 10k real members or WAN latency. Full governance replay,
retained controls, bounded complete-plan memory, orphan cleanup, invitation
keyrings and recovery adaptive/rate budgets remain work. Opt-in
[control-only discovery recovery](DISCOVERY_RECOVERY.md) now reconnects tested
cold/partial replicas through another Member, with the root offline. Normal topic
rebinding is automatic; a reachable current replica remains necessary.
Optional [routed recovery](RECOVERY_ROUTING.md) now addresses selected transfers
to signed return inboxes and allocates no cursor for probe offers. Fixed-layout
probe growth, stale/hostile first responders and publication budgets remain limits.

Commit a signed epoch manifest to bounded recipient-envelope pages with an
authenticated root/hash and recipient inclusion proofs. Define historical read
grants, revocation witnesses and epoch cutover before reducing keyring history.
Peers must distinguish a missing page from exclusion and never fall back to an
old key for new writes. Validate the entire governance transition without
requiring every recipient envelope inside one log record.

Further acceptance: genuine membership beyond existing envelope limits, partial-page recovery,
revoked delegation, shuffled transitions and future-key secrecy. This is a new
protocol and migration requirement; paging alone does not remove other bounds.

### 4. Segmented log and affected-row replay

Version 0.3.0 [affected-row replay](ROW_REPLAY.md) now stages/reduces touched rows
only. Suffixes reduce new commands; late arrivals replay that row's retained
history. A hot row still needs linear vector copies and early-event replay.
Checkpoint restore and governance rebuilds remain linear. [Bounded query pages](QUERY_PAGES.md)
now cap native item/decision output and skip whole views on compact writes/sync;
legacy Snapshot/useLiveQuery paths remain full reads. [Paged React queries](REACT_PAGED_QUERIES.md)
now retain one page, open compactly, refresh on relevant commits and clean up
superseded work. They are forward page windows, not stable MVCC/infinite-scroll
queries. [Field queries](FIELD_QUERIES.md) now add typed scalar predicates and
single-field ordering over at most two disposable native indexes per session.
Cold build inspects up to 100k prefix entries with a 16 MiB accounted-key budget;
small writes now patch cached indexes; large deltas/restores still rebuild.
Changed keys can move O(n) references, and residual scans remain. These bounds are not peak-RAM or
unlimited-row/member guarantees. Queries invalidate on new durable
revisions, so they are not stable MVCC snapshots. Spread/hot-row replay, Node
page/core and real Chrome OPFS timings have separate recorded scopes.

Index authoritative binary log segments and replay only affected rows/partitions.
Keep conditional losers until a proven retention/stability rule permits pruning.
Use scoped query/decision delivery instead of copying all historical decisions
on each write. Maintain crash recovery and checkpoint/reference parity.

Measure end-to-end p50/p95/p99 signing, verification, flush and query latencies;
cold startup, retained bytes, RSS, in-flight buffers and degraded operation.
Name reference hardware/browser, actors, rows, history length and data size.
Targets should be workload-specific and independently reproducible.

Private read domains, wire-paged frontiers, bounded source log cursors and
authenticated address indexes and paged key epochs are
included in v0.3.0.
Segmented anti-entropy, connected sparse overlays and bounded whole-governance processing remain
protocol priorities. OAuth, billing, organizations and
arbitrary server execution remain separate requirements; a database core does
not silently replace every service of a backend platform.
