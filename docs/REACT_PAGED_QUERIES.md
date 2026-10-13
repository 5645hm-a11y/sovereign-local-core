# React pages without whole-database views

Status: included in v0.3.0, not included in public v0.2.0.
The optional React entry exports `usePagedQuery` on top of native
[query cursors and compact receipts](QUERY_PAGES.md). Core has no React runtime
dependency; existing `useLiveQuery` remains supported.

```tsx
'use client';
import { useProject, usePagedQuery } from 'sovereign-local-core/react';

export function Records({ projectId, walletId, passphrase }) {
  const project = useProject(projectId, {
    mode: 'wallet', walletId, passphrase, createIfMissing: true,
  });
  const query = usePagedQuery(
    { kind: 'items', prefix: 'record_', limit: 64, maxBytes: 32768 },
    { project, refreshDelayMs: 25 },
  );
  return <section>
    {project.error && <p role="alert">{project.error.message}</p>}
    {query.error && <p role="alert">{query.error.message}</p>}
    {query.loading && <p>Reading?</p>}
    <ul>{query.page?.items.map(row => <li key={row.id}>{row.fields.title}</li>)}</ul>
    <button disabled={!query.canNext || query.loading} onClick={query.next}>Next page</button>
    <button disabled={project.status !== 'ready'} onClick={query.refresh}>Refresh</button>
  </section>;
}
```

Use `ProjectProvider` to omit the explicit `project` option. Share one project
owner across child hooks instead of opening multiple writers. For conditional
outcomes use `{ kind: 'decisions' }` and read `page.decisions`.
Writes should use `project.client.dispatchCommitted(...)` to avoid requesting a
full Snapshot through the legacy write API. File uploads, governance APIs and
explicit `snapshot()` calls retain their existing full-result contracts.

## Field descriptors

The same hook accepts [native field predicates and ordering](FIELD_QUERIES.md):
`where: [{ field: 'status', op: 'eq', value: 'open' }]`,
`orderBy: { field: 'priority', direction: 'desc' }`. Equivalent newly allocated
predicate objects retain the same store; changing a value creates a new one.
Notifications carry ciphertext, so refresh remains conservative for all data
changes in the selected prefix. Cold index builds and post-write builds after large deltas/restores remain an
additional native cost; small writes maintain existing caches. Read
[incremental index contracts](INCREMENTAL_INDEXES.md). The hook does not promise constant-time first reads.

## Result and retained-data contract

`usePagedQuery(queryOptions, { project?, refreshDelayMs? })` returns:

- `page`: a `QueryPage` or `null`; its selected item/decision array owns immutable
  values. The unused array is empty. Revision, Lamport, bytes and scan counts retain
  native page meaning.
- `pageIndex`: zero-based physical page number, reset to zero after refresh/restart.
- `loading`, `error`: request state. The last page can remain visible while loading
  or after a read error; a project/client switch clears it immediately.
- `canNext`: false while reading, on error, or after a final page.
- `next()`: replace the current page with the next page, if available.
- `refresh()`: restart at page zero; also retries an explicit error.

The store retains **one page, one cursor and one in-flight read**, not a growing
list of pages. Replaced pages are released by the store; callers/React may retain
references independently. Transient RPC, decoding and immutable-copy allocations
are additional costs. The underlying native projection, authenticated indexes,
event history and checkpoints are still resident/growing under their documented
bounds. This is not a whole-process constant-memory claim.

Per-page native limits still apply: at most 128 results, 1 MiB encoded output,
and 256 inspected item-index entries. An empty, non-final page after scanning
hidden rows remains navigable: `canNext` is true. `next()` does not silently drain
arbitrary hidden history or preload the rest of the database. Oversized rows surface
`QueryPageTooLargeError`; increase the descriptor budget within native bounds or
use streamed blobs for large values.

## Live refresh, consistency and retries

For item pages, a data event outside the selected ID prefix causes **no new read
or query-store notification**. Events inside the prefix and every governance event
schedule a first-page refresh. Decision pages conservatively refresh for all
commits. Duplicate retransmission emits no durable commit and causes no refresh.
The prefix is a selection descriptor, not a decryption/read permission.

Commits coalesce on a fixed first-dirty deadline, default 25 ms, configurable
0?1,000 ms. Subsequent commits do not move that deadline indefinitely. In-flight
reads carry a generation/client token; results superseded by a relevant commit,
query change, unmount or project/client switch are discarded and their cursors
closed. There is never a render-time query request or resource allocation.

Any durable event invalidates the engine cursor, including an unrelated-prefix
write. The existing visible page can remain valid for that prefix, but the store
marks its continuation stale internally. The next navigation safely restarts at
page zero. Relevant live refreshes also restart at page zero. **This hook does not
provide stable MVCC pagination, random page offsets, previous-page history or an
infinite-scroll accumulator.** Never concatenate pages from different revisions
into a purportedly consistent complete result.

An expired cursor or `QueryCursorInvalidatedError` permits one automatic first-page
restart per fetch. Repeated invalidation surfaces an error instead of an unbounded
retry loop. `refresh()` retries manually; future relevant commits can request a
new refresh. A continuously changing project can prevent a stable long scan.
Errors are checked by their RPC-preserved names because core and React bundles
may contain distinct class instances.

## Compact opening and legacy coexistence

The core client adds `openCompact(databaseName, credentials)` and
`createProjectCompact(...)`. They return `{ actorId, projectId, recovery }`,
without building, decoding, caching or transferring a full Snapshot. Recovery
still validates the same identity, pinned project metadata, cryptography,
checkpoints/log and native policy projection. It is not a reduced-security open.
Legacy `open` and `createProject` keep their full Snapshot result unchanged.

`useProject` now opens through the compact methods. Its published handle shape,
wallet/invitation rules, connection lifecycle and `createIfMissing` semantics
remain unchanged. A `useLiveQuery` subscriber requests the full view lazily.
The session refreshes full views only while those subscribers exist, keeps a valid
cache across same-render selector resubscriptions, and drops unused cached views
when the last subscriber leaves. A late legacy subscriber fetches current data;
it never receives a view left stale by paged-only writes.

A paged-only UI therefore performs no full-view query RPC on open or ordinary
compact commits. Mixing legacy and paged hooks is supported, but a legacy observer
or full-result write still pays the full Snapshot cost. Compact opening does not
make recovery O(delta), remove prefix verification/dedup indexes or eliminate
policy candidate replay. [Recovery and resource contracts](SCALABILITY.md) remain.

## Lifecycle and evidence

A stable external-store server snapshot makes imports and initial render safe for
Next.js SSR/hydration. Stores are created during render without IO; subscriptions
start work only on commit. Strict Mode teardown/reacquisition invalidates older
results rather than publishing them into the new subscription. Final unmount
clears timers, closes cursors, removes both commit/state observers and releases
Worker/P2P ownership through the existing project lifecycle.

Meaningful checks include:

- Unit tests for render purity, bounded replacement, rapid navigation, unrelated
  commits, coalesced bursts, expired/repeated invalidation, explicit retry,
  empty-page progress, late open/read cleanup, Strict Mode replay and project switch.
- Session tests proving no full-view fetch/cache for paged-only observers, and
  current-data refresh plus cache release for late legacy consumers.
- Real OPFS/Worker tests with native full Snapshot construction deliberately
  forbidden: compact create, writes, abrupt termination and compact reopen still
  produce the authenticated paged view. Legacy first-view failure/retry also passes.
- Installed-package Vite dev Strict Mode and production tests observe Worker RPCs:
  zero `snapshot` calls in the paged-only phase, no read on an unrelated edit,
  bounded visible rows, safe restart/navigation, live edits, descriptor switches,
  late legacy consumers, closed cursors/Workers and persisted reopen.
- Next.js production App Router SSR/hydration and typechecked public declarations
  exercise paged and legacy hooks together.

These are behavior/resource tests, not new latency benchmarks or a large-swarm
scale claim. Previous [native/OPFS timing scopes](QUERY_PAGES.md) remain unchanged.

```sh
npm run build:ts
node --test --test-concurrency=2 tests/unit/*.test.mjs
npx playwright test tests/browser/query.spec.mjs
npm run test:dx
```
