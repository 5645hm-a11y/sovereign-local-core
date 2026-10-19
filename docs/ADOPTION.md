# Evaluate Sovereign Local Core

This is an experimental browser database SDK with encrypted local persistence,
deterministic merging and peer-to-peer sync. It is more than a local IndexedDB
wrapper. It is also not a managed Firebase/Supabase service or a complete Google
authentication solution. Evaluate those requirements separately.

## Run a two-device proof

The [public HTTPS example](https://5645hm-a11y.github.io/sovereign-local-core/sync.html)
runs without a local compiler or development server. Use test wallets and synthetic
records only. This is a shared public demonstration origin, not your production
application's private origin. For a deployment you control, follow the steps below.

The [plain TypeScript example](../examples/vanilla-todo/sync.html) uses the installed
package, real Workers/OPFS, signed invitations and real WebRTC DataChannels.
It needs no application-owned signaling server. Public Nostr relays and STUN are
configured explicitly; substitute your relays/TURN when needed.

From a checkout, use Node.js 24. No C++ compiler is required when using a released
archive. In `examples/vanilla-todo`, install the tested release directly:

```sh
npm install --ignore-scripts https://github.com/5645hm-a11y/sovereign-local-core/releases/download/v0.3.1/sovereign-local-core-0.3.1.tgz
npm run dev
```

Open `http://127.0.0.1:4183/sync.html` in two browser profiles for a local test.
For two physical devices, run `npm run build`, host the generated `dist/` on an
HTTPS static origin, and open `/sync.html` on each device. A phone visiting
`http://<laptop-IP>:4183` is not a secure context and cannot use this OPFS path.
Use separate wallets; a shared email or project name does not grant membership.

1. Unlock device A with a new wallet ID and local passphrase. Create a project.
2. Unlock device B with its own wallet and send its public ActorID to A.
3. A creates a Member invitation for B. Deliver that text to B and confirm the
   root ActorID through a trusted channel. B verifies the invitation and joins.
4. Connect peers on both devices. A's pre-connection record should reach B.
   Toggle it on B and check the edit reaches A.
5. Pause B's sync. Add different records on A and B. Reconnect B; both should
   acquire the missing records. This is a partition simulation, not a promise
   that a browser keeps running when a phone sleeps.
6. Reload B, unlock the same wallet and reopen its project ID. Confirm persisted
   records before reconnecting. Lock the wallets to close Workers and networking.

The page checks Worker OPFS write/flush/read, Web Crypto and basic WASM. Actually
opening a project additionally exercises the complete compiled engine. A green
capability check alone is not a compatibility or performance certification.
The example displays at most 100 records and stores no passphrase/TURN secret in
localStorage. It remembers only the wallet and project IDs.

## Decide whether its availability model fits

| Requirement | Current contract |
| --- | --- |
| Work without internet | Local durable writes and reads on an initialized device |
| Synchronize devices | Authorized, reachable peers exchange event deltas over WebRTC |
| Discover peers | Encrypted public Nostr discovery or an injected provider |
| Reach restrictive NAT/firewalls | Supply a reachable TURN service; STUN is insufficient in some networks |
| Read while every replica is unavailable | Not provided; arrange an always-reachable replica or backup transport |
| Shared authorization | Root-signed membership and deterministic write policies |
| Private record groups | Independently keyed read domains; no hidden fields inside one shared-key log |
| Google login | Not included; Google OAuth identity and wallet/key enrollment need a separate design |
| Restore after device/browser data deletion | A backup/recovery process is required; a Google login does not recreate random wallet keys |
| Background phone synchronization | Not established; browser/OS suspension still applies |
| Arbitrary user counts, strict offline exclusivity | Not established; see finite limits and invariant semantics |

For an existing Capacitor app, test its actual Android System WebView and WKWebView
versions before replacing storage. Desktop Chrome success and emulated mobile
viewports do not establish compatibility on physical phones.

## Inspect before installing

The GitHub release provides checksums and a source manifest. SHA-256 proves byte
agreement with the published checksum, not the publisher's honesty. NPM provenance
links a registry artifact to its CI/source; it is not a security audit.

```sh
# From a checkout; does not install or execute the archive.
node scripts/verify-package.mjs artifacts/sovereign-local-core-0.3.1.tgz
```

The verifier checks required assets, metadata, lifecycle hooks, runtime dependency
changes and unexpected local-data/native-build files. The current distribution
has no install lifecycle hooks or required runtime NPM dependencies; React is an
optional peer and the Nostr bundle includes its documented cryptography dependency.
Use a disposable project with synthetic data for initial evaluation. Suppressing
install scripts does not sandbox code when subsequently imported or executed.

See [browser evidence](BROWSER_SUPPORT.md), [publication](PUBLISHING.md),
[security boundaries](../SECURITY.md) and [independent review scope](SECURITY_REVIEW.md).
