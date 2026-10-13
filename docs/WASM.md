# Binary-first native core

The public `LocalCoreClient` API and `ICRDTMerge` are unchanged. Item production,
encrypted event storage and WebRTC application messages are binary. The Worker
keeps a persistent C++20/WASM projection and normally applies only new item events.

Version 0.2.0 adds opt-in root-signed row policies and conditional CHECKOUT/RETURN.
The default LWW path described below keeps its existing formats and incremental
behavior. Policy projects use additive exports and versioned command/view/checkpoint
extensions; they retain candidates and replay their deterministic order, including
on checkpoint restore. The old performance measurements do not describe that path.
See [native policies, ABI extensions and costs](POLICIES.md).

## Modules

| Module | Responsibility |
| --- | --- |
| `binary-codec.ts` | Canonical bounded binary values and UTF-16 strings |
| `binary-events.ts` | Raw ciphertext/signature/IV bytes on disk/wire; public object adapters |
| `binary-command.ts` | Producer-side ABI-1 plaintext commands and signed-metadata binding |
| `project-crypto.ts` | AES-GCM binary command encryption/decryption; legacy v3 reader |
| `project.ts` | Incremental item authorization, full governance evaluation, owner cache-key derivation |
| `native/core_engine.cpp` | Stateless ABI-1 reducer and validation primitives |
| `native/core_session.inc` | Persistent registers, staged updates, binary checkpoints and restore |
| `native/core_policy.inc` / `policies.ts` | Authenticated-role policies, conditional replay and candidate checkpoints |
| `wasm-loader.ts` | Async loading, reusable linear-memory arenas, native sessions |
| `checkpoints.ts` | Owner-encrypted/signed, alternating OPFS checkpoint slots |
| `engine.ts` | Serialized durable publication, delta replay, checkpoint scheduling |

## Build and execution

Activate an [official SDK](https://emscripten.org/docs/getting_started/downloads.html)
or set `EMSDK` / `EMXX`. Emscripten 6.0.11 is the tested toolchain; the build can
also detect a local SDK under `.tools/emsdk-main`. The compiler is only a development
dependency and is not committed or shipped to package consumers.

```sh
npm run build
# Alternative with an activated SDK:
bash scripts/build-wasm.sh
npm run build:ts
npm test
npm run test:browser
npm run benchmark:browser
npm run benchmark
```

Build flags: C++20, `-O3 -flto -fwasm-exceptions`, no filesystem or Embind.
Ship `dist/wasm/core_engine.mjs` and `core_engine.wasm`. The server supplies module
and `application/wasm` MIME types. Worker startup asynchronously initializes one
runtime; `open` waits for readiness. Missing/mismatched modules fail explicitly.

## Producer and security boundary

```text
dispatch(normalized command)
  -> encode once as SCW1 binary
  -> AES-GCM encrypt binary command
  -> sign canonical binary metadata + IV + ciphertext
  -> SLC2 framed binary event / binary DataChannel envelope

authenticated incoming ciphertext
  -> verify signature, pinned certificate chain and revocation eligibility
  -> AES-GCM decrypt to SCW1 bytes; bind redundant native metadata to signed envelope
  -> one byte copy into WASM arena
  -> native validate/apply only the delta; decode immutable query Snapshot
  -> append binary ciphertext frame and flush
  -> publish state and notify P2P
```

Public events retain their object shape and base64url properties. Wire/storage
adapters encode cryptographic properties as raw bytes. Metadata remains visible.
Transport makes no permission/storage/merge decisions. Invalid batches are checked
in full, including native scalar/record validation, before their first append.
Storage failures can retain a durable prefix; only flushed events are acknowledged.

Native sessions stage changes to touched items and publish them only after successful
parsing/allocation. Input references never survive the call: only final winning
strings become owned C++ values. Actors are cached across records within a batch,
and small dictionaries use stack storage. Registers compare
`(Lamport, ordinal ActorID, sequence)`; updates do not resurrect tombstones.
Command number normalization preserves the existing `-0 -> +0` behavior.

Ordinary writes use `ProjectContext.extend` and persistent native registers.
Governance changes re-evaluate authoritative history and rebuild the projection:
revocation can invalidate previously visible values, so blindly applying an Admin
command to a cached LWW view would be incorrect. Full history is loaded lazily after
checkpoint recovery when governance or explicit audit/catch-up APIs require it.

## Actual copy and lifetime costs

This is **binary-first, not unconditional zero-copy**. Native Web Crypto
[`decrypt` returns a new ArrayBuffer](https://www.w3.org/TR/webcrypto/#SubtleCrypto-method-decrypt);
it does not accept a destination pointer into WASM memory. A JS ArrayBuffer cannot
be retroactively adopted as WASM linear memory. The production bridge copies each
decrypted block once using `HEAPU8.set`. Batches write headers and existing blocks
directly into the reusable WASM arena, without an intermediate packed buffer or
field re-encoding. Snapshot object decoding and clearing still cost CPU.

No SharedArrayBuffer/threads/cross-origin isolation is required for this same-Worker
pipeline. Adding shared memory would not remove Web Crypto's result allocation.
WASM starts at 8 MiB and grows to at most 512 MiB; ABI inputs are bounded at 128 MiB
and one million records per call. Large replays split into bounded native calls.
Native state remains owned until close/reset; scratch bytes are cleared and arenas
freed on close. This does not guarantee zeroization of all JS/allocator data.

[Memory growth invalidates old non-shared views](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow).
The bridge refreshes views after allocation/native calls. Shared native output is
synchronous and decoded/copied before another call. Legacy prepared-output leases
also reject superseded generations. Immutable public Snapshots outlive arena reuse.

## Checkpoints and recovery

Default interval: **1,000 acknowledged events**. Custom Worker integrations can pass
`{ checkpointInterval }` as the fourth argument to `LocalCore.open`; existing
three-argument callers and `LocalCoreClient` calls remain unchanged.

Files: `checkpoint-0.slc` and `checkpoint-1.slc` beside `events.slc`.
A checkpoint contains:

- Native existence/field register stamps, values, actor IDs, tombstones and hidden fields.
- Durable byte offset, event count, Lamport and local sequence.
- Signed-content SHA-256 fingerprints for deduplication and watermark holes.
- Administrative history and certificates for policy/key-epoch reconstruction.
- A digest binding the exact durable event-log prefix.

The native checkpoint is encrypted with an **owner-only AES key**, derived using
self-ECDH and HKDF with a domain-separated project/root/genesis/owner context.
It is not encrypted with an old shared project key: a revoked holder of that key
must not decrypt newer data through a stolen checkpoint. ECDSA by the local owner
signs the encrypted envelope; the same context is AES-GCM AAD. Another member's
knowledge of a project key grants no cache-forging authority.

The journal writes/truncates the older slot and flushes it, then advances its
generation. The previous slot survives a torn write. Invalid/torn encrypted envelopes
fall back to the other slot or full verified replay. A signed but structurally invalid
native checkpoint stops open safely. Optional cache write failure never changes an
already flushed event into an uncertain commit; the next write retries. Direct-core
integrations can inspect `checkpointStatus`.

On open, the store authenticates the checkpoint, verifies its raw-prefix digest,
validates the tail before repair, and reads only tail event records. The engine
independently verifies the sealed proof, restoring native registers/counters/index
and replaying the tail. An arbitrary storage adapter cannot supply an unsigned
checkpoint. A governance event in the tail triggers full authorization/reprojection.
`recovery.checkpointEvents` and `replayedEvents` expose the selected boundary/delta.

**Opening still hashes raw prefix bytes in 1 MiB chunks** to detect old-log tampering,
and restores the full deduplication index. It avoids old event parsing, signature
checks, decryption and CRDT replay, but is not O(delta) disk I/O or constant-memory
startup. Complete valid rollback/withheld history remains outside this local cache's
guarantees. Checkpoints are local owner caches; they are not trusted network snapshots.
Compaction/streaming indexes remain separate work.

## Binary formats and C ABI

All integers/floats are little-endian. Strings are `u32 codeUnitCount + UTF-16LE`;
BOM, non-BMP characters and lone surrogates are preserved.

### SCW1 plaintext commands: ABI 1 retained

| Offset | u32 value |
| ---: | --- |
| 0 | Magic `0x31574353` |
| 4 | ABI 1 |
| 8 | Event count |
| 12 | Total bytes |
| 16 / 20 / 24 | Actor / item / field-key dictionary counts |
| 28 | Dictionary byte offset |

Events start at byte 32:
`u64 lamport, u64 sequence, u32 actorIndex, u32 itemIndex, u32 type, u32 fieldCount`.
Types 1/2/3 = add/update/delete. Fields: `u32 keyIndex, u32 tag, payload`.
Tags 0 null, 1 false, 2 true have no payload; 3 f64; 4 string.
Dictionaries follow records: actors, item IDs, field keys.
An encrypted item event contains exactly one command, bound to its signed metadata.

### Container, view and native checkpoint

Each begins `u32 magic, u32 version=1, u32 count, u32 totalBytes`.

- `SCB1` (`0x31424353`): existing independent SCW1 blocks, each prefixed by u32 length.
- `SOV1` (`0x31564f53`): visible query items; ID string, field count, key/tag/value entries.
- `SCK1` (`0x314b4353`): all items, including deleted/unborn ones. Each carries ID,
  presence, existence stamp and all field registers. Stamps are
  `u64 lamport, u64 sequence, actor string`; all-zero/empty means absent existence.
  Each field is key string, stamp, tag/value. This is a replay checkpoint, not a query view.
- The old stateless `core_merge` still emits indexed `SCO1` for differential/bulk benchmarks.

Policy sessions in v0.3.0 use [affected-row/suffix replay](ROW_REPLAY.md).
The optional read-only export `core_session_business_work(handle, metric)` reports
rows/commands/suffixRows/replayedRows for metrics 0/1/2/3; it does not invalidate
output leases. `BinaryProjection.replayWork` returns `null` when unsupported.
It is a reduction-work diagnostic, not an end-to-end timing or bytes counter.

The additional optional `core_session_query(handle, pointer, byteLength)` emits
bounded native item/decision keyset pages, with explicit oversized-record failure.
It does not change full Snapshot/checkpoint bytes. See [SQR1/SQP1 layout and limits](QUERY_PAGES.md).

New C exports supplement ABI 1:
`core_session_create/destroy/apply/snapshot/checkpoint/restore/reset`.
Apply/restore take `handle, pointer, byteLength`; query/checkpoint take a handle.
Status is 0 success, 1 invalid input/handle, 2 allocation failure; exceptions stay
inside C++. Shared output uses the existing `core_output_ptr/size/clear_output`.

`SVB1` (`0x31425653`) is the canonical envelope codec: u32 tags for null/booleans,
f64, string, array, ordinal-key-sorted object and byte blob. Depth, lengths, counts,
duplicates and trailing bytes are bounded/validated. `encodeWire` turns signatures,
IVs, ciphertext, salts, public points and digests into blobs.

`SLC2` (`0x32434c53`) keeps the 16-byte append-only CRC header but carries SVB1
records instead of JSON. New DataChannel logical messages use v2 SVB1; existing
ordered fragmentation/backpressure/ACK semantics remain. Signaling, vaults and
bootstrap metadata retain their existing JSON interfaces.

## Compatibility, tests and measurements

Public methods/events/Snapshots keep their previous shapes. Signed encrypted JSON v3
logs, root certificates, descriptors, invitations, key envelopes and witness digests
have a read-only compatibility path. Old plaintext fields are converted to SCW1 only
when reading legacy ciphertext; new appends are binary and preserve existing bytes.
Unsigned v1/v2 logs still require explicit migration. Both P2P peers must run the v2
binary transport; old v1 wire clients are not protocol-compatible.

43 unit tests pass, including all original 26 and native regressions. Twelve new
binary/checkpoint/legacy cases cover JSON-free event execution, raw codec bounds,
tombstones/hidden registers, malformed signed batches, prefix corruption, slot/flush
failures, proof authentication, revocation after checkpoints and signed JSON v3
compatibility. All 23 browser tests pass; the added case verifies the real 1,000-event
OPFS checkpoint and one-event delta after abrupt Worker termination.

See [measured benchmarks](WASM_BENCHMARKS.md). They distinguish contiguous producer
buffers, actual individual-record replay, checkpoint/delta materialization and real
OPFS open/dispatch. Producer work is measured separately, not assumed free.

