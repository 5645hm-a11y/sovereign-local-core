# Browser and mobile evidence

The supported baseline remains installed Google Chrome on a secure origin.
Do not infer support from a browser API existing, a mobile-sized screenshot,
the word WebKit, or a successful TypeScript build. Runtime feature availability
and durable storage behavior must be tested on the deployment device.

## Reproducible installed-package checks

The compatibility suite exercises the public example against the actual packaged
Worker/WASM. It tests two independent scenarios:

- Wallet creation/unlock, complete native startup, signed/encrypted durable OPFS
  write, reload, unlock and recovery.
- Separate wallets and browser contexts, root pin rejection, signed invitation,
  initial catch-up, bidirectional live edits, disconnected edits, reconnect, reload
  and clean resource disposal. Discovery uses a blind local Nostr relay fixture;
  the DataChannels, browser crypto and OPFS are real.

```sh
# First install/build the package into the examples, as described in ADOPTION.md.
npx playwright install chrome firefox webkit
npm run test:compat
node scripts/report-browser-support.mjs
```

The command exits nonzero for unsupported/failed engines. Do not change assertions
to turn an unavailable platform green. Full regression tests are `npm test`,
`npm run test:browser` and `npm run test:dx`; compatibility smoke tests alone do
not establish equivalent security, performance or long-duration behavior.

## Current matrix

Results below are desktop Windows automation on 2026-10-19. Exact versions,
outcomes, capability diagnostics and the packaged Worker hash are in the
[machine-readable evidence](benchmarks/browser-support.json).

| Target | Current evidence | Distribution status |
| --- | --- | --- |
| Google Chrome / Windows | Unit-independent full core/browser/DX suites; compatibility tests listed in the evidence | Primary tested baseline |
| Playwright Firefox / Windows | Native startup and OPFS persistence/reload passed; initial P2P catch-up timed out with the host-only ICE fixture | Local smoke passed, P2P unverified/failing in this fixture; not full regression parity |
| Playwright WebKit / Windows | OPFS capability probe failed; see exact stage/error in the evidence | Failing in this environment; do not claim support |
| Safari on macOS | No Safari product/device run | Unverified |
| Safari on physical iPhone/iPad | No physical-device run | Unverified |
| Chrome on physical Android | No physical-device run | Unverified |
| Capacitor Android System WebView | No embedded runtime run | Unverified |
| Capacitor iOS WKWebView | No embedded runtime run | Unverified |
| Edge / Chromium | No distinct Edge product run | Unverified |
| Next.js server rendering | Installed-package import/SSR tests; DB opens in a client component | Browser DB, not a Node server database |

Playwright WebKit is an automation engine, not the Safari application. A failed
Windows WebKit OPFS check does not prove Safari is broken; a passed check would
not prove Safari/iOS support either. Firefox's installed automation build also
does not substitute for testing the user's exact Firefox release/profile.

## Physical-device acceptance

Run the two-device example over HTTPS with synthetic data on each intended device,
OS/browser/WebView version and storage mode. Verify durable reload/restart,
invitation admission and live/offline/reconnect sync. Then test quota exhaustion,
browser data deletion, OS suspension/foreground recovery and restrictive networks
with a configured TURN service. Record exact versions and failures. Private modes,
embedded custom schemes and browser eviction can change behavior.

There is no background daemon in a suspended browser. Arrange a reachable replica
and tested backup/recovery plan for required availability. See [adoption](ADOPTION.md)
and [security boundaries](../SECURITY.md).
