# Changelog

## Unreleased

## 0.3.1 — 2026-10-19

- Added a public two-device TypeScript walkthrough using installed package assets:
  separate wallets, pinned-root invitations, initial/live WebRTC sync, offline
  edits, reconnect, OPFS reload and cleanup. Public discovery starts only on request.
- Added archive inspection that runs no package code, with regression checks for
  injected install hooks and unexpected runtime dependencies.
- Added a separate verified-package publication workflow with NPM provenance/OIDC,
  version-tag/digest checks and least-privilege build/publish jobs. Registry
  publication still requires actual owner authorization; workflow availability is
  not evidence that a version has been uploaded or attested.
- Added desktop Chrome/Firefox/WebKit compatibility checks and recorded failures,
  an explicit unverified physical-mobile/WebView matrix, and an external security
  review handoff. No independent audit or new mobile compatibility is claimed.
- Added automated JavaScript/TypeScript CodeQL security analysis. Core C++ ABI,
  cryptographic formats and engine runtime are unchanged from 0.3.0.

## 0.3.0 — 2026-10-13

Public database-engine release with prebuilt browser Worker/WASM assets, MIT
license and a registry-ready `sovereign-local-core` package. All improvements
below ship in the v0.3.0 GitHub artifact. Local validation: 163 unit tests,
49 Chrome/OPFS/P2P tests and 17 installed-package React/Next.js tests (229 total).


- **Incremental native indexes:** staged delta patches maintain up to two caches
  for at most 256 affected IDs per cached prefix. Same-key edits rewire pointers;
  key changes use binary seeks and block moves. Create/delete/resurrection, hidden
  entries and late policy replay retain deterministic output and updated limits.
  Invalid/denied batches preserve state/cache contents. Oversized keys, cache
  budgets and large deltas invalidate only affected caches without rejecting valid
  writes. Sorted vectors retain O(n) worst-case movement; cursors still invalidate
  on durable revisions. ABI, signatures and checkpoints remain unchanged. See
  [contracts and measured write/read paths](docs/INCREMENTAL_INDEXES.md).

- **Native field queries:** four bounded scalar AND predicates and single-field
  deterministic ordering use disposable C++ reference indexes or explicit ID scans.
  Typed equality/ranges distinguish missing/null and preserve ordinal UTF-16 order;
  page scans/output remain bounded. Two LRU indexes per session enforce entry/key
  budgets and never enter the log/checkpoint. Small writes now patch existing
  caches; large deltas/restores rebuild.
  SQR/SQP v2 is additive; base ABI 1 and existing views/checkpoints remain unchanged.
  React descriptors are stable across equivalent objects and restart on changes.
  Added independent-reference, cache/limit/atomicity, Worker/OPFS and installed
  React checks. On 100k rows, Node complete rare equality measured cold/warm
  23.12 / 0.13 ms versus 17.15 ms scanning; crypto/disk/RPC are excluded and each
  post-write indexed read paid rebuild in that historical profile; incremental
  write/read measurements are recorded separately. See [contracts/data](docs/FIELD_QUERIES.md).

- **Paged React queries and compact startup:** `usePagedQuery` retains one native
  page/cursor, coalesces relevant commit refreshes and restarts navigation safely
  after revision changes. Superseded/open/read results are discarded with cursor
  cleanup; retries are finite. `useProject` opens compactly through additive
  client methods and only fetches/caches full views while legacy subscribers need
  them. Legacy open/write/Snapshot APIs remain compatible. Added store/session,
  real OPFS compact recovery and installed-package Strict Mode/Vite/Next tests.
  These are resource/behavior checks, not new latency or unlimited-scale claims.
  See [API, lifecycle and limits](docs/REACT_PAGED_QUERIES.md).

- **Bounded native queries and compact durable receipts:** additive `dispatchCommitted`
  / `ingestCommitted` skip full view output while preserving validation and flush.
  SyncSession uses the optional receipt path with legacy-core fallback. Native item
  and decision keyset pages cap records, binary bytes and hidden-row scans; local
  revision changes fail explicitly. Full Snapshot/React APIs remain compatible.
  Added parity, role-denial, quota/fault/recovery, real Worker/OPFS/sync and installed
  package tests. Real Chrome on 5k LWW rows measured full/receipt dispatch p50
  17.10 / 2.50 ms between checkpoints; Node/native and browser scopes are recorded
  separately. See [contracts and raw data](docs/QUERY_PAGES.md).

- **Affected-row native replay:** C++ indexes immutable candidates by item ID,
  applies validated row suffixes and replays only affected rows for late events.
  Changed state/decisions are staged before atomic node publication; historical
  losers, canonical decision order, ABI 1 and SCK2 checkpoints remain unchanged.
  Added seeded full-replay parity, a real Dedicated Worker test, optional reducer
  work diagnostics and spread/hot-row benchmarks. At 99,998 spread candidates,
  Node WASM plus bridge tail apply measured 204.06 / 0.06 ms before/after;
  a late command on one hot row still replays 100,000 candidates. Crypto, OPFS,
  queries and governance are outside that timing. See [contracts/data](docs/ROW_REPLAY.md).

- **Routed recovery and selection:** optional hashed probe buckets and addressed
  recovery inboxes replace project-wide fragment fanout. Small signed offers
  allocate no serving cursor; only the selected Member starts a transfer. Signed
  return tokens are pinned, known-old offers are refused and capabilities/modes
  fail explicitly without broadcast downgrade. Added unit/Nostr, cold/partial
  Chrome recovery and installed-package tests. A 10k synthetic delivery model
  records 2,071,538 versus 12.9 billion deliveries for a hypothetical broadcast
  workload; this is not a 10k-wallet or WAN benchmark. Adaptive/rate/freshness
  bounds remain. See [contracts/model](docs/RECOVERY_ROUTING.md).

- **Control-only discovery recovery:** an opt-in stable locator serves signed
  governance in 16 KiB fragments, with wallet-authenticated requests and recipient
  ECDH/AES-GCM responses. Current Members restore offline peers across epochs
  without the root online. Data events, SDP/ICE and blob bytes are excluded;
  complete controls use normal validation/flush. Replay, finite cursors,
  revised-governance restart and cleanup are checked. Normal discovery now
  rebinds on epoch changes, preserving authorized online channels and closing
  known revoked edges. Unit/Chrome tests cover cold/partial recovery, lazy files
  and OPFS reopen. The opt-in recovery channel is broadcast and still needs
  scale/rate work. See [contracts](docs/DISCOVERY_RECOVERY.md).

- **Paged key-epoch governance:** root-signed Merkle commitments split recipient
  key envelopes and exact historical revocation witnesses into 128-entry,
  96 KiB-bounded binary pages. Oversized rotations select schema 4 automatically;
  `revokeMember(actorId, { paged: true })` opts in explicitly. Preparation flushes
  precede the final manifest; manifest-first revocation blocks new-epoch operations
  with `EpochIncompleteError` until all pages verify. Partial checkpoint/restart,
  crash/retry, delegation exclusion and newer-invitation bypass tests are included.
  A 10k synthetic record fixture produces 158 pages with an 81,434-byte largest
  signed record, not a 10k-member guarantee. Whole governance memory/replay,
  invitation keyring bounds and cold discovery rekeying remain separate work.
  See [contracts and measurements](docs/PAGED_EPOCHS.md).

- **Opt-in routed Nostr discovery:** hashed presence buckets, bounded rotating
  samples and per-instance inboxes replace project-wide SDP/ICE fanout. Static
  inbox subscriptions survive sample rotation; relay reconnects and shutdown
  retain bounds. Worker authentication/replay rules and existing APIs remain.
  Added unit, multi-relay dedup and real Chrome record/file/recovery/sparse-network
  tests. The 10k synthetic presence model shows 99.60% fewer deliveries; this is
  not a 10k-member or WAN throughput test. Peers must agree on an explicit routing
  layout; legacy mode remains the default. See [contracts](docs/DISCOVERY_ROUTING.md).

- **Bounded neighbor exploration:** authenticated expiring candidate hints,
  rotating idle edges with residency/cooldown and ACK/chunk safeguards, symmetric
  proposals with deterministic collision handling, and pending negotiation retries.
  `topology: 'fixed'` retains first-fit behavior; direct edge caps remain 1–32.
  See [contracts and reachability limits](docs/SPARSE_OVERLAY.md).

- **Authenticated indexed delta export:** actor/sequence addresses now select
  only missing frames behind the existing cursor API. The address map is sealed
  inside owner-signed checkpoints; recovery validates exact event-ID coverage,
  safe nonoverlapping ranges and selected frame identity/content. Old checkpoints
  rebuild the map once through bounded verified reads. Addresses are installed
  only after flush; read fences, revocation, ACK backpressure and cleanup remain.
  Added adversarial address/recovery tests and selective Chrome OPFS/Worker checks.
  In the 2k-event in-memory-file fixture, last-20 export drops from 1,991.39 to
  20.36 ms and reads 47,760 bytes instead of 4,770,292. Full-history export remains
  similar; index/checkpoint memory and startup verification remain linear. See
  [contracts and raw measurements](docs/SYNC_INDEX.md).
- **Bounded source-side catch-up:** standard OPFS/Worker clients now export
  fenced log cursors through `SyncSession`, up to 64 records / 128 KiB per read
  (one bounded oversized record may progress). Durable ACKs gate subsequent
  reads. Current signatures, admission proofs and revocation eligibility are
  checked; governance changes invalidate cursors, and disconnect/expiry/shutdown
  release them. Existing bulk APIs and custom-store fallback remain compatible.
  Added unit/Chrome recovery and backpressure tests, `benchmark:sync`, and
  [contracts/results](docs/SYNC_CURSORS.md). First full-transfer batch improves
  from 1,891.83 to 49.75 ms in the measured in-memory-file fixture; total scans
  in sequential fallback still read all history and small-tail export is slower.
  The indexed extension above now skips that prefix. No peak-RAM or global
  throughput claim is made.
- **Paged sync frontiers:** both WebRTC adapters automatically exchange
  versioned, ordered 128-actor pages with per-page ACKs when supported by the core.
  Initial/live transfer waits for complete bidirectional frontiers; interrupted
  sessions restart from durable contiguous receipt. Legacy small peers remain
  supported, with an explicit upgrade error above 4,096 actors. A defensive
  262,144-actor total bound remains. Added 10k synthetic actor/hint tests, real
  Chrome DataChannel/Worker/OPFS recovery and [protocol contracts](docs/SYNC_FRONTIERS.md).
  This wire change alone does not index the local log; this is bounded wire paging, not
  partial replication or a claim of unlimited project size.
- Duplicate signed governance imports now take the full authorization path
  instead of failing the item-only delta path. Duplicate-only and mixed batches
  remain idempotent; forged duplicate signatures are still rejected.
- **General-purpose cryptographic read domains:** `ReadDomainsClient` routes
  arbitrary records and streamed files across independently keyed projects.
  Descriptor v3 signs the complete immutable namespace map, read roles and
  write policies. Role admission and namespace checks run in the core, including
  imports/recovery; unauthorized domains cannot be read through a UI/API bypass.
- Per-actor domain grants, trusted root/space preflight, explicit unavailable
  domains, per-domain mesh lifecycle/telemetry and scoped revocation. Private file
  prefixes keep manifests/chunks under the domain key; legacy file IDs remain valid.
  Multi-domain operations are not atomic and report partial completion.
- Added [read-domain contracts](docs/READ_DOMAINS.md) and explicit
  [scalability bounds/protocol work](docs/SCALABILITY.md). Existing projects do not
  become private automatically; older clients reject v3 descriptors.
- Native policy ingestion shares immutable candidate payloads across staged
  histories and skips history copying/replay for fully validated duplicate-only
  batches. Conflicting bytes/clocks/roles still reject atomically; C ABI and
  checkpoint formats remain unchanged.
- Added `benchmark:invariants` with explicit failure reporting, late-winner and
  restore assertions, plus [baseline/results](docs/INVARIANTS_BENCHMARKS.md).
  The recorded near-100k allocation failure no longer occurs for that workload;
  memory remains high. The newer affected-row change improves event deltas;
  restore remains linear in history.
- Added a [core roadmap](docs/V0_3_ROADMAP.md) for cryptographic read domains,
  per-row replay, business idempotency, migration and verified encrypted backups.
  Read partitions and affected-row replay are included in v0.3.0;
  business idempotency, verified backup and same-project opaque-domain relay remain
  planned features.

## 0.2.0 — 2026-10-09

Sovereign wallets, native write policies, deterministic business invariants and
multi-peer synchronization. This remains an experimental release.

### Added

- **Zero-server Auth via wallets:** email-free local wallet IDs and passphrases,
  random P-256 identities in PBKDF2/AES-GCM encrypted vaults, non-extractable
  unlocked private key handles and compatible React credentials.
- **Root-pinned Web of Trust:** Admin/Member/Kiosk certificate roles. Only the
  root may grant Admin; delegated Admins may invite Members and Kiosks.
- **Native row write policies:** immutable root-signed project descriptor v2,
  deterministic item-ID prefix rules, action role lists and owner predicates.
  The Worker verifies signatures/chains; C++ rejects statically forbidden writes
  before append. These policies do not provide row-level read confidentiality.
- **CHECKOUT/RETURN invariants:** deterministic replay by Lamport, ActorID and
  sequence; exact loan-ID returns; explicit ACCEPTED, REJECTED_CONFLICT and
  REJECTED_POLICY decisions. Losing candidates remain durable and synchronize.
- **Candidate checkpoints:** versioned native checkpoints preserve conditional
  history and verified roles; late earlier events can change provisional outcomes
  after recovery. Configured sessions reject legacy policy bypasses.
- **Multi-peer WebRTC mesh:** default eight, maximum 32 simultaneous edges,
  independent connection/retry state, late-join discovery, sparse-mesh event
  forwarding with deduplication and lazy file pulls across online peers.
- **Encrypted public Nostr discovery:** optional relay adapter, project-derived
  rendezvous encryption, signed SDP/ICE, expiry/replay checks and fresh mutual
  challenges; injectable STUN/TURN configuration.
- **Reusable Streams sync:** transport-independent SyncSession for handshake,
  catch-up, durable ACKs, live events and chunk pulls.

### Fixed

- Durable ACKs no longer block the receive loop on full-duplex stream writes.
- Sequential chunk pulls tolerate delivery before the preceding response write
  settles, with one active chunk load and one bounded queued successor.
- Duplicate signed SDP is compared with its original description, preventing
  false mismatch errors after the browser mutates SDP during trickle ICE.
- Supplied policies are checked against the signed descriptor on both initial
  invitation-based joins and later opens, before pinning conflicting configuration.
- SDK/example preparation derives the tarball name from the package version.

### Compatibility and limits

Existing email/password APIs, signed schema-v3 events and policy-free v1 projects
remain supported. Base C ABI 1 is retained with additive policy exports and
versioned command/view/checkpoint extensions. Deploy the matching Worker and WASM
together; older clients reject policy-enabled descriptor v2. Policies cannot be
changed in place; migrate explicitly to a new project.

Offline loan acceptance is provisional and does not enforce physical exclusivity.
Project key holders can decrypt project content regardless of write permissions.
The initial invariant reducer retains at most 100,000 candidates and 128 MiB of raw
commands and replays them; previous LWW benchmarks do not measure this path.
Public relays/STUN and optional TURN remain external infrastructure. No arbitrary
contracts, consensus, independent security audit or safety certification is claimed.

### Validation

75 unit tests, 30 Chrome core browser tests and 9 installed-package DX browser
tests cover authorization, all tested double-checkout arrival orders, encrypted
recovery/checkpoints, three-peer WebRTC, sparse two-hop forwarding and Vite/Next
installation. See [policy contracts](docs/POLICIES.md),
[discovery contracts](docs/DISCOVERY.md) and [SDK integration](docs/DX.md).

## 0.1.0 — 2026-10-08

Initial MIT-licensed experimental release: C++/WASM LWW materialization, binary
encrypted OPFS logs and checkpoints, signed identities, certificate membership
and revocation, two-peer WebRTC synchronization, streamed encrypted file storage,
self-contained package assets, React hooks and public To-Do examples.
