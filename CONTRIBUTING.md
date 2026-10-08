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

Chrome can be installed for tests with `npx playwright install --with-deps chrome`.
Core browser fixtures use port 4174 and ephemeral signaling ports; DX fixtures use
4180, 4181 and 4190. Keep those ports available. The fixtures under `tests/fixtures`
have intentionally fixed synthetic credentials/IDs for reproducible assertions;
they are not production credentials or public application examples.

## Architecture map

- `native/`: C++ LWW registers, native sessions, ABI 1 and checkpoint serialization.
- `src/engine.ts`, `project.ts`: authorization, cryptography, durable publication.
- `src/opfs.ts`, `framed-log.ts`, `checkpoints.ts`: recovery and persistence.
- `src/p2p-sync.ts`: transport, catch-up, framing and backpressure.
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
and deterministic ordinal ordering. Never introduce an implicit cloud relay,
public STUN service or telemetry endpoint. Describe why a dependency is necessary.

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
