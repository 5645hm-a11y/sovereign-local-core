# Security boundaries and reporting

Version 0.1.0 is experimental and has not received an independent security audit.
The tests cover selected integrity, authorization, recovery and transport behaviors;
passing tests are not proof of complete security.

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
- Revocation cannot recover old plaintext/keys from a recipient. A disconnected
  peer enforces a revocation after learning it. Only root-witnessed historical
  payloads survive the conservative offline revocation rule.
- Signaling is non-persistent and payload-agnostic, but its operator can observe
  SDP/ICE. Handshake completeness, malicious logical clocks and withheld history
  are not fully solved. This is not a Byzantine consensus system.
- Local data is subject to browser quotas, eviction and deletion. Back up the
  encrypted vault, project metadata, event log and blob store together.

Detailed behavior: [Identity](docs/IDENTITY.md), [RBAC](docs/CRYPTO_RBAC.md),
[P2P](docs/P2P.md), [Storage](docs/STORAGE.md).

## Reporting

Use this repository's GitHub **Security → Report a vulnerability** for private
reporting. Include the affected version, a minimal reproduction and the impact.
Do not include real passwords, private keys or vault exports. Public issues are
appropriate for ordinary bugs; report security flaws privately first.
