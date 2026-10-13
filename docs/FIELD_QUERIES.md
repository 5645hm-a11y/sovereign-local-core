# Native field predicates and disposable indexes

Status: included in v0.3.0; public v0.2.0 predates these APIs.
`QueryOptions` now supports bounded flat-field predicates and single-field
ordering. Validation, filtering, ordering and seeking run in C++/WASM. Only
matching page rows are decoded/transferred to JS. Existing ID-prefix and
decision queries keep their old formats/behavior.

```ts
const cursor = await db.openQueryCursor({
  kind: 'items', prefix: 'record_',
  where: [
    { field: 'status', op: 'eq', value: 'open' },
    { field: 'priority', op: 'gte', value: 3 },
  ],
  orderBy: { field: 'priority', direction: 'desc' },
  limit: 64, maxBytes: 32768,
});
try {
  while (true) {
    const page = await db.readQueryCursor(cursor.id);
    consumeRows(page.items);
    if (page.done) break;
  }
} finally { await db.closeQueryCursor(cursor.id); }
```

The same descriptor works with `usePagedQuery`:

```tsx
const query = usePagedQuery({
  kind: 'items', prefix: 'record_',
  where: [{ field: 'status', op: 'eq', value: selectedStatus }],
  orderBy: { field: 'priority', direction: 'desc' }, limit: 32,
}, { project });
```

Descriptor dependencies use framed scalar keys, so newly created but equal
predicate/order objects do not reopen the cursor on every React render. Changing
an operand, order, prefix or scan mode starts a new store and cleans the old cursor.
Encrypted commit notifications do not expose enough fields to test predicates;
React still refreshes conservatively on any data event in the selected prefix.

## Deterministic semantics

- `where` contains up to four AND predicates: `eq`, `gt`, `gte`, `lt`, `lte`.
  They address flat field keys, not object paths or executable JS functions.
- Equality supports null, booleans, finite numbers and strings. No type coercion:
  number 3 does not match string '3', and a missing field does not match null.
- Ranges support numbers and strings only, and match only the operand's type.
  Strings compare ordinal UTF-16 code units, preserving BOM/non-BMP/lone surrogates;
  there is no locale sorting, case folding or Unicode normalization.
- Numbers retain the existing IEEE-754 field semantics, including `-0 -> +0`.
  NaN/infinity and non-scalar operands are rejected. Strings in predicates/index
  continuation keys are bounded to 1,024 UTF-16 units; field names to 128 units.
- `orderBy` names one field, ascending by default. Ascending mixed-type order is
  **null, false, true, number, string, missing**, then ordinal item ID. Descending
  reverses the entire `(value, item ID)` tuple, including ties and missing placement.
- Without ordering, results follow item-ID order. Auto-indexed equality buckets
  preserve that order because every eligible row shares that equality value.
  Typed lower/upper bounds are intersected before iteration; contradictory
  same-field constraints return an empty final page.
- Decisions do not accept predicates/order/scan mode. Tombstones/unborn items are
  excluded, and unchanged native policy authorization still precedes all reads.

No GROUP BY, aggregates, joins, OR, full-text search, composite indexes, computed
fields or cross-domain transaction/query semantics are added. A local descriptor
is not an authorization rule: [read domains](READ_DOMAINS.md) still provide
cryptographic confidentiality.

## Execution plans and limits

`index: 'auto'` is the default:

1. Explicit `orderBy` selects an index scoped to `(ID prefix, field)`.
2. Otherwise the first equality predicate selects a value bucket from that field
   index; returned IDs remain ascending.
3. Otherwise a bounded item-ID scan evaluates predicates in native code.

The chosen index's equality/range predicates establish binary-search bounds;
remaining predicates are residual filters. There is no index intersection or
cost-based planner. A selective residual filter can still produce empty pages.

`index: 'scan'` forces ID-order predicate evaluation without building an index.
It cannot be combined with `orderBy`. This is useful for one-off reads or fields
whose other values exceed the index limits. Each page inspects at most 256 native
entries and returns at most 128 rows within the 1 KiB?1 MiB native page budget.
An empty non-final page makes progress and must not be mistaken for completion.

A cold field index inspects its whole prefix range, including hidden rows, up to
**100,000 entries**, with a **16 MiB accounted-key budget**. Indexed string values
must be at most 1,024 UTF-16 units. Any exceeded limit raises exported
`QueryIndexLimitError`; no rows are silently omitted, and the core remains usable.
Narrow the prefix or explicitly use scan mode. The accounted budget includes
reference/key-encoding estimates; it is not live heap or an exact memory ceiling.

Each native session retains at most **two indexes**, evicting the least recently
used `(prefix, field)` cache. Indexes are sorted vectors of references to existing
owned rows, IDs and values; they never copy whole rows or field strings. A source
already in field/ID order needs no sort. At most 256 distinct values use a small
value directory and stable bucket placement; other unsorted fields use comparison
sorting. Build/sort work is additional to the 256-entry page scan and can block the
Worker during that native call. Diagnostics separate `indexBuildScanned` from
`scanned`, and report `indexKeyBytes` for the selected cache.

Small writes maintain existing indexes before publishing replacement row nodes.
Up to 256 affected IDs per cached prefix are patched; unrelated prefixes remain
warm. Unchanged sort keys only rewire references. Changed keys, creates, deletes
and row-local late replay remove/insert sorted references, update accounted bytes
and track hidden prefix entries. All parsing, authorization, reduction, allocation
and reservation finish before any cache/row publication. Failed atomic apply
leaves contents intact; capacity reservations may remain. Exact policy retries
perform no index work.

The sorted vector can still move O(n) references for a changed key. Insertions use
binary search and block moves; same-key edits do not move the vector. A delta with
more than 256 affected IDs invalidates that prefix's cache. Over-limit keys/bytes
or prefix-entry counts also drop the affected cache without rejecting a valid
write. A later query rebuilds or raises `QueryIndexLimitError`; explicit scans
remain available. Full restore, reset, initial policy replay and governance
reprojection still clear caches. These are derived indexes, not event history.

Builds and delta patches are staged before cache publication. Transient sort
vectors, two patch lists, reserved capacity and a third index during LRU builds
are outside logical accounted-key budgets. WASM retains its global 512 MiB bound
and can run out of memory before a logical limit. Read
[incremental maintenance and post-write measurements](INCREMENTAL_INDEXES.md).

Cursors retain only their descriptor, revision and keyset tuple; an evicted index
can be rebuilt for continuation at the same revision. Durable writes invalidate
cursors as before. These are not MVCC snapshots. Oversized row or continuation
output raises `QueryPageTooLargeError`, never a soft page-budget overrun.

## Additive ABI and persistence compatibility

Base C ABI remains 1. `core_session_query` supports both SQR/SQP version 1 and 2.
Unfiltered/unordered default requests continue to use version 1. Version 2 uses
the same magic numbers with version=2; legacy binaries reject it explicitly.
No query cache is written to OPFS, checkpoints or the event log. SCK1/SCK2 and
SOV1/SOV2 bytes and cryptographic signatures remain unchanged.

After the version-1 request's actor continuation, v2 appends:

- u32 predicate count and u32 force-scan flag;
- each predicate's UTF-16 field, u32 operator code (`eq=1, gt=2, gte=3, lt=4, lte=5`)
  and tagged scalar (`null=0, false=1, true=2, number=3/f64, string=4/UTF-16`);
- UTF-16 order field (empty for no explicit order), u32 descending flag;
- u32 indexed-position-present flag and, if set, tagged scalar (tag 5 means missing).
  The after-item ID disambiguates equal sort values. Positions are engine-owned.

After the seven existing page-header words, v2 adds u32 cold-build inspected entries
and u32 accounted index key bytes. Items follow as before. The normal continuation
trailer then appends the indexed-position flag/scalar. Total bytes remains at
header offset 16. Status 5 means index limit; status 4 retains oversized-page meaning.
Inputs, counts, types, key sizes, flags and trailing bytes are validated in C++.
Deploy matching Worker/WASM assets; there is no silent downgrade for field queries.

## Historical profile before incremental maintenance: 2026-10-12

Windows x64, Intel Core i7-10700 @ 2.90 GHz, Node 24.15.0, Emscripten 6.0.11,
C++20 `-O3 -flto`. One warm-up and five samples per size; medians in milliseconds.
These measure native LWW state plus binary query bridge and JS result decoding.
They exclude crypto, OPFS, Worker RPC, network, startup and checkpoint/restore time.
Encoding initial commands is recorded separately. These are not UI latency guarantees.

| Rows | Rare equality cold / warm | Same complete result by bounded scan | Descending numeric range cold / warm | Equality rebuild after edit |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.24 / 0.02 | 0.15 | 0.25 / 0.17 | 0.22 |
| 10,000 | 1.73 / 0.04 | 1.39 | 0.53 / 0.16 | 0.95 |
| 100,000 | 23.12 / 0.13 | 17.15 | 7.35 / 0.13 | 23.95 |

Equality returns 1/10/100 rare matches at the three sizes. The indexed result is
**the same complete result** as the scan, not a partial-page comparison. Largest
warm equality inspects 100 entries; scanning inspects 100,000 across 391 bounded
pages. Range returns the highest 100 numeric rows with exact ordering. Restore
clears caches between cold samples; output and post-edit equality are asserted.
Cold equality can be slower than scanning once; warm times must not hide that cost.
The edit timing in the raw report includes cache teardown and single-command
encoding/application; first-read rebuild is recorded separately.

[Historical raw samples, scopes and native hash](benchmarks/field-queries-before-incremental-node.json).
[Current incremental profile](INCREMENTAL_INDEXES.md) separately measures write
maintenance and warm reads after repeated edits.
[Compiled reducer/checkpoint parity](benchmarks/row-replay-parity-node.json) still
reports 412 byte-identical snapshot and checkpoint comparisons against the captured
pre-row-replay runtime. This parity does not claim old binaries support v2 queries.

```sh
npm run build
node --test --test-concurrency=2 tests/unit/*.test.mjs
npx playwright test
npm run test:dx
node scripts/benchmark-field-queries.mjs
```

The runner writes `artifacts/benchmark-field-queries-node.json`. Independent scalar
reference tests cover mixed types, directions/ties, strict ranges, Unicode, missing
fields, contradictory bounds, bounded empty pages, LRU reuse/eviction, edits/restores,
late conditional winners, denied writes, exact retries, row/key-size/byte caps and
failure atomicity. Real Worker/OPFS tests verify typed limit/invalidation errors,
filtered ordered recovery. Installed React tests verify native results and descriptor
stability/change cleanup. Incremental tests additionally cover late batches,
resurrection, reference rewiring and per-cache limit fallback. Future work includes composite
planning and disk-resident indexes under explicit durability/convergence contracts.
