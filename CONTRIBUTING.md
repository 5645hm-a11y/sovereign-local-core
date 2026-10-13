# Contributing

Thanks for helping build Sovereign Local Core. Small focused changes, clear
reproduction steps and measured improvements are welcome. This is an experimental
database core; its trust, durability and binary-compatibility contracts matter as
much as API ergonomics.

## Setup

Fork this repository, clone your fork and create a branch. Development is tested
with **Node.js 24**, **Python 3**, **Emscripten 6.0.11** and **Google Chrome**.

```sh
git clone https://github.com/emscripten-core/emsdk.git ../emsdk
cd ../emsdk
./emsdk install 6.0.11
./emsdk activate 6.0.11
source ./emsdk_env.sh
cd ../sovereign-local-core
npm ci
npm run build
```

On Windows use `emsdk.bat install 6.0.11`, `emsdk.bat activate 6.0.11` and run
`emsdk_env.bat` in the same Command Prompt before `npm ci`/build. Alternatively set
`EMSDK` to your activated SDK directory. An explicit `EMXX` compiler is also
supported. The build invokes `em++` with C++20, optimization and native WASM
exceptions; no C++ runtime library beyond the toolchain/standard library is added.
[Official SDK instructions](https://emscripten.org/docs/getting_started/downloads.html).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build:wasm` | Compile the native core for development/Node/Worker tests |
| `npm run build:ts` | Strict TypeScript build and declarations |
| `npm run build:package` | Build browser-only native glue and self-contained NPM bundles |
| `npm test` | Build and run crypto, CRDT, log/recovery, storage and native parity tests |
| `npm run test:browser` | Real OPFS/Worker/WebRTC tests using Chrome |
| `npm run test:dx` | Pack/install into isolated fixtures; Vite/Next SSR, hooks, assets and lifecycle |
| `npm run demo:prepare` | Build/install the tarball into the public React and TypeScript examples |
| `npm run demo:react` / `npm run demo:vanilla` | Run public examples on 4182 / 4183 |
| `npm run check:release` | Check staged release files, metadata, links and publication hygiene |
| `npm run benchmark` / `npm run benchmark:browser` | Reproduce native/bridge/recovery measurements |
| `npm run benchmark:invariants` | Measure business replay, exact duplicates, late conflicts and checkpoint restore |
| `npm run benchmark:sync` | Compare bulk, sequential and indexed cursor export using real crypto and an in-memory file |
| `npm run benchmark:discovery` | Reproduce the 10k synthetic routing fanout model (not a live swarm benchmark) |
| `npm run benchmark:epochs` | Measure bounded Merkle epoch pages using synthetic recipients/witnesses and real Root cryptography |
| `npm run benchmark:recovery` | Model routed recovery deliveries over 10k synthetic inboxes (not a live-swarm throughput test) |

Chrome can be installed for tests with `npx playwright install --with-deps chrome`.
Core browser fixtures use port 4174 and ephemeral signaling ports; DX fixtures use
4180, 4181 and 4190. Keep those ports available. The fixtures under `tests/fixtures`
have intentionally fixed synthetic credentials/IDs for reproducible assertions;
they are not production credentials or public application examples.

## Architecture map

- `native/`: C++ LWW registers, native sessions, ABI 1 and checkpoint serialization.
- `native/core_policy.inc`, `src/policies.ts`: pinned native row policies,
  conditional replay and versioned candidate checkpoints; see [contracts](docs/POLICIES.md).
- `src/read-domains.ts`, `read-domains-client.ts`: signed general-purpose namespaces,
  independent key/project partitions and role admission; see [read domains](docs/READ_DOMAINS.md)
  and [scalability contracts](docs/SCALABILITY.md).
- `src/engine.ts`, `project.ts`: authorization, cryptography, durable publication.
- `src/opfs.ts`, `framed-log.ts`, `checkpoints.ts`: recovery and persistence.
- `src/p2p-sync.ts`: legacy WebSocket discovery/WebRTC adapter.
- `src/sync-session.ts`, `rtc-byte-link.ts`: shared Streams protocol and RTC adapter.
- `src/framed-log.ts`, `local-store.ts`, `engine.ts`: fenced page reads and
  authenticated sync cursors; see [contracts and measurements](docs/SYNC_CURSORS.md).
- `src/log-offset-index.ts`, `checkpoints.ts`: authenticated durable addresses,
  bounded actor/sequence selection and old-checkpoint rebuild; see [indexed deltas](docs/SYNC_INDEX.md).
- `src/discovery*.ts`, `nostr-discovery.ts`, `p2p-webrtc.ts`: sealed discovery,
  optional public relays and authenticated WebRTC negotiation.
- `src/storage*.ts`, `blob-store.ts`: encrypted out-of-band chunks and lazy streams.
- `src/react*.ts`, `client.ts`, `worker.ts`: optional hooks and Worker lifecycle.
- `docs/`: security contracts, ABI, storage protocol and scoped benchmarks.

## Sending a change

Explain the problem and resulting behavior in a pull request. Include the relevant
validation and any compatibility or security implications. Run checks appropriate
to the change; native, persistence or protocol changes should run the full unit and
browser suites. Hooks/packaging/example changes should run installed-package DX
tests. Documentation changes should run `npm run check:release`.

Keep Worker-owned keys private. Validate incoming data before durable appends.
Do not publish or acknowledge unflushed state. Preserve signed historical bytes
and deterministic ordinal ordering. Document external services and make them
replaceable. Constructing the optional Nostr adapter selects its documented public
relays; the new WebRTC wrapper defaults to Google STUN as requested. The legacy
transport retains explicit ICE configuration. Never introduce telemetry endpoints.
Describe why a dependency is necessary.

`npx playwright test --config playwright.network.config.mjs` runs an optional
live test against public Nostr relays and Google STUN. It is separate from normal
CI and does not prove geographic NAT traversal. Read [DISCOVERY.md](docs/DISCOVERY.md)
for the current source APIs and security/network boundaries.

Native replay changes should run the [affected-row parity and benchmarks](docs/ROW_REPLAY.md).
The restore oracle is part of unit tests; optional independently compiled parity
needs a preserved pre-change WASM file. Benchmark one hot row with
`node scripts/benchmark-invariants.mjs --rows=1 --samples=3` as well as spread rows.

Field-query changes must preserve strict scalar types, UTF-16/tie ordering,
bounded scans, atomic reference maintenance, cache fallback and malformed-input failure. Read
[contracts/benchmarks](docs/FIELD_QUERIES.md) and run
`node scripts/benchmark-field-queries.mjs` separately from heavy tests.
For index changes, include [incremental maintenance](docs/INCREMENTAL_INDEXES.md)
cases for same-key rewiring, late row replay, resurrection, and 256/257-ID fallback.

React page changes must preserve one-page ownership, selective refresh,
late-result cleanup, finite retries and SSR/Strict Mode behavior. Read
[paged React contracts](docs/REACT_PAGED_QUERIES.md) and run installed-package tests.

Query changes should preserve full-view parity and revision invalidation; see
[query/receipt contracts](docs/QUERY_PAGES.md). After building, run
`node scripts/benchmark-queries.mjs --samples=5` and
`node scripts/benchmark-queries-browser.mjs` independently of test workloads.

For performance changes, preserve behavior first and report workload, environment,
warmups and medians. Separate kernel, bridge, crypto and disk/startup measurements.
A query Snapshot is not a recovery checkpoint. Read [CORE.md](docs/CORE.md),
[WASM.md](docs/WASM.md) and [CRYPTO_RBAC.md](docs/CRYPTO_RBAC.md) before changing those
boundaries. New bugs or meaningful behaviors deserve tests; avoid tests that only
restate an implementation.

## License and security

Contributions are made under the project's [MIT License](LICENSE), without an
additional contributor agreement. Report suspected vulnerabilities according to
[SECURITY.md](SECURITY.md); do not post credentials, vault exports or private keys
in a public issue.
