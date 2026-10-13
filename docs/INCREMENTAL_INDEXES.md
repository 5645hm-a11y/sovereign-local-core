# Incremental native field indexes

Status: included in v0.3.0. Public v0.2.0 predates these APIs.
This extends [field queries](FIELD_QUERIES.md) without changing TypeScript APIs,
query ABI versions, signatures, event logs, snapshots or checkpoint formats.

## What changes

The first query still builds a local `(ID prefix, field)` reference index. A
small successful write now maintains it instead of making the next read rebuild
the whole prefix. Both policy-free LWW and authorized row-local invariant replay
use the same maintenance boundary. No network message or durable record contains
this derived cache. Restore/reprojection reconstructs it lazily from verified rows.

- At most 256 affected row IDs per cached prefix are eligible for maintenance.
  A 256-row delta is maintained; 257 affected rows drop only that prefix's cache.
  A batch may touch additional rows outside the prefix without dropping it.
- Unchanged scalar sort keys replace row/value/ID pointers at the existing slot.
  All field references must be rewired even if only another field or a losing
  LWW event was supplied, because staged publication replaces the owned row node.
- Changed keys remove the old slot and add the new reference in deterministic
  `(scalar value, ID)` order. Creates, tombstones, hidden/unborn entries and
  resurrection update the same metadata and reference vector.
- Late policy events patch the final row after canonical row replay, rather than
  inserting a provisional command's values. Static policy rejection and exact
  policy duplicate-only retries leave the cache unchanged.
- Prefix-entry count includes hidden state entries, as initial builds do. Logical
  key bytes are subtracted/added using the same accounting as the build path.
  The 100,000-entry, 16 MiB accounted-key and 1,024-UTF-16-unit limits remain.

An over-limit final key/budget drops the affected cache while accepting a valid
write. A later indexed query rebuilds or returns `QueryIndexLimitError`; callers
can narrow the prefix or explicitly scan. It does not silently omit a row or turn
an index resource limit into a policy rejection. Other cached prefixes/fields
remain available when they still satisfy their limits.

## Atomic publication and memory

Parsing, cryptographic authorization in TS, native role/policy validation,
reduction and final string ownership precede maintenance. The native boundary
then stages per-cache removal offsets, replacement pointers, additions and
updated limits. Vector capacity is reserved for the final size before publication.
If allocation/parsing/validation fails, no cache entries, rows, history or decisions
are published. A successful earlier reservation may leave larger unused capacity.

After all patches are ready, reference rewiring, block compaction and insertion
perform no allocation. Old rows are still alive; replacement rows live in staged
map nodes. Subsequent map-node transfers preserve replacement addresses, after
which old nodes can be destroyed safely. The Worker runs this publication
synchronously: no read observes the transient cache/row boundary.

Binary search finds insertion positions; overlapping blocks of pointer records
are moved together. For k changed keys, comparisons are O(k log n), but a vector
can still move O(n) references. This is not a B-tree or logarithmic write-time
claim. Unchanged keys only require binary seek and rewiring. Reallocation may
also move the full reference vector when capacity grows. No unchanged field value,
ID string, whole row or authoritative history is copied into the index.

Patch vectors and spare capacity are transient heap costs outside accounted-key
bytes. Two caches are still the maximum. Large deltas, full restore/reset,
initial policy replay and governance reprojection clear relevant caches. The
512 MiB WASM memory bound and existing invariant-history limits are unchanged.

Durable writes still advance revisions and invalidate open query cursors.
Applications restart those cursors; the new read can reuse maintained indexes.
This optimization does not introduce MVCC, alter authorization or pin a historical
view. React refresh semantics are unchanged.

## Measured profile: 2026-10-12

Windows x64, Intel Core i7-10700, Node 24.15.0, Emscripten 6.0.11, C++20 `-O3 -flto`.
One warm-up and five recorded iterations per size; medians in milliseconds.
Each iteration checks a complete rare equality result and a highest-100 numeric
range, warms both caches, edits one status key, then alternates 20 further status
edits with exact-result queries. No field-index rebuild occurs after these edits.
Repeated columns are medians of each iteration's 20 samples, then the median of
those five iteration medians. Assertions/reference preparation are outside timers.

| Rows | Initial equality build/read | One edit + two-index maintenance | Read after edit | Repeated edit / read | Same full result by scan |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.26 | 0.06 | 0.03 | 0.03 / 0.02 | 0.15 |
| 10,000 | 2.04 | 0.04 | 0.03 | 0.02 / 0.02 | 1.27 |
| 100,000 | 24.95 | 0.13 | 0.15 | 0.06 / 0.12 | 15.84 |

At 100,000 rows, the edit-plus-next-read medians total about 0.27 ms. The
[previous recorded profile](benchmarks/field-queries-before-incremental-node.json)
paid 23.95 ms for the first post-edit equality read, plus 0.038 ms for the write.
These are separately recorded profiles, not paired samples or a latency SLO.
The initial build remains about 25 ms and can exceed a one-off scan.

This measures Node native LWW reduction, producer encoding for edits, binary
query transport into WASM and decoded JS results. It excludes cryptography,
OPFS flush/read, Worker RPC, WebRTC, startup and checkpoint/restore time. Large
or hot-row policy histories and adversarial write distributions are not covered
by these timings; measure them separately before selecting operational limits.

[Current raw samples/compiler/hash](benchmarks/field-queries-node.json).

```sh
npm run benchmark:fields
node --test tests/unit/field-query.test.mjs
npx playwright test tests/browser/query.spec.mjs
```

The benchmark writes `artifacts/benchmark-field-queries-node.json`. Tests compare
complete paged results against an independent scalar reference after seeded
mixed-type, shuffled/late, multi-row writes; they cover same-key pointer rewiring,
deletes/resurrection, policy conflicts, rejected/malformed batch atomicity, cache
LRU/restore and the exact 256/257-row fallback boundary. Limit tests cover growth
of accounted keys, hidden entries at the row cap, oversized values and unaffected
cache survival. Real Worker/OPFS tests assert that a new cursor remains warm after
a durable write while the old cursor is invalidated, then compare recovered data.

Future work: incremental tree/block indexes if moved-reference costs dominate,
composite planning, durable index accelerators, and workload-specific end-to-end
p50/p95/p99 read/write/recovery profiles. None is implied by this cache change.
