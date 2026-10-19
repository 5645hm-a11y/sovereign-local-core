# Independent security review: scope and handoff

**Status: no independent review has been commissioned or completed.** This document
is a review packet, not an attestation. Local tests, GitHub CodeQL, Gitleaks and
NPM provenance must not be described as a human independent audit. A reviewer
must identify the exact source commit, compiled artifact hashes and methodology
before conclusions can apply to any release.

## Material supplied to the reviewer

- Public source, release tag, packaged Worker/WASM and archive checksum/manifest.
- [Trust boundaries](../SECURITY.md), [identity](IDENTITY.md),
  [membership/key rotation](CRYPTO_RBAC.md), [read domains](READ_DOMAINS.md),
  [native policies](POLICIES.md), [recovery](DISCOVERY_RECOVERY.md),
  [storage](STORAGE.md) and [finite limits](SCALABILITY.md).
- Unit tests under `tests/unit`, real-Worker/OPFS/WebRTC tests under `tests/browser`
  and installed-package tests under `tests/dx`. Tests use synthetic credentials.
- The public two-device example: untrusted invitation root mismatch, membership
  admission, initial/live sync, disconnected edits, OPFS reload and resource cleanup.
- The archive inspection tool `scripts/verify-package.mjs`. Review the tool itself;
  its success means only the specified static checks passed.

## Boundaries and questions to attack

| Boundary / entry points | Required adversarial checks |
| --- | --- |
| Vault: `identity.ts`, `identity-storage.ts` | KDF parameters, randomness, AEAD nonce/AAD binding, corrupted vaults, passphrase handling, key exposure and recovery limits |
| Admission: `validation.ts`, `certificates.ts`, `project.ts`, `engine.ts` | Signature canonicalization, project binding, pinned roots, role delegation, replay/equivocation, old history and revocation races |
| Private reads: `read-domains*.ts`, `project-storage.ts` | Wrong-domain admission, descriptor/routing substitution, key-envelope recipients, private file/event leakage, revoked-reader history |
| Binary/native boundary: `binary-*.ts`, `wasm-loader.ts`, `native/core_engine.cpp` | Overflow, truncated frames, invalid lengths, pointer bounds, deterministic policy replay, allocation failures and checkpoint poisoning |
| Peer transport: `sync-session.ts`, `p2p-webrtc.ts`, `discovery-*.ts`, `nostr-discovery.ts` | Unauthenticated SDP, transcript binding, replay windows, malicious clocks, reordered/duplicate messages, relay withholding, resource exhaustion and connection churn |
| Recovery: `discovery-recovery*.ts`, `epoch-pages.ts` | Recipient substitution, stale-key bootstrap, fragment offset/session binding, partial epochs and denial-of-service limits |
| Persistence: `framed-log.ts`, `local-store.ts`, `opfs.ts`, `checkpoints.ts` | Crash boundaries, uncertain commit semantics, torn records, stale index/checkpoint use, malicious local bytes and quota exhaustion |
| Files: `storage*.ts`, `blob-store.ts` | Chunk hash/AEAD order, manifest binding, stream cancellation, size limits, cross-project requests and partial-upload cleanup |
| Distribution / UI origin | Install hooks, bundled dependencies, build-to-source traceability, XSS/CSP boundaries and compromised unlocked origins |

A malicious authorized writer and relay operator are in scope. Honest replicas
must reject forged signatures and unauthorized controls. An origin that already
executes malicious JavaScript can use its unlocked identity: no claim that the
Worker protects against a fully compromised same-origin application is made.

## Reproduce and report

Use Node.js 24 and Emscripten 6.0.11 following [Contributing](../CONTRIBUTING.md).
Run `npm ci`, `npm test`, `npm run test:browser`, `npm run test:dx`, and the archive
inspection command. `npm run test:compat` is a separate platform smoke test, not
the security regression suite. Run static analysis and fuzz parsers/reducers with
synthetic keys and data; do not use production secrets.

Each finding should include the pinned commit/artifact, affected boundary,
attacker prerequisites, minimal reproduction, concrete impact, severity and
remediation/retest evidence. Record untested areas and environment limitations.
Use private vulnerability reporting from [SECURITY.md](../SECURITY.md); publish
only agreed disclosure material. Maintainers must arrange an external review
engagement; this packet does not establish one.

## Completion criteria

An actual external reviewer produces an attributable report against pinned bytes;
critical/high findings receive fixes and independent retesting; the public status
links the report and names exclusions. Until then the release remains experimental
and unaudited. Passing automated scans does not change this status.
