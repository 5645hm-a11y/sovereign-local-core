# Affected-row replay and validated suffixes

Status: included in v0.3.0. Public v0.2.0 predates these APIs.
This optimization applies to the existing generic row policies and row-local
conditional state machines. It adds no application-specific API and changes
neither authorization nor the canonical result.

## Native integration

`native/core_policy.inc` retains immutable candidates in canonical
`(Lamport, ordinal UTF-16 ActorID, sequence)` order. A row index contains
non-owning pointers into that retained history. Every command still crosses the
Worker signature, certificate, revocation and decryption checks before native
role/policy validation. This C++ layer does not validate ECDSA itself.

1. Parse and statically authorize the complete incoming batch, including exact
   duplicates and conflicting event identities. Stage only new candidates.
2. Group new candidates by immutable item ID and merge each affected row's ordered
   pointer index. An unchanged row is never replayed or copied.
3. If all additions follow that row's last candidate, copy its current register
   state, including tombstones and hidden fields, and reduce only the new suffix.
4. Otherwise reconstruct that row from all retained candidates, including earlier
   losers. Replace obsolete decisions: a late ownership change or earlier
   exclusive-resource claim can change prior outcomes.
5. Allocate replacement state, row indexes and decision nodes before publication.
   Commit by transferring preallocated map nodes with non-allocating comparators.
   Malformed, unauthorized and equivocating batches leave published state intact.

All current predicates inspect only their command's row. Future cross-row
invariants must explicitly define dependency invalidation; they cannot reuse this
optimization merely by assuming that one item ID captures all dependencies.
Governance changes still rebuild from the complete eligible authoritative history.

The initial empty-history bulk path uses full canonical replay and constructs the
row index. `SOV2` views and **SCK2 version-2 checkpoints remain byte-compatible**.
Checkpoints retain the authoritative role/command transcript, not a trusted row
cache. Restore fully parses/replays it and rebuilds indexes before applying deltas.
No candidate pruning, stability claim or new checkpoint format is introduced.

## Cost contract

Suffix reduction visits only new commands. Its current row pointer-vector copy
still costs O(retained candidates on that row), and register-state copying costs
that row's state size. A late command replays that entire row. Global ordered
indexes have logarithmic insertion costs. Exact retries validate their own input
but perform zero reductions. Query snapshots/decisions and checkpoints still
serialize the full corresponding state/history; they are not paged by this change.

The 100,000-candidate, 128 MiB command and 512 MiB WASM limits remain. These are
bounds, not peak-memory guarantees or unlimited project/member support. Whole
checkpoint recovery, governance replay and hot-row histories remain priorities.

`BinaryProjection.replayWork` exposes optional native diagnostics:
`{ rows, commands, suffixRows, replayedRows }`. Commands counts reductions only,
excluding parsing, vector copies, output, crypto and I/O. Failed operations keep
the prior successful counters; duplicate-only success reports zeros. Policy-free
sessions or older binaries without the optional export return `null`. Additive
`core_session_business_work(handle, metric)` uses metrics 0/1/2/3 respectively,
without invalidating output leases. ABI 1 and `LocalCoreClient` are unchanged.

## Measurements: 2026-10-12

Windows x64, Intel Core i7-10700 @ 2.90 GHz, Node 24.15.0, Emscripten 6.0.11,
C++20 `-O3 -flto`. Each size runs in a fresh process, with one warm-up and three
measured iterations. Reported values are medians in milliseconds. Before and
after measure the same resource/actor history, independently of the old LWW path.
The baseline is the **local immutable-candidate/duplicate optimization before
this change**, not the public v0.2.0 binary. Its runner's hardcoded date is corrected
from the original report's file timestamp and annotated in the raw record.

Scope is **Node WASM plus the binary bridge**, with decrypted producer-encoded
commands and trusted roles. Producer encoding is recorded separately. These
numbers exclude signing, certificate checks, AES-GCM, OPFS flush, Worker RPC,
network, module startup and full application/query latency. Sub-millisecond values
are especially sensitive to hardware and timing noise.

| Initial candidates | Initial load before / after | Tail edit before / after | Earlier command before / after | Restore before / after |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2.66 / 2.77 | 0.91 / 0.02 | 0.98 / 0.02 | 2.53 / 2.65 |
| 10,000 | 34.72 / 35.90 | 18.88 / 0.03 | 15.82 / 0.03 | 34.18 / 35.11 |
| 50,000 | 200.09 / 200.06 | 95.17 / 0.05 | 88.10 / 0.13 | 192.49 / 197.70 |
| 99,998 | 436.14 / 424.00 | 204.06 / 0.06 | 182.16 / 0.27 | 423.57 / 414.82 |

The largest spread workload has 1,000 rows; the earlier command reduces **103**
candidates on one row rather than 100,000 globally. A tail edit reduces one.
Sampled reserved WASM capacity changes from 512.0 to 434.6 MiB at that size;
this is neither live heap nor an exact memory peak. Bulk load and restore remain
linear and show small mixed differences rather than a new recovery speed claim.

The skewed profile concentrates all candidates on **one row**:

| Initial candidates | Tail edit | Earlier command | Restore | Sampled WASM capacity, MiB |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.03 | 0.45 | 2.20 | 8.0 |
| 10,000 | 0.20 | 7.65 | 29.71 | 34.8 |
| 50,000 | 1.02 | 47.67 | 167.00 | 217.8 |
| 99,998 | 2.14 | 109.68 | 365.79 | 431.8 |

The hot-row tail still reduces one command but copies its large pointer index.
Its earlier command reduces all 100,000 candidates. This is the explicit worst
case for row partitioning, not a bounded constant-time operation. Every profile
checks conflicts, restored equality, exact retries and atomic rejection of
candidate 100,001 at the largest size.

Raw records: [before](benchmarks/row-replay-before-node.json),
[after/spread](benchmarks/row-replay-after-node.json),
[one hot row](benchmarks/row-replay-hot-node.json). They include samples, memory,
encoding/view/checkpoint costs, diagnostics, compiler metadata and binary hashes.

## Behavior evidence and reproduction

`tests/unit/row-replay.test.mjs` compares every shuffled prefix against a full
canonical restore oracle. It exercises late arrivals, ownership changes,
conditional winners/losers, exact returns, tombstones, Unicode, duplicates,
equivocation, malformed/denied batches and checkpoint-plus-delta splits.
The Dedicated Worker Chrome test proves the same suffix/late/restore work counts
and denial atomicity. It is not an OPFS performance benchmark; existing browser
suites cover durable crypto, OPFS and network integration.

A separate pre-change/current compiled-WASM comparison used ten seeded histories
and **412 snapshot plus 412 checkpoint byte comparisons**, cross-runtime restores
and denied batches. [Parity record](benchmarks/row-replay-parity-node.json) names
both binaries by SHA-256. The pre-change binary is a local development artifact,
not distributed as a second supported runtime. The unit restore oracle does not
require it.

```sh
npm test
npm run test:browser
npm run test:dx
# After building, run these sequentially; each overwrites the artifact report:
node scripts/benchmark-invariants.mjs --sizes=1000,10000,50000,99998 --samples=3
node scripts/benchmark-invariants.mjs --sizes=1000,10000,50000,99998 --rows=1 --samples=3
# Optional differential comparison, if you preserved a pre-change WASM build:
node scripts/compare-row-replay.mjs --baseline=/path/to/pre-change/core_engine.wasm
```

Benchmark output: `artifacts/benchmark-invariants-node.json`. Use smaller explicit
sizes on constrained machines. Independent end-to-end Chrome percentile and cold
recovery measurements, bounded query delivery and a hot-row indexing strategy
remain work; see the [roadmap](V0_3_ROADMAP.md).
