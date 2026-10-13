# Bounded native reads and durable event receipts

Status: included in v0.3.0; public v0.2.0 predates these APIs.
These APIs work for general-purpose project rows and existing conditional
outcomes. They add no application-specific schema and grant no new permissions.

## Why this follows affected-row replay

[Affected-row replay](ROW_REPLAY.md) avoids reducing unrelated history. Previously,
every durable event still serialized the entire C++ view and every business
decision into JS, even when a sync session needed only an acknowledgement.
That full output could dominate the optimized reducer and create large Worker
replies. The new receipt path skips that output, and bounded reads page directly
from native ordered indexes rather than slicing a previously built Snapshot.

```ts
const receipt = await db.dispatchCommitted({
  type: 'ITEM_ADDED', itemId: 'record_1', fields: { title: 'Local record' },
});
// receipt.event is signed/encrypted; receipt.revision is local durable event count.

const cursor = await db.openQueryCursor({
  kind: 'items', prefix: 'record_', limit: 64, maxBytes: 32 * 1024,
});
try {
  while (true) {
    const page = await db.readQueryCursor(cursor.id);
    consumeRows(page.items); // Process/discard pages instead of collecting all of them.
    if (page.done) break;
  }
} finally {
  await db.closeQueryCursor(cursor.id);
}
```

To audit conditional outcomes, use `{ kind: 'decisions' }` and consume
`page.decisions`. Only outcomes already present in the legacy Snapshot are
returned: successful ordinary LWW writes do not gain synthetic decision entries.

## Receipt and security contracts

`dispatchCommitted(command)` returns `{ event, lamport, revision }` after normal
signature, certificate/epoch, native role/policy and append/flush processing.
`ingestCommitted(events)` returns `{ applied, summary, lamport, revision }` after
the same admission path as `ingestEvents`. An eligible durable CHECKOUT may still
have `REJECTED_CONFLICT` in its current decision view. **Durability is not final
business acceptance or global finality.** Late events can change provisional
outcomes. No plaintext fields, wallet secrets or project keys are added to receipts.

`SyncSession` prefers the optional `ISyncCore.ingestCommitted` method for durable
ACKs and falls back to `ingestEvents` for older/custom cores. Wire messages and ACK
ordering do not change. Flush failure still faults the core, returns no successful
receipt and blocks further queries until close/reopen. A rejected signature/static
policy/equivocation does not append, increment revision or invalidate a cursor.
Exact duplicate retransmission changes neither revision nor log state.

The native reducer is still applied before disk publication, inside the serialized
engine queue. Query RPCs cannot run against an unflushed intermediate state.
Read pages use only the existing locally authenticated, authorized materialized
projection. An ID prefix is a selection rule, **not cryptographic read isolation**;
use separately keyed [read domains](READ_DOMAINS.md) for confidential data.

Full decoded views are lazy caches. Compact writes invalidate that cache; legacy
`dispatch`, `ingestEvents`, `snapshot`, invitations, uploads and revocations retain
their full Snapshot contracts. Legacy write paths still build their view before
append. `LocalCore.open` no longer eagerly decodes the whole view, but the existing
client open RPC explicitly requests a full Snapshot, preserving its response.
`useLiveQuery(queryFn)` still consumes full cached views; arbitrary JS closures
are not executed in the Worker. The newer [paged React hook](REACT_PAGED_QUERIES.md)
uses one page and selectively refreshes it. Additive `openCompact` and
`createProjectCompact` omit Snapshot construction/output; React sessions now use
those and only fetch full views for legacy subscribers. Existing full-view APIs
and native recovery/index costs remain.

## Page and lifecycle contracts

`openQueryCursor(options)` returns `{ id, revision }`; its options are copied and
normalized. `readQueryCursor(id)` returns:

```ts
{
  kind, revision, lamport, items, decisions, done, scanned, encodedBytes
}
```

The selected array holds results; the other is empty. Items follow ordinal item-ID
order; decisions follow `(Lamport, ordinal ActorID, sequence)` order, preserving
full-replay behavior after late events and checkpoint restore. Tombstones and
unborn records never appear as visible items.

| Contract | Bound |
| --- | --- |
| Records returned per page | default/maximum 128; configurable 1?128 |
| Native binary page bytes | default 64 KiB; configurable 1 KiB?1 MiB |
| Item-index entries inspected per page | maximum 256, including hidden rows |
| Active cursors per core | maximum 32 |
| Idle lifetime | defaults to 60 seconds; shares the core's configured sync-cursor idle timeout |
| ID prefix | 0?128 ASCII identifier characters; items only |

Native sizing checks precede record serialization. A record that cannot fit in
an otherwise empty page raises `QueryPageTooLargeError` and closes the cursor;
there is no silent truncation or soft budget overrun. Request a larger budget
within 1 MiB or store large content as streamed blobs. Reserved trailer space
makes the usable payload smaller than `maxBytes`. Native encoded bytes are not
an exact bound on JS heap, decoded string memory or structured-clone wire size.
The runtime's output vector can retain capacity from earlier full reads.

A page may be **empty and non-final** after scanning 256 hidden rows. Its keyset
position advances, so consumers must continue until `done`, not stop at an empty
array. Each page owns bounded decoded values, not retained native output pointers.
The engine retains only small cursor options/positions; it never clones the
full database for a cursor.

Cursors fence a **local durable revision**, not a global clock or a persistent
MVCC snapshot. Any new durable event, including a governance preparation, makes
older cursors invalid. The next read raises `QueryCursorInvalidatedError` and
releases the slot. Consumers must discard an incomplete assembled result and
restart if they need one consistent revision; they must not combine pre-change
and restarted pages. High write rates can repeatedly invalidate long scans.

Completed, rejected, expired, explicitly closed and engine-shutdown cursors are
released. Unread invalidated cursors remain bounded by the slot cap/idle timeout.
Cursor IDs and positions are instance-local: restart always requires opening a
new cursor. Both typed query errors survive Worker RPC as exported error classes.

## Native field descriptors (v0.3.0)

`where` adds up to four flat scalar AND predicates; `orderBy` selects deterministic
single-field order. `index: 'scan'` keeps ID-order filtering without index builds.
SQR/SQP v2 supplies disposable reference indexes with finite key/entry/cache bounds;
small mutations maintain them; large deltas/restores invalidate affected caches.
Durable writes still invalidate cursors. Cold builds are separate from page scans. Read
[field-query semantics, ABI and measurements](FIELD_QUERIES.md). Default unfiltered
requests retain the version-1 layout below.

## Additive ABI 1 extension

`core_session_query(handle, pointer, byteLength)` accepts SQR1 and emits SQP1.
Status: 0 success, 1 invalid input/handle, 2 allocation failure, 4 record exceeds
page budget. Failure clears output and leaves native state/history unchanged.
It uses the shared synchronous output arena; copy/decode before another native
call. Existing view/checkpoint bytes and ABI version 1 are unchanged. An old
binary without this optional export fails an explicit query request; it does
not silently build and slice a full Snapshot.

All fields are little-endian; strings are u32-length UTF-16LE.

- Input: `magic=0x31525153, version=1, mode, limit, maxBytes`, then prefix string,
  after-item string, after-Lamport u64, after-sequence u64, after-ActorID string.
  Mode 1 uses item keyset state; mode 2 uses decision total-order state. Unused
  position/prefix fields must be empty/zero. Keysets are engine-owned, not public
  client-controlled continuation tokens.
- Output: `magic=0x31505153, version=1, mode, count, totalBytes, done, scanned`,
  followed by item or decision entries and then the next item/Lamport/sequence/actor
  tuple in the same field encoding. Item/decision entries use their existing
  SOV formats. Unlike SOV/SCK, SQP totalBytes is at byte offset 16.

## Measurements: 2026-10-12

Windows x64, Intel Core i7-10700 @ 2.90 GHz; Node 24.15.0 / installed headless
Chrome; Emscripten 6.0.11, C++20 `-O3 -flto`. Raw reports include binary SHA-256,
compiler/browser metadata, samples and scopes.

Node policy projection, one warm-up and five samples, medians in milliseconds:

| Retained candidates | Visible rows | Full rows + decisions | First ?128 item rows | First ?128 decisions |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 200 | 1.14 | 0.41 | 0.10 |
| 10,000 | 2,000 | 10.95 | 0.42 | 0.09 |
| 50,000 | 10,000 | 45.27 | 0.40 | 0.09 |
| 99,000 | 19,800 | 103.68 | 0.41 | 0.10 |

These measure Node WASM, binary bridge and JS decoding with trusted roles and
producer-encoded decrypted commands. They exclude crypto, OPFS, RPC, network and
module startup. First pages are partial results, not faster complete-result
materialization. Complete page drains are separately asserted byte-value-equal
to full views before timing. Record widths are fixed in this workload.

Real Chrome Worker/OPFS, policy-free LWW rows, milliseconds:

| Rows | Full-view dispatch p50 / p95 / p99 | Receipt dispatch p50 / p95 / p99 | One-row query p50 / p95 / p99 |
| ---: | ---: | ---: | ---: |
| 1,000 | 4.90 / 5.50 / 9.90 | 2.40 / 2.90 / 4.00 | 0.20 / 1.30 / 2.50 |
| 5,000 | 17.10 / 17.90 / 18.10 | 2.50 / 3.70 / 4.90 | 0.30 / 3.50 / 5.00 |

Each browser profile seeds/flushed rows via receipts, then alternates write-path
order for three warm-up pairs and 50 measured pairs. Times include Web Crypto,
authorization, native apply, per-event OPFS flush, commit notification and Worker
RPC. Full-view dispatch additionally returns the complete structured-cloned
view. Query includes open/read/close RPCs and matches exactly one ID prefix.
Both write results and durable reopen equality are asserted. Timed writes remain
between checkpoints after seeding: periodic encrypted-cache writes, startup,
network, business-policy replay and UI query listeners are excluded. Descriptive
p95/p99 from 50 observations are not production latency guarantees.

The Node core profile additionally compares real crypto plus a **simulated flushed
file**, not OPFS: at 10,000 rows full-view dispatch/receipt medians were
42.13 / 14.99 ms. Its Device copies the file on write/flush, so those values should
not be substituted for browser disk behavior.

Raw records: [Node pages/core](benchmarks/query-pages-node.json),
[Chrome Worker/OPFS](benchmarks/query-pages-browser.json).

```sh
npm run build
node --test --test-concurrency=2 tests/unit/*.test.mjs
npx playwright test
npm run test:dx
# Run measurements separately from tests/heavy workloads:
node scripts/benchmark-queries.mjs --samples=5
node scripts/benchmark-queries-browser.mjs
```

The scripts write `artifacts/benchmark-queries-node.json` and
`artifacts/benchmark-queries-browser.json`. Tests cover bounded native output,
empty-page progress, full-view/restore parity, late winner decisions, oversize
failure, no Snapshot calls on receipts, local/remote role denial before append,
revision invalidation, duplicate stability, capacity/expiry, flush faults,
real OPFS restart, first-view failure/lock cleanup and same-Worker retry, durable
sync ACK/backpressure and installed embedded WASM/RPC.
Historical candidates, full governance, actor indexes and checkpoint recovery
still grow; paging does not establish unlimited users/history or global query
isolation. Future work includes field indexes, bounded React query subscriptions,
MVCC/delta queries and disk-resident history; see [scalability](SCALABILITY.md).
