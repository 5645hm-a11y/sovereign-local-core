# Sovereign Local Core v0.3.0

Released 2026-10-13. A general-purpose, MIT-licensed local-first database engine
for browser applications: no application-owned database or authentication server.
Applications define their own records, UI and deployment; this release adds no
application-specific kiosk or end-user product.

## Engine and security

- Native scalar predicates, deterministic ordering and bounded keyset query pages.
- Incremental C++ reference indexes maintain small writes; same-key changes rewire
  pointers and changed keys use binary seeks/block moves. Large deltas and restore
  retain explicit rebuild paths and resource limits.
- Compact create/open/write/import APIs and paged React queries avoid automatic
  full database snapshots; existing public APIs remain supported.
- Affected-row replay keeps deterministic invariant candidates and atomic policy
  decisions without replaying unaffected rows on every ordinary write.
- Sovereign local wallets, ECDSA signatures, Admin certificate chains and immutable
  native row write policies remain supported. AES-GCM encrypts data; ECDSA signs it.
- Independently keyed read domains add signed routing, restricted read admission
  and private record/file partitions. Write policies alone do not hide shared-key
  records, and a package upgrade does not protect old policy-free projects.
- Paged actor frontiers, verified OPFS log cursors/address indexes, bounded neighbor
  rotation, routed Nostr discovery and authenticated epoch recovery extend P2P.
- File bytes remain separate from event history and transfer lazily as verified,
  encrypted chunks with streaming backpressure.

## Validation and measurements

The final core passed **163 unit tests**, **49 Chrome/OPFS/P2P tests** and
**17 installed-package React/Next.js tests**: **229 total**. Independently compiled
old/current reducers produced 412 byte-identical snapshots and 412 byte-identical
checkpoints, including cross-runtime restore and denied-batch atomicity.

On the recorded 100,000-row Node/WASM fixture, medians were **0.15 ms** for a
complete indexed equality read after an edit and **0.13 ms** for the edit plus
maintenance of two indexes. The initial indexed read cost **24.95 ms**. These
exclude cryptography, OPFS, Worker RPC, network and startup. Core processing runs
in a Dedicated Worker; no universal zero-main-thread-blocking claim is made.
[Scopes/raw samples/reproduction](INCREMENTAL_INDEXES.md).

## Distribution

The GitHub release includes the installable NPM-format tarball, SHA-256 checksums
and a manifest binding artifacts to the source commit. Worker/WASM assets and
TypeScript declarations are prebuilt; consumers need no native compiler.

```sh
npm install https://github.com/5645hm-a11y/sovereign-local-core/releases/download/v0.3.0/sovereign-local-core-0.3.0.tgz
```

NPM registry publication remains pending account authentication. The intended
registry package is `sovereign-local-core`; do not treat its unconfigured registry
publication as complete. [Install/publish the exact archive](PUBLISHING.md).

## Compatibility and scope

Base C ABI remains 1. Event signatures and SCK1/SCK2 checkpoint formats remain
unchanged; SQR/SQP query v2 is additive. New read-space descriptors, paged epochs
and negotiated wire extensions require matching capabilities and reject
unsupported configurations rather than silently weakening protection.

Legacy APIs that return full snapshots remain full reads. Cursors invalidate on
new durable revisions even when indexes remain warm. Small-write index maintenance
is bounded to 256 affected IDs per cached prefix; changed keys can still move O(n)
references. Resource limits remain finite, and offline invariant outcomes are
provisional until the same authorized history reaches all replicas.

Version 0.3.0 remains experimental and has no independent security audit or
safety-critical certification. [Security boundaries](../SECURITY.md),
[resource limits](SCALABILITY.md) and [remaining roadmap](V0_3_ROADMAP.md) are part
of the release contract.
