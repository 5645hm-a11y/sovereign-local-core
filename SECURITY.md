# Security boundaries and reporting

Version 0.2.0 is experimental and has not received an independent security audit.
The tests cover selected integrity, authorization, recovery and transport behaviors;
passing tests are not proof of complete security.
No avionics, safety-critical or regulatory certification is claimed.

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
- CHECKOUT/RETURN decisions converge for the same authorized event set. Offline
  acceptance is provisional; late earlier events can change a previous winner.
  This does not prevent two disconnected kiosks physically handing out a resource.
  Strict offline exclusivity needs escrow or coordination. Business replay retains
  bounded candidate history; an authorized actor can still cause resource pressure
  or choose misleading Lamport clocks. No independent audit or consensus is claimed.
- Revocation cannot recover old plaintext/keys from a recipient. A disconnected
  peer enforces a revocation after learning it. Only root-witnessed historical
  payloads survive the conservative offline revocation rule.
- Legacy WebSocket signaling is payload-agnostic, but its operator can observe
  SDP/ICE. The new optional discovery path signs and encrypts SDP/ICE with derived
  project keys, validates membership, and binds negotiation to fresh mutual
  challenges. Relays still see their connecting clients' IPs and traffic metadata;
  they can withhold or record ciphertext. Replay protection uses bounded nonce
  tracking, expiry and fresh session challenges, with reasonable wall-clock agreement.
  Handshake completeness, malicious logical clocks and withheld history are not
  fully solved. This is not a Byzantine consensus system.
- Local data is subject to browser quotas, eviction and deletion. Back up the
  encrypted vault, project metadata, event log and blob store together.

Detailed behavior: [Identity](docs/IDENTITY.md), [RBAC](docs/CRYPTO_RBAC.md),
[P2P](docs/P2P.md), [Discovery](docs/DISCOVERY.md), [Storage](docs/STORAGE.md),
[wallets and native policies](docs/POLICIES.md).

## Reporting

Use this repository's GitHub **Security → Report a vulnerability** for private
reporting. Include the affected version, a minimal reproduction and the impact.
Do not include real passwords, private keys or vault exports. Public issues are
appropriate for ordinary bugs; report security flaws privately first.
