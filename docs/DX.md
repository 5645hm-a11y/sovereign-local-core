# NPM package and React integration

The package exposes `sovereign-local-core`, the optional `sovereign-local-core/react`
entry point and, since version 0.2.0, `sovereign-local-core/nostr`.
React is an optional peer dependency (`>=18 <20`); the core has no runtime NPM
dependencies. The separate Nostr entry bundles pinned `@noble/secp256k1` with its
MIT notice; importing core alone does not import that adapter. The project is MIT licensed. GitHub release artifacts can be installed
directly; registry publication remains pending. See the repository README for the
release download URL.

## Build and install

```sh
npm ci
npm run build:package
# Or pack: prepack rebuilds TypeScript, the browser WASM and all bundles.
npm pack --pack-destination artifacts

# Inside any external application, install the generated artifact:
npm install /path/to/sovereign-local-core-0.2.0.tgz
```

Create `artifacts` before using the last pack command if it does not exist.
Building the library needs the existing Emscripten SDK; consumers need neither
Emscripten nor a compiler. `scripts/build-package.mjs` uses esbuild to produce an
ESM core entry, separate Nostr entry, a React entry with a preserved `"use client"` directive,
TypeScript declarations, and a standalone Worker. The browser Emscripten build
excludes Node imports. Base ABI 1 remains supported; version 0.2.0 adds optional
policy/state-machine exports and versioned binary extensions. Build the Worker
and WASM together. See [native policy contracts](POLICIES.md).

The default NPM client starts an inline Blob Worker containing the native WASM
bytes. The Worker compiles those bytes asynchronously without fetching any WASM,
glue or relative worker imports. The core entry also embeds the bytes for its
existing low-level `LocalCore` export. This deliberate duplication makes the
published artifact self-contained; it is not a claim of a single shared buffer.
There is no hard-coded `/dist` URL, CDN or root-relative asset path. Imports are
SSR-safe; constructing/opening a client is browser-only and requires a secure
context, OPFS, Workers, Web Crypto and the current WASM exception support.

```ts
import { LocalCoreClient } from 'sovereign-local-core';

const db = new LocalCoreClient();
await db.createProject('team_local_replica', {
  projectId: 'team_project', email: 'user@example.com', password: userPassword,
}); // First creation only. Use open(...) on subsequent starts or with an invitation.
await db.dispatch({ type: 'ITEM_ADDED', itemId: 'task_1', fields: { title: 'Ship SDK' } });
await db.close();
```

## React

One `useProject` owns one client. Share that handle with `ProjectProvider`; do not
open another writer for the same actor/project/database in each child component.
`useLiveQuery` and `useStorage` also accept an explicit handle, useful without a
provider. `credentials` can be an inline object of primitive email/password fields;
keep nested `invitation`, `policies`, `clientOptions` and `p2p` configuration referentially stable
with `useMemo` or constants to avoid reopening the project on each render.

Version 0.2.0 also accepts email-free wallet credentials:
`useProject(projectId, {mode: 'wallet', walletId, passphrase, createIfMissing: true,
policies})`. `policies` must be stable and match the root-signed configuration;
use `libraryPolicies` once outside render or in `useMemo`. Existing hook P2P options
still use the legacy two-peer wrapper; attach `P2PWebRTC` explicitly to the ready
client for a mesh and stop it in your effect cleanup. Wallet/API declarations,
Kiosk invitations, CHECKOUT/RETURN, decisions and mesh options are consumer-typechecked.

```tsx
'use client'; // Next.js App Router component
import { useProject, ProjectProvider, useLiveQuery, useStorage } from 'sovereign-local-core/react';

function App({ projectId, email, password }) {
  const project = useProject(projectId, { email, password, createIfMissing: true });
  if (project.status === 'error') return <p>{project.error.message}</p>;
  if (project.status !== 'ready') return <p>Opening…</p>;
  return <ProjectProvider project={project}><Tasks client={project.client}/></ProjectProvider>;
}
function Tasks({ client }) {
  const { data: tasks = [], loading, error } = useLiveQuery(
    view => view.items.filter(item => item.fields.kind === 'task')
  );
  const storage = useStorage();
  async function addTask() {
    await client.dispatch({ type: 'ITEM_ADDED', itemId: `task_${crypto.randomUUID()}`,
      fields: { kind: 'task', title: 'A local task' } });
  }
  return <>
    <button onClick={() => void addTask()}>Add task</button>
    <input type="file" onChange={e => {
      const file = e.target.files?.[0];
      if (file) void storage.upload(file).catch(console.error);
    }}/>
    <p>{storage.progress?.completedChunks}/{storage.progress?.totalChunks}</p>
    <ul>{tasks.map(item => <li key={item.id}>{item.fields.title}</li>)}</ul>
  </>;
}
```

`useProject` returns `{status, client, connection, error, projectId, session}`.
The default database name is the project ID; specify `databaseName` for a distinct
replica. New members supply the signed `invitation`. Default `createIfMissing` is
false; true creates an Admin root only after `ProjectNotInitializedError`, never
after a password, integrity or conflicting-root error. P2P starts only if explicit
`p2p: { roomId, signalingUrl, iceServers? }` is supplied. It registers the connected
transport for lazy storage pulls, and exposes its connection state.

`useLiveQuery(queryFn, {project?, isEqual?})` is a synchronous pure projection of
the cached Snapshot, not an asynchronous database call. Commits coalesce Worker
snapshot refreshes; selectors compare only their projected results. The default
equality recursively compares scalars, arrays and plain records; supply `isEqual`
for Map/Set/class instances or expensive projections. The hook uses cached
`useSyncExternalStore` results and a stable server snapshot. Parent rerenders still
follow normal React rules; use `memo` when parent state changes independently.
See [React's external-store contract](https://react.dev/reference/react/useSyncExternalStore).

`useStorage(project?)` returns `{status, progress, error, upload, readBlob, pipeTo,
cancel}`. Each hook allows one active operation; separate hooks may operate
concurrently within existing transport bounds. Progress is
`{direction, fileId, completedChunks, totalChunks, processedBytes, totalBytes,
cachedChunks}`. Upload counts **prepared, encrypted, durably stored local chunks**,
not bytes pushed to peers: this protocol is pull-only. Its final metadata commit
must still succeed before status becomes `success`. Download counts verified chunks
available to the consumer, distinguishing cache hits through `cachedChunks`.
Use `pipeTo` for large files; `readBlob` keeps the existing 16 MiB cap.

Core storage methods also accept `onProgress` and `signal`. Callbacks are stripped
before structured cloning and forwarded through request-correlated Worker progress
messages. Cancel reaches the Worker outside its serialized operation queue and
stops uploads at chunk boundaries before metadata publication. Already flushed
orphan chunks may remain. Once signing/committing starts, cancellation cannot undo
a durable event. Cancellation is not transactional rollback.

Strict Mode effect replay reacquires the same session before deferred cleanup runs.
Actual unmount stops P2P, unsubscribes observers and closes the client gracefully.
Open/close transitions are serialized to avoid lease races across credentials and
project changes. Storage-hook cleanup aborts its operation and suppresses late
state updates. React's effects and initial client creation execute only in the
browser; see [effect lifecycle](https://react.dev/reference/react/useEffect).

## CSP and explicit assets

The default inline Worker requires `worker-src blob:` in your CSP. Configure your
application's WebAssembly execution policy as well. If Blob Workers are blocked,
copy the standalone, self-contained Worker to your own public directory:

```sh
npx p2p-core-copy-assets public/p2p-core
```

```ts
const options = { workerUrl: '/your-base-path/p2p-core/worker.js' };
const db = new LocalCoreClient(options);
// React: useProject(id, {email, password, clientOptions: options})
```

The hosted Worker needs no neighboring `.wasm` or glue files. Its URL must follow
your deployment's basePath, and the server must send it as JavaScript. Alternatively
provide `workerFactory: () => new Worker(yourUrl, {type: 'module'})`; ownership is
transferred to LocalCoreClient, which terminates it on close. Do not share one
Worker between clients. No SharedArrayBuffer/COOP/COEP configuration is required.

## Example and verification

`examples/react-demo` installs the actual tarball, uses React Strict Mode, and
demonstrates task dispatch, live queries, encrypted file upload/progress,
streamed export and close/reopen. It asks for credentials and generates a random
project ID; passwords are not persisted by its UI. Deterministic render diagnostics,
fixed synthetic credentials and nested base-path checks live in `tests/fixtures`.

```sh
npm run demo:prepare
npm run demo:react
# http://127.0.0.1:4182
```

For the complete installed-package verification:

```sh
npm run test:dx
```

That command packs/rebuilds, installs the tarball into Vite and Next fixtures,
checks consumer TypeScript declarations, builds the public examples and fixture apps,
then runs browser tests.
It tests Vite dev/production and Next App Router SSR/hydration with nested asset
base paths, selector render suppression, chunk progress/Worker cancellation,
Strict Mode cleanup/reopen, real signaling/PeerConnection/DataChannel cleanup and
a hosted Worker under `worker-src 'self'`. Next fixtures support both
`npm run build` (Turbopack) and `npm run build:webpack`.

Verified in this workspace: **75 unit tests**, **30 core browser tests**, and all
**9 installed-package DX browser tests** passed, including task creation, editing,
reload recovery and cleanup in both public examples. Consumer TypeScript checks and
Vite production/Next Turbopack production builds passed; the Next Webpack build
was also exercised during integration. The optional Nostr entry is checked during
SSR import, consumer type checking and a production bundle under a nested base path.
The tests use Chrome, React 19.3, Vite 8.3
and Next 16.4; the React 18 peer range has not been separately exercised here.

## Public or private registry

The canonical package name is `sovereign-local-core`, with the MIT License and public
access configured in package.json. The artifact whitelist includes only
bundles, declarations, the asset-copy CLI and documentation, excluding vaults,
database files, SDK downloads, examples and tests. No install script compiles WASM
on consumer machines.

```sh
# After authenticating to your registry and verifying package-name availability:
npm publish --access public
```

For a private registry configure your `.npmrc`, or use an organization-owned scoped
name and `--access restricted`. GitHub publication and npm publication are separate;
the npm publish command has not been executed.
