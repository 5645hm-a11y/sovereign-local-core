# Business invariant replay: baseline and v0.3.0 optimization

Historical measurement below: 2026-10-09 immutable-candidate/duplicate change.
The newer 2026-10-12 [affected-row replay report](ROW_REPLAY.md) compares that
pre-row-replay reducer with the v0.3.0 row suffix/late replay path, including a one-hot-row
profile. The full-history ingestion description below applies to this historical
measurement, not the final v0.3.0 runtime.

Recorded 2026-10-09 on Windows x64, Intel Core i7-10700 @ 2.90 GHz, Node
24.15.0, Emscripten 6.0.11, C++20 `-O3 -flto`. One unmeasured warm-up and three
measured iterations per size, with a fresh process for each size.

## Scope

This measures `BinaryProjection` in Node: the binary bridge plus C++ reducer,
with already decrypted commands and trusted roles. It **excludes** event
signing, certificate/revocation validation, AES-GCM, OPFS, Worker RPC, WebRTC
and WASM module startup. Producer encoding is recorded separately. These are
not application startup times or end-to-end durable-write latencies.

The workload creates up to 1,000 copies, then CHECKOUT/RETURN history spread
across them. It applies a tail edit, repeats exactly that edit, inserts an
earlier conflicting checkout, decodes the view and checkpoints/restores. Every
iteration asserts one late winner, rejected conflicts and exact restored view
equality. The largest case starts at 99,998 candidates, adds two unique events
to reach 100,000, and verifies that candidate 100,001 fails without changing
state while exact retries remain valid.

## Results

Times below are medians in milliseconds. Baseline is the v0.2.0 reducer;
"updated" is the local, v0.3.0 immutable-candidate/duplicate change.

| Initial candidates | Initial apply baseline / updated | One tail edit baseline / updated | Exact duplicate baseline / updated | Earlier checkout baseline / updated | Restore baseline / updated |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2.93 / 2.69 | 1.62 / 1.09 | 1.12 / 0.01 | 1.16 / 1.03 | 2.59 / 2.58 |
| 10,000 | 34.47 / 34.97 | 22.03 / 19.16 | 18.32 / 0.03 | 17.54 / 18.03 | 34.87 / 35.81 |
| 50,000 | 193.04 / 198.90 | 106.19 / 92.23 | 84.93 / 0.03 | 87.60 / 85.32 | 193.24 / 192.61 |
| 99,998 | Failed run / 434.76 | Failed run / 203.32 | Failed run / 0.05 | Failed run / 202.19 | Failed run / 430.43 |

The baseline largest run raised `NativeMergeError`, status 2 (allocation
failure), on `oneTailApplyMs` in the first measured iteration after warm-up.
It is not reported as a successful baseline or as zero time. Three measured
iterations plus warm-up completed at that size after the change.

| Initial candidates | Observed WASM linear capacity baseline / updated, MiB |
| ---: | ---: |
| 1,000 | 8.0 / 8.0 |
| 10,000 | 60.3 / 50.2 |
| 50,000 | 316.5 / 263.8 |
| 99,998 | Failed run / 512.0 |

Linear capacity is reserved WASM memory at sampled points, not live native heap
or an exact peak. Process RSS also includes JS commands, decoded decisions and
runtime overhead; see raw data. WASM memory grows and does not shrink between
iterations. The largest updated case still reaches the configured **512 MiB
WASM maximum**. Passing this particular workload does not guarantee that larger
fields, more actors, different allocation order or mobile devices fit. The
100,000-candidate and 128 MiB raw-command limits remain unchanged.

## What changed and what did not

Previously every ingestion deep-copied the retained candidate payloads before
replaying, even if all incoming events were already present. The updated
reducer validates incoming commands and proofs against existing/intra-batch
identities first. Exact duplicates return without cloning/replaying. Conflicting
bytes, clocks or roles still fail atomically. New candidates remain immutable
and share their allocations across staged history copies. Decisions are rebuilt
rather than copied. Empty-history bulk loads transfer staged indexes directly.

New events still copy history indexes and replay the complete ordered set.
Restore still parses and replays all conditional history. Initial apply and
restore do not consistently improve here; this is principally a duplicate-path
and staging-memory improvement, not a new constant-time reducer. Sub-millisecond
duplicate numbers are sensitive to timer/noise and should not be extrapolated
to signed network ingestion.

The test addition checks exact duplicate checkpoint equality, changed payload,
clock and role rejection, intra-batch equivocation, mixed new/duplicate atomicity
and a successful write after a rejected batch. Existing late-winner, owner,
revocation and checkpoint tests remain authoritative behavior checks.

## Reproduce and inspect

```sh
npm run benchmark:invariants
# After building, select sizes/repetitions without rebuilding:
node scripts/benchmark-invariants.mjs --sizes=1000,10000,50000,99998 --samples=3
```

The script writes `artifacts/benchmark-invariants-node.json` and exits nonzero
if any case fails. It isolates sizes in child processes and records the failing
phase/iteration rather than silently omitting errors. Large cases can use
substantial host RAM; select a smaller explicit size for constrained machines.

Committed measurement records:

- [Baseline at 1k/10k/50k](benchmarks/invariants-v0.2.0-baseline.json).
- [Baseline failure near 100k](benchmarks/invariants-v0.2.0-failure.json).
- [Updated reducer at all four sizes](benchmarks/invariants-updated-node.json).

The old [LWW/OPFS benchmarks](WASM_BENCHMARKS.md) describe a different path.
Affected-row replay with oracle parity is now included in v0.3.0;
measured Chrome/OPFS recovery and bounded decision-query delivery remain work; see the [core roadmap](V0_3_ROADMAP.md).
