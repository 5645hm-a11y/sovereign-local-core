# Install, inspect and publish

The package contains browser ESM entry points, TypeScript declarations, a
self-contained Worker with embedded WASM, the asset-copy CLI and documentation.
Consumers need no C++ compiler or install-time build. Version 0.3.1 adds adoption
and publication tooling without changing the engine runtime or binary formats.

## Install

Use the public GitHub release archive until registry publication is verified:

```sh
npm install --ignore-scripts https://github.com/5645hm-a11y/sovereign-local-core/releases/download/v0.3.1/sovereign-local-core-0.3.1.tgz
```

After a successful registry publication, the pinned registry command is
`npm install sovereign-local-core@0.3.1`. Check actual availability with
`npm view sovereign-local-core@0.3.1 version dist.integrity dist.attestations --json`.
A GitHub release or workflow does not establish registry publication or provenance.

Import the root SDK, `sovereign-local-core/react` or `sovereign-local-core/nostr`.
[Quick start](../README.md#quick-start), [two-device example](ADOPTION.md) and
[Worker/Next.js/CSP setup](DX.md) cover integration. GitHub source ZIPs are source
distributions, not prebuilt NPM bundles.

## Inspect the tested artifact

```sh
node scripts/verify-package.mjs artifacts/sovereign-local-core-0.3.1.tgz
npm publish ./artifacts/sovereign-local-core-0.3.1.tgz --dry-run --access public --ignore-scripts
```

The verifier reads tar files without installing or executing package code. It
checks package identity/version, required assets, forbidden install hooks, runtime
dependency changes and unexpected local/native-build data. It writes SHA-256,
SHA-512 and a scoped report to `artifacts/package-verification.json`. Its tests
reject an injected postinstall and an unreviewed dependency. This static check
and checksums are not an independent security audit.

## Provenance workflow

[publish.yml](../.github/workflows/publish.yml) is manually dispatched. It defaults
to verification only. Actions are pinned by commit. The build job has read-only
repository access; only the separate publication job receives `id-token: write`.

The build job runs unit, real-browser and installed-package tests, inspects the
final tested archive, runs a publication dry run and uploads that archive/report.
The publish job verifies its SHA-256 before `npm publish --provenance --access
public --ignore-scripts`. It does not rebuild. For an actual publish, dispatch
against the matching version tag, never `main`:

```sh
gh workflow run publish.yml --ref v0.3.1 -f publish=false
# Once account/registry authorization is configured:
gh workflow run publish.yml --ref v0.3.1 -f publish=true
```

### First publication and account requirements

NPM requires publishing authorization with 2FA or an appropriately configured
granular token. A browser login and `npm whoami` alone do not establish publishing
access. An E403 requiring 2FA needs the owner to complete account security setup.
Do not expose credentials to work around it.

For a package that does not yet exist, first publication must establish ownership.
To preserve provenance on the first version, use the verified GitHub workflow with
an appropriately authorized `NPM_TOKEN` repository secret. Configure secrets directly
in GitHub, never in source or chat. The workflow never prints the token. Account
policy or an OTP requirement can still block publication.

Once the package exists, configure its NPM **Trusted Publisher**:

| Field | Value |
| --- | --- |
| Owner | `5645hm-a11y` |
| Repository | `sovereign-local-core` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Action | Allow direct `npm publish` |

Then remove the bootstrap publishing token and publish via short-lived OIDC.
Complete the first trusted publication within NPM's configuration-validation
window. For public GitHub repositories/packages, trusted publishing supplies
provenance; the workflow additionally requests it explicitly. Inspect the registry
attestation and run `npm audit signatures` in a clean consumer after publication.

Official requirements: [NPM trusted publishers](https://docs.npmjs.com/trusted-publishers/),
[provenance](https://docs.npmjs.com/generating-provenance-statements/).
Provenance links build/source to an artifact; it does not prove harmless code.

## Rebuild from source

Use Node.js 24 and Emscripten 6.0.11 following [Contributing](../CONTRIBUTING.md).
Run `npm ci`, `npm test`, `npm run test:browser`, `npm run test:dx`, then
`npm run check:release` and the archive inspection above. `test:dx` packs and
installs the actual archive into Vite, React and Next.js examples and tests cleanup.
The separate [compatibility suite](BROWSER_SUPPORT.md) records unsupported engines
with failing results; failures must remain visible.

All versions remain experimental until an actual [independent review](SECURITY_REVIEW.md)
is completed. Publication does not change [security boundaries](../SECURITY.md)
or [finite resource limits](SCALABILITY.md).
