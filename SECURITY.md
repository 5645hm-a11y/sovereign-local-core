# Security boundaries and reporting

Version 0.3.1 is experimental and has not received an independent security audit.
The tests cover selected integrity, authorization, recovery and transport behaviors;
passing tests are not proof of complete security.
No avionics, safety-critical or regulatory certification is claimed.

The [independent review packet](docs/SECURITY_REVIEW.md) identifies the attack
surfaces and completion criteria. Preparing that packet and running automated
scans do not mean an independent audit has occurred. The
[browser/device matrix](docs/BROWSER_SUPPORT.md) distinguishes tested runtimes
from unverified mobile/WebView environments.

The core uses browser Web Crypto for encrypted identity vaults, P-256 event
signatures, ECDH key envelopes and AES-GCM project/chunk encryption. It verifies
project binding, pinned certificate chains and revocation policy inside the Worker.
Transport and a shared room token do not grant membership. Application events and
file contents are encrypted; routing/event metadata remains visible.

Important boundaries:

- Trust the application's origin and code. XSS or malicious code executing in your
  origin can use an unlocked identity and read plaintext delivered to the UI.
- Invitations need authenticated delivery and a trusted project root. Email is a
  local vault identifier, not mail-verified identity or a global login service.
  Wallet mode replaces that selector with a local wallet ID; credentials cannot
  recover a deleted random-key vault. It does not implement a global DID registry.
- Root-signed row policies constrain accepted writes, not read access. Every
  project key holder can decrypt that project's event fields. The Worker verifies
  signatures/certificate chains; C++ accepts only the resulting authenticated role
  through the normal engine path. Direct low-level WASM calls are not a separate
  cryptographic boundary. A compromised origin can bypass its own UI but cannot
  produce another member's signature or forge root authorization for honest peers.
- Version 0.3.0 read domains partition a logical namespace into independently keyed
  projects. Descriptor v3 signs the complete routing map and read-role admission;
  core checks apply on writes, imports and recovery. A shared-domain reader has
  no private-domain key. This is not field filtering inside one shared-key log,
  and does not make old projects private automatically. Authenticate the pinned
  root/space and keep each invariant inside a domain. Authorized readers/root can
  still disclose their own plaintext or keys. See [read domains](docs/READ_DOMAINS.md).
- CHECKOUT/RETURN decisions converge for the same authorized event set. Offline
  acceptance is provisional; late earlier events can change a previous winner.
  This does not prevent disconnected replicas independently authorizing physical use.
  Strict offline exclusivity needs escrow or coordination. Business replay retains
  bounded candidate history; an authorized actor can still cause resource pressure
  or choose misleading Lamport clocks. No independent audit or consensus is claimed.
- Revocation cannot recover old plaintext/keys from a recipient. A disconnected
  peer enforces a revocation after learning it. Only root-witnessed historical
  payloads survive the conservative offline revocation rule.
- Version 0.3.0 paged epochs authenticate each bounded page and its signed root
  commitment. The final manifest immediately enforces revocation; all committed
  key/witness pages are needed for activation. Missing pages fail closed even if
  a newer invitation already supplied the key. Withholding pages can prevent
  progress; old plaintext and unaffected old-key history cannot be erased.
  Orphan preparations, full replay and keyring sizes remain bounded. A cold
  old-secret replica needs a reachable authorized recovery peer, updated bootstrap
  or another transport after rekeying. See [paged-epoch contracts](docs/PAGED_EPOCHS.md).
- Version 0.3.0 recovery uses a stable genesis-derived locator only for signed
  governance. Requests check current membership; responses add recipient ECDH
  encryption and exact nonce/session/offset binding. Old-key holders cannot read
  another wallet's reply or use recovery for SDP/data. Known revoked edges close;
  authorized online edges survive normal-topic rebinding. Recovery is opt-in,
  can be withheld/flooded and proves no unseen-history freshness. Optional
  [routed recovery](docs/RECOVERY_ROUTING.md) signs/pins return inboxes and sends
  controls only after selecting a responder; routing is never membership proof.
  Unselected offers consume replay/CPU work even without allocating cursors.
  Plain providers retain broadcast recovery. Matching layouts are required.
  Stable metadata and later wallet compromise remain boundaries. See
  [recovery contracts](docs/DISCOVERY_RECOVERY.md).
- Legacy WebSocket signaling is payload-agnostic, but its operator can observe
  SDP/ICE. The new optional discovery path signs and encrypts SDP/ICE with derived
  project keys, validates membership, and binds negotiation to fresh mutual
  challenges. Relays still see their connecting clients' IPs and traffic metadata;
  they can withhold or record ciphertext. Replay protection uses bounded nonce
  tracking, expiry and fresh session challenges, with reasonable wall-clock agreement.
  Handshake completeness, malicious logical clocks and withheld history are not
  fully solved. This is not a Byzantine consensus system.
- Version 0.3.0 routed discovery uses opaque presence buckets and instance inboxes
  to reduce delivery fanout. Route tags are filters, not membership proofs;
  inner authentication and replay limits are unchanged. Relays still see IPs,
  opaque addresses and traffic patterns; authorized actors can grind placements
  or flood bounded views. Matching bucket layouts are required. See
  [routing contracts](docs/DISCOVERY_ROUTING.md).
- Local data is subject to browser quotas, eviction and deletion. Back up the
  encrypted vault, project metadata, event log and blob store together.
- Actor summaries, recipient envelopes, retained history, frames and connections
  have finite bounds. Current tests do not establish arbitrary project/user counts
  or a connected swarm under saturation. See [scalability](docs/SCALABILITY.md).

Detailed behavior: [Identity](docs/IDENTITY.md), [RBAC](docs/CRYPTO_RBAC.md),
[P2P](docs/P2P.md), [Discovery](docs/DISCOVERY.md), [Storage](docs/STORAGE.md),
[wallets and native policies](docs/POLICIES.md).

## Reporting

Use this repository's GitHub **Security → Report a vulnerability** for private
reporting. Include the affected version, a minimal reproduction and the impact.
Do not include real passwords, private keys or vault exports. Public issues are
appropriate for ordinary bugs; report security flaws privately first.
