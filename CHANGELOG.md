# Changelog

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
