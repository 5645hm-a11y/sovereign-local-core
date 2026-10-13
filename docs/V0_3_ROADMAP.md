# Next core milestone: private reads, bounded replay and recoverable data

Status: v0.3.0 ships the sections explicitly marked implemented below.
The remaining designs and acceptance criteria are future work.
The v0.2.0 release remains an immutable historical baseline. Scope is a general-purpose database SDK
for arbitrary applications and workloads.

The objective is a stronger sovereign database with measurable security,
durability and resource contracts. A claim to be the world's most advanced
database is not an acceptance criterion. Workloads and adversarial tests are.

## Current evidence and first local improvement

The core already authenticates event signatures and certificate chains before
native policy evaluation, encrypts logs/chunks, preserves conditional losers and
converges for the same eligible history. See [policy contracts](POLICIES.md).

The new [invariant benchmark](INVARIANTS_BENCHMARKS.md) exercises the business
reducer separately from the historical LWW benchmark. It exposed an allocation
failure near the 100,000-candidate boundary and full replay on exact duplicates.
The v0.3.0 native change shares immutable candidate payloads between staged
histories and skips replay for validated duplicate-only batches. This preserves
atomic failure and checkpoint formats. The subsequent [affected-row optimization](ROW_REPLAY.md)
now applies row suffixes or reconstructs affected rows only, with compiled-runtime
and checkpoint parity. It does not prove arbitrary workloads fit browser memory.

## 1. Cryptographic read domains

### Implemented independent read partitions

The v0.3.0 [ReadDomainsClient](READ_DOMAINS.md) implements this separation as
a signed logical namespace: independent projects/keys, role-restricted admission,
per-actor grants, prefix routing enforced on imports/recovery, private streamed
files and per-domain swarms. Native write/invariant semantics remain unchanged.
It does not implement opaque encrypted domains inside a single physical log or
cross-domain atomic transactions. [Scalability](SCALABILITY.md) records the current
actor-summary, key-epoch, history and resource bounds and the next protocol work.

The next implemented step is [paged sync frontiers](SYNC_FRONTIERS.md), with
128-actor pages, complete-generation checks, per-page ACKs and durable reconnect.
The 10k synthetic protocol/hint tests do not establish 10k-member governance or
large-swarm connectedness. [Bounded log cursors](SYNC_CURSORS.md) now avoid
whole-log export arrays and gate source reads on durable ACKs. Core log scans and
assembled frontier memory remain linear in sequential fallback. Standard stores
now use [authenticated actor-offset indexes](SYNC_INDEX.md) for small deltas;
resident indexes and cold prefix verification remain linear. [Bounded neighbor
exploration](SPARSE_OVERLAY.md) now bridges the tested saturated components using
idle-edge rotation. Opt-in [routed discovery](DISCOVERY_ROUTING.md) now reduces
presence fanout using bounded samples and targeted instance inboxes. Adaptive
layouts, bounded whole-governance processing, disk-resident segments and stronger
connected-overlay/anti-entropy contracts are still required.

[Paged key epochs](PAGED_EPOCHS.md) now remove the single-record envelope/witness
boundary with signed Merkle pages, partial-state failure contracts and crash/retry
tests. Whole governance plans/replay and keyring histories still grow; synthetic
record tests are not large-member deployments. Opt-in
[discovery recovery](DISCOVERY_RECOVERY.md) now supplies recipient-encrypted
governance across old epochs, and normal discovery rebinds automatically.
Optional [routed recovery](RECOVERY_ROUTING.md) now samples probes and addresses
selected transfers without speculative cursors. Adaptive/rate scale and orphan
preparation cleanup remain work.

### Example partition design

Use two independent projects with independently random keys and explicit
membership. Invite ordinary application users only to their granted domains:

| Project | Content | Key recipients |
| --- | --- | --- |
| Shared | Shared records, workflow state and opaque references | Explicitly granted application users |
| Private | Personal data, internal records and private file manifests | Explicitly granted private-data readers |

Keep all inputs for an invariant in the same domain. Never place confidential
values in a shared domain's fields, file metadata or IDs. An opaque reference
can still be linkable; it is not a guarantee of anonymity.
Protect private files in the private project as well. There is no atomic commit
across these projects. A UI filter, SQL-like predicate or denied write does not
stop a key holder reading decrypted content.

### Proposed in-project domains

Introduce independently generated AES-256-GCM keys per immutable read domain
and epoch. **Do not derive private domain keys from a project key held by all
members.** Possession of that parent key would grant the same derivation ability.

The root signs a descriptor binding domain IDs, key-distribution authority,
permitted roles, invariant groups and schema/ABI requirements. Domain/epoch,
project/descriptor identity, actor, event identity, type and clocks are covered
by the event signature and encryption AAD. A domain cannot be selected by an
unsigned field or mutable row attribute. Key envelopes bind recipient ActorID,
domain, epoch and descriptor, using the existing authenticated ECDH mechanism.
A membership certificate alone grants no private decryption key.

Split the event path into two explicit states:

1. An authenticated opaque envelope may be retained/relayed within bounded
   storage, after signature and static membership checks.
2. A decrypted, bound, authorized command may enter its domain's reducer only
   after all current validation checks. An unreadable envelope is never treated
   as an accepted business event or an empty command.

This requires a versioned protocol and explicit domain access state; the current
engine cannot simply swallow unknown-key/decryption failures. Use separate
watermarks, checkpoints, queries and lazy chunk routes per domain. An ordinary
query observes only locally authorized domains. Privileged aggregate queries
must not accidentally publish their private result into a shared domain.

Nodes with different read grants have different views. Convergence is compared
among nodes entitled to the same domain and eligible event set, not against a
global plaintext snapshot. Every invariant must run within one domain whose
authorized reducers can see its complete relevant history. Cross-domain
constraints require a separate proof/coordination design.

Rotate future domain keys on revocation and distribute envelopes only to current
readers. Define the signed epoch cutover and existing historical-witness rules
before implementation. Rotation cannot erase old keys, ciphertext or plaintext
already obtained by a revoked reader. Metadata, traffic volume and timing can
remain visible even when content is private.

Acceptance: a correctly signed shared-domain reader can process its events but
cannot decrypt private event/file bytes from a raw disk or network capture; editing
domain/epoch/recipient fails authentication; no private fields enter an ungranted reader's
snapshots/checkpoints; late joins, revocation, withheld keys, restart and mixed
client versions fail or recover according to explicit contracts.

## 2. Replay cost bounded by affected data

**Implemented in v0.3.0:** [affected-row replay and suffixes](ROW_REPLAY.md),
with full-replay and independently compiled baseline parity, atomic invalid-batch
checks and spread/hot-row measurements. The row index is rebuilt from unchanged
SCK2 authoritative checkpoints, not trusted as serialized cache. Full recovery,
governance reprojection and hot-row vector copies remain. [Bounded native queries](QUERY_PAGES.md)
now supply item/decision keyset pages with revision invalidation, and compact
durable writes/sync skip full Snapshot output. Legacy full-view APIs, default client open and `useLiveQuery` still produce
complete views. [Paged React queries](REACT_PAGED_QUERIES.md) now retain one page
with selective commit refresh, compact session startup and lifecycle cleanup.
Native and real Chrome timings are recorded. [Field queries](FIELD_QUERIES.md)
now provide typed scalar predicates, single-field reference indexes, explicit scan
mode, keyset bounds and cold/warm measurements. Small-write incremental maintenance is included; composite/disk index
planning, stable MVCC subscriptions and periodic-checkpoint percentiles remain.
The requirements below continue to define follow-up acceptance.

Retain losing candidates; deleting them changes the result of future late events.
First index history by immutable item ID: today's owner and loan predicates are
row-local. Replay affected rows, then publish their state and decision changes
atomically. Checkpoint both the index and sufficient authoritative history;
governance changes must still invalidate affected cached authorization.

An append arriving after a row's frontier can use a validated row-state suffix;
an earlier event rebuilds that row. A local frontier is not proof that all peers
have delivered their history. Garbage collection needs a separately defined
stability/retention protocol. Keep the canonical total order and exact-return
semantics. Never introduce a wall-clock timeout as a convergence shortcut.

Acceptance: the old reducer remains a reference oracle for randomized histories,
arrival permutations, checkpoint/delta splits, ownership denials, duplicates,
equivocation and revocation. Optimize only after equality tests pass. Benchmark
skewed histories on one hot row as well as histories spread across many rows;
row indexing does not solve the hot-row case by itself.

Measure 1k/10k/50k/100k lifetime candidates, then explicitly decide whether to
raise today's 100k/128 MiB bounds. Report native and full Chrome Worker paths
separately: signing/authorization, AES-GCM, flush, query delivery, cold recovery,
per-operation p50/p95/p99 and memory. Book count alone does not size history.
Targets must name hardware, workload, retained history and browser storage quota.

## 3. Business idempotency and uniqueness

Exact signed event retransmission is already idempotent. Two calls creating new
event IDs for the same business intent are different operations. No reported
application duplicate has a reproduction yet; the benchmark fix does not claim
to fix semantic duplicate rows.

Proposed command extension: a signed idempotency key, scoped to project/domain,
actor and operation, with a canonical intent digest. Same key plus same digest
reuses the original result; same key plus different digest produces an explicit
error. Persist the index in recovery state and define retention before pruning
it. Sharing one key across actors needs a separate authority rule.

Separate logical entity identity from delivery identity. Use stable business
entity IDs; do not merge distinct entities just because names/attributes match.
Offline uniqueness either converges with explicit provisional conflicts or uses
preallocated authority/coordination. Claiming both immediate global uniqueness
and unconstrained disconnected writes would be incorrect.

Acceptance: duplicate network frames, retry after lost acknowledgement, restart
and reconnect produce one durable intent; changed contents under the same key
fail; distinct business entities remain independent. Test the API through the
Worker, not only the native reducer.

## 4. Verified encrypted export and restore

Design a streamed backup containing the encrypted wallet vault, pinned project
descriptors/invitations, required encrypted key envelopes, event logs, checkpoint
slots and encrypted blob chunks. Define which secrets must survive to unlock it.
Do not assume that a passphrase recreates a deleted random wallet key.

An authenticated manifest binds file paths, sizes, digests, project identities
and backup version. Treat import as untrusted: enforce size/path limits, restore
to a new quarantined directory, verify signatures/chains and replay, check blob
hashes, then expose the validated project. A checkpoint alone is not a complete
backup. Export consistency must pin a committed log boundary while writes occur.

Acceptance: export while writing, delete the original browser data, restore in
a fresh origin, and compare rows, decision history, counters and streamed files.
Tampered manifests, missing keys, truncated logs, malicious paths and incomplete
chunks must fail visibly without replacing a valid database.

## Delivery order and scope

1. Independent read partitions and adversarial tests (included in v0.3.0).
2. Paged anti-entropy/governance and connected sparse overlays; row-local replay
   with oracle parity and browser memory measurements.
3. Same-log domain protocol if justified, and verified backup/restore with migration tools.
4. Signed business idempotency and explicit escrow primitives for exclusive
   physical resources, based on concrete workload requirements.

Policy-free projects do not acquire protection through a package update. Their
descriptor and historical signatures remain authoritative. Migrate explicitly
to a new protected project, with a dry run, counts/digests, authenticated export,
authorized re-signed commands and a preserved audit link to the source history.
Do not rewrite project IDs, roles or encryption bindings in old signed events.
Define a write cutover; new clients reject unsupported descriptor/protocol
versions rather than silently downgrading. Test denied writes and private reads
after migration, not just record counts.

OAuth federation, account recovery, licensing, organizations and arbitrary server
code are separate product/protocol requirements. None is implicitly replaced by
wallet authentication or deterministic reducers. Independent security review
and workload-specific validation remain required for high-assurance deployment.


Incremental native field-cache maintenance is now included in v0.3.0: small deltas retain reference indexes, with explicit fallback for large
batches/limits. See [contracts and measurements](INCREMENTAL_INDEXES.md). This
removes repeated field-index builds for ordinary edits, but not sorted-vector
movement, linear restore, retained invariant history or global replication cost.
