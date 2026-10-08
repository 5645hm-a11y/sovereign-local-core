# Binary-first projection and checkpoint measurements

Measured 2026-10-07 on Windows x64, Intel Core i7-10700 @ 2.90 GHz.
Chrome 154.0.8037.98; Node v24.15.0; Emscripten 6.0.11, C++20,
`-O3 -flto -fwasm-exceptions`, command ABI 1. Generated module: 92,472-byte
WASM plus 9,124-byte ESM loader, uncompressed.

**Checkpoints improve actual browser recovery, and producer encoding removes field
packing from replay. Full replay of individual binary records is still slower than
the old bulk projection bridge.** These are separate results: a prepared contiguous
buffer is not the production encrypted-record replay path. No result establishes
unconditional zero-copy, total-memory reduction or a universal database speedup.

## Actual LocalCoreClient / Worker / OPFS

The browser benchmark creates 1,006 signed/encrypted events updating one visible
item, with the default checkpoint at event 1,000. The six-event delta restores the
same Snapshot and watermarks as full verified replay. Three independent client
opens per path; five live writes. Times are medians in milliseconds.

| Operation | Median | Observed range |
| --- | ---: | ---: |
| Open with checkpoint + six-event delta | 389.60 | 385.30–562.10 |
| Open same binary log without optional checkpoints | 4,765.50 | 4,075.00–5,281.30 |
| Live dispatch after 1,001 existing events | 2.70 | 2.50–3.20 |

Checkpoint recovery was approximately **12.2× faster in this fixture**. Both opens
include Worker/WASM initialization, 600,000-iteration PBKDF2 vault unlock, project
metadata/cryptography, OPFS, deduplication, native state and RPC. Checkpoint open also
hashes the raw log prefix. The uncached comparison uses the **new binary engine**,
not the previous implementation. The five live writes include encryption, signing,
OPFS flush and RPC, but do not cross another checkpoint boundary. Creating the
first 1,001 events, including the checkpoint, took 3,106.90 ms in this single run.
This small, one-item fixture is not an extrapolation to a 300,000-event database.

## Dedicated Worker projection: before and after packing

Seven samples after two warmups, rotating measurement order. Input is already
authorized/decrypted. Producer work, cryptography, OPFS, startup and RPC are outside
these timings. All values are medians in milliseconds.

| Events | TS projection | Old native kernel | Old full bridge | Prepared binary full bridge | Individual binary-record replay | Checkpoint + 1,000 deltas |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 7.00 | 2.40 | 8.70 | 6.60 | 14.30 | 11.40 |
| 100,000 | 28.20 | 6.10 | 35.90 | 11.40 | 70.10 | 11.30 |
| 300,000 | 71.30 | 13.20 | 94.60 | 19.40 | 183.30 | 8.90 |

| Events | Old packing + clearing | Prepared binary transfer + clearing | Old Snapshot decode |
| ---: | ---: | ---: | ---: |
| 10,000 | 2.80 | 0.80 | 3.30 |
| 100,000 | 27.40 | 2.60 | 3.00 |
| 300,000 | 76.80 | 4.40 | 2.20 |

For a pre-encoded contiguous 300,000-event buffer, transfer/clearing was 4.40 ms
instead of 76.80 ms packing/clearing, approximately 17.5× lower; the full bulk
projection was 19.40 ms instead of 94.60 ms. The preceding migration measured
77.40 / 92.70 ms for packing / full bridge; its raw results remain archived below.
Use the current same-run comparison for ratios, rather than mixing runs.

The **production format stores one independent SCW1 command per encrypted event**.
Replaying those records into the persistent native session took 183.30 ms for
300,000 events, worse than the old 94.60 ms bulk bridge and the 71.30 ms TS reference.
Repeated dictionaries, per-record validation, native owned registers and staged
allocation remain costly. The 19.40 ms contiguous result is an isolation experiment,
not the Engine's full-history performance. Future shared dictionaries or block
storage need their own implementation and security/recovery tests.

The checkpoint measurement restores native register state from the prefix at
`N - 1,000`, applies the actual last 1,000 independent command blocks and decodes
the public Snapshot. It includes checkpoint transfer/native restore, delta transfer,
native validation/merge, Snapshot decoding and scratch clearing. It excludes cache
AES/signature checks, deduplication-index restore and all I/O, unlike the OPFS table.
The 300,000-event checkpoint/delta samples ranged from 8.60 to 14.50 ms; individual
record replay ranged from 176.40 to 206.50 ms. Separately timed medians do not sum
exactly to a full-path median.

## Node: same module and workload

Seven samples after two warmups; medians in milliseconds.

| Events | TS projection | Old native kernel | Old full bridge | Prepared binary full bridge | Individual binary-record replay | Checkpoint + 1,000 deltas |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 18.53 | 2.56 | 12.59 | 7.18 | 21.22 | 14.26 |
| 100,000 | 51.42 | 5.99 | 41.14 | 10.98 | 78.27 | 12.70 |
| 300,000 | 113.44 | 13.75 | 113.60 | 20.53 | 212.94 | 10.87 |

Old packing/clearing: 4.18 / 33.88 / 95.44 ms. Prepared binary transfer/clearing:
1.07 / 2.25 / 5.05 ms for 10k / 100k / 300k respectively.

Authenticated replay of 1,000 signed/encrypted events additionally runs signature,
certificate and AES-GCM checks: **664.76 ms** with reference field decoding/TS
projection, **650.95 ms** with binary command decryption/native projection. Three
samples after one warmup, alternating order. This small noisy sample does not
establish a reliable 2% relative speedup. It excludes OPFS, normalization/dedup,
startup and RPC. Raw samples identify the exact measured scope.

## Producer work, workload and memory

The deterministic projection workload has 16 actors, up to 5,000 item IDs,
add/update/delete and four fields per non-delete: number, Hebrew/non-BMP string,
boolean, null. Final visible items: 4,949 / 4,160 / 3,245. Snapshot parity against
the TS reference is checked outside timings, including full independent-record
replay and checkpoint/delta recovery. Actors here are short synthetic strings;
real public-key ActorIDs and certificates add storage/cryptographic cost.

Encoding is moved to production, **not made free**. The benchmark records one
preparation observation that generates both the contiguous comparison buffer and
all individual producer blocks; this is not a repeated median or a measurement of
only production dispatch. Browser preparation: 86.60 / 723.70 / 2,039.30 ms;
Node: 112.77 / 962.94 / 3,035.03 ms for 10k / 100k / 300k. Engine dispatch encodes
one command at a time and encrypts that exact buffer; recovery does not repack fields.

| Events | Contiguous command bytes | Individual command bytes | Native checkpoint bytes | WASM high-water MiB |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1,102,506 | 2,234,750 | 1,535,416 | 16.7 |
| 100,000 | 10,020,756 | 22,293,012 | 1,535,392 | 62.9 |
| 300,000 | 29,838,960 | 66,866,700 | 1,535,430 | 160.3 |

Command sizes are plaintext ABI bytes, not encrypted log sizes. Native checkpoint
sizes exclude the encrypted envelope, full identity index and policy metadata.
Linear-memory high-water includes two legacy input arenas and a persistent session
arena/state in one runtime. It excludes JS event objects, index, Web Crypto,
Snapshots and other Workers; it is not live allocation or total application memory.
Startup observed 12.10 ms in the browser benchmark Worker and 4.00 ms in Node,
each a single loading/cache observation, not the LocalCoreClient open metric.

Web Crypto decryption allocates its result. The bridge makes one byte copy into
WASM and clears scratch; it does not reserialize decrypted fields or use JSON.
Checkpoint startup still reads/hashes raw prefix bytes and restores the full
deduplication index. Governance changes rebuild from authorized full history;
explicit audit/catch-up APIs still scan it. See [the architecture and memory
contract](WASM.md) for copy, policy and recovery boundaries.

## Validation and reproduction

**43 unit tests passed**, including all original 26, five native regressions and
twelve binary/checkpoint/legacy cases. **All 23 browser tests passed** with actual
OPFS/WebRTC. The new browser test terminates the Worker after the default
1,000-event checkpoint plus one delta and checks exact state/counters on reopen.
Tests also cover encrypted bytes, malformed signed native commands, whole-batch
rejection, hidden/tombstoned register recovery, sparse watermarks, corrupt prefixes,
torn slots, optional cache flush failure, unsigned cache injection, owner-only cache
privacy, revocation/key rotation after recovery and genuine legacy signed JSON v3.

```sh
npm test
npm run test:browser
npm run benchmark:browser
npm run benchmark
```

Run benchmarks sequentially without concurrent tests/builds or heavy workloads.
Commands regenerate raw samples in `artifacts/`. Archived current reports:
[browser binary/checkpoint JSON](benchmarks/2026-10-07-binary-browser.json),
[Node binary/checkpoint JSON](benchmarks/2026-10-07-binary-node.json).
The preceding WASM migration is preserved in
[original browser JSON](benchmarks/2026-10-07-browser.json) and
[original Node JSON](benchmarks/2026-10-07-node.json).
