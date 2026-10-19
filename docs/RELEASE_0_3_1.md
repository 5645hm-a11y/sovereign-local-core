# Sovereign Local Core v0.3.1

Developer adoption and distribution release, 2026-10-19. The database engine,
C++ ABI, event/checkpoint formats and cryptographic runtime are unchanged from
0.3.0. This release adds no end-user business application.

## Try it on two devices

- Public plain TypeScript SDK example with separate wallets, trusted-root pinning,
  signed Member invitations, encrypted Nostr discovery and real WebRTC sync.
- Initial catch-up, bidirectional edits, paused/offline edits, reconnect and local
  OPFS recovery after reload. Locking the wallet closes networking and its Worker.
- Editable relay/STUN/TURN configuration and a Worker OPFS/crypto/WASM probe.
- A production build with relative asset URLs supports static hosting below a
  project path. Use synthetic data and test wallets on the public example origin.

See the [two-device walkthrough](ADOPTION.md) and
[public SDK example](https://5645hm-a11y.github.io/sovereign-local-core/sync.html).

## Inspect and reproduce

- `scripts/verify-package.mjs` reads the actual archive without executing its code,
  reports SHA-256/SHA-512, and rejects install hooks/unreviewed runtime dependencies.
  Three new tests verify those distribution checks.
- The installed-package DX suite now includes separate-wallet admission,
  initial/live/offline sync and OPFS recovery through real DataChannels.
- A manually dispatched GitHub workflow verifies/builds the package, transfers the
  tested archive to a separate least-privilege job and publishes with provenance.
  Real registry publication still needs NPM owner authorization. NPM currently
  rejected the authenticated account's publication until 2FA is configured.
- Verification-only workflow runs also generate signed GitHub/Sigstore provenance
  for the actual tested archive, verifiable with `gh attestation verify`. This
  provides build traceability before NPM publication; it is not an NPM attestation.
- Automated JavaScript/TypeScript CodeQL analysis is configured separately from
  the existing unit/browser/DX and credential scans.

## Browser and review evidence

Local validation passed 166 unit tests and 18 installed-package DX tests. The
release workflow also runs the full 49-test Chrome/OPFS/P2P regression suite;
its published run result is separate from the compatibility smoke below.

The separate Windows compatibility run passed local persistence and real P2P in
Chrome. Firefox passed local native startup/persistence/reload but its host-only
ICE P2P catch-up timed out. WebKit failed the OPFS directory probe in this
environment. These failures are recorded, not skipped or presented as support.
Physical Android/iOS, Safari and Capacitor WebViews remain unverified.
[Exact versions/results](benchmarks/browser-support.json),
[support matrix](BROWSER_SUPPORT.md).

The [independent security review packet](SECURITY_REVIEW.md) identifies boundaries,
attack scenarios and report criteria. No external human audit has been completed;
CodeQL/tests/provenance do not establish one. The release remains experimental.

The GitHub release supplies a prebuilt package, checksums and a source manifest.
Check [publication status/instructions](PUBLISHING.md) for registry availability.
