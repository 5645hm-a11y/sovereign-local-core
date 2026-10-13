# Bounded source-side log cursors (v0.3.0)

Available in v0.3.0; the public v0.2.0 artifact predates this extension. Standard `LocalCoreClient`/OPFS sync
now reads the committed event log in bounded pages instead of constructing a
whole-log missing-event array before the first batch. Both WebRTC adapters use
this through `SyncSession`; no new wire message or application setup is required.
This is incremental **export**, not partial replication. Standard stores now also
use [authenticated address indexes](SYNC_INDEX.md) to skip known frames; the
sequential compatibility path described below remains available.

## Contract and lifecycle

`ISyncCursorCore` exposes three methods through the Worker:

```ts
const cursor = await client.openSyncCursor(remoteContiguousSummary);
if (cursor) {
  try {
    let done = false;
    while (!done) {
      const page = await client.readSyncCursor(cursor.id);
      // Send page.events; wait for the peer's validated, durable ACK.
      // An empty page can still advance the disk scan. Never infer EOF from it.
      done = page.done;
    }
  } finally {
    await client.closeSyncCursor(cursor.id);
  }
}
```

The handle contains an ephemeral UUID and a committed `endOffset`. Opening
copies the bounded remote frontier and pins this byte fence, governance revision
and authenticated controls. Ordinary appends after the fence travel through live
sync; they cannot extend a cursor indefinitely. Local operations are serialized
with page reads, but can run between pages while the peer ACK is pending.

Pages scan at most **64 physical records** and target **128 KiB of raw log bytes**.
A single larger record is allowed to make progress, within the existing **1 MiB
payload plus 16-byte frame header** limit. The identity frame counts toward the
physical-record bound but is not an event. Cached governance pages also bound
their encoded payload to 128 KiB, with the same single-record exception; their
`scannedRecords`/`scannedBytes` are zero because they do not read the file.
These are input/page bounds, not an exact JavaScript heap bound.

Governance is exported first from the already authenticated policy/checkpoint
cache so an epoch key reaches the recipient before data encrypted under it.
This includes [paged key-epoch](PAGED_EPOCHS.md) preparations and manifests:
dependent data waits until their complete committed envelope/witness set verifies.
Sequential physical log pages validate every stored event, suppress already-sent
controls, and filter data by contiguous watermarks and current revocation rules.
The eligible event set matches the bulk API; its transfer order may differ.

`SyncSession` keeps one page/batch pending per direction and reads the next page
only after the previous nonempty batch's durable ACK. Empty filtered pages advance
without a network round trip. Connection loss closes the cursor; reconnection
creates a new cursor from the peer's durable receipt. No progress token is persisted.

- Completion closes the handle automatically; explicit close is idempotent.
- At most **32 cursors per core** may be open.
- Idle handles expire after **60 seconds**; active cryptographic reads exclude
  that timeout. Direct `LocalCore.open` callers may set `syncCursorIdleTimeoutMs`
  between 1 and 300,000 ms. A peer ACK wait exceeding the idle limit can require
  reconnection; this never advances the peer's durable watermark.
- A durable governance commit invalidates older cursors. The next read throws
  `SyncCursorInvalidatedError` without faulting the core; the adapter reconnects
  and re-evaluates current rights. Closing the core clears queued/in-flight handles.

## Integrity and compatibility

The frame reader checks length, CRC, binary decoding and the committed boundary.
The core snapshots each envelope before asynchronous verification, verifies its
signature/certificate/project/namespace binding, and checks exact unsigned content
against the authenticated durable event index. That index was constructed by
validated admission or owner-authenticated checkpoint recovery; CRC alone cannot
authorize ciphertext. Forged bytes, validly re-signed equivocation, or an event
absent from that index fault the core without truncating the evidence. Close and
reopen after resolving corruption. The recipient still performs full decryption,
authorization and native policy/invariant validation before append and ACK.

Previously stored events invalidated by a learned revocation stay in the audit log
but are not exported unless an authorized history witness admits them. A cursor
does not make whole-history transfer atomic: a validated prefix can reach the peer
before corruption later in the file is discovered.

Indexed pages validate only selected frames and suppress already-sent controls;
known frames are not re-audited on every catch-up. See [index trust and recovery
contracts](SYNC_INDEX.md) for authenticated address coverage and old checkpoints.

The old `readMissingEvents` and `readMissingEventsPaged` APIs remain unchanged
and still return bulk arrays. Custom `ISyncCore` implementations may omit the
three cursor methods; custom `ILocalStore` implementations may omit `endOffset`
and both `readEventPage`/`openMissingEventScan`, causing `openSyncCursor` to return `null`. `SyncSession`
then falls back to the existing bulk API. All three cursor methods are needed
to enable the new path. Legacy peer compatibility is unchanged because cursor
reads are local; see [paged frontiers](SYNC_FRONTIERS.md).

## Measurements

The original sequential-cursor measurements below remain historical evidence.
`npm run benchmark:sync` now compares all three paths and writes the
[indexed benchmark](SYNC_INDEX.md#measurements-and-remaining-costs). After building:

```sh
node scripts/benchmark-sync-cursor.mjs --count=2000 --samples=3 --output=docs/benchmarks/sync-cursor-indexed-node.json
```

[Raw results](benchmarks/sync-cursor-node.json): Node 24.15.0, Windows x64,
Intel i7-10700, 2,000 signed/encrypted events, 128-character fields plus revision,
4,769,716 log bytes, one warm-up and three measured samples per scenario.
The JSON timestamp is host-recorded. These use an **in-memory SyncFile** with
real cryptography and native-validated setup; they exclude actual OPFS latency,
RTC, receiving/flush, startup and peak RAM. Medians, in milliseconds:

| Scenario | Bulk first batch / total | Cursor first batch / total |
| --- | --- | --- |
| All 2,000 events missing | 1,891.83 / 1,893.05 | 49.75 / 1,839.01 |
| Only last 20 missing | 1,762.34 / 1,762.37 | 1,915.23 / 1,915.25 |

The full-transfer first batch is ready about **38 times earlier**, with 131,000
bytes read instead of the entire 4.77 MB file. Largest observed disk page: 55
events / 131,010 raw bytes. This does **not** imply a 38-fold throughput improvement:
full export total improves only about 3% in this fixture, and the tail-only case
is slower. Both paths still scan all records. Cursor total reads 4,770,292 bytes,
including 576 bytes of repeated next-header probes; total disk I/O is not reduced.

The implementation removes the additional whole-log event/missing arrays and
plaintext materialization from standard catch-up. Existing event indexes,
governance caches, frontier maps and native invariant histories remain resident
and scale with history/actors. Initial recovery and governance commits can still
load full history. [Persistent authenticated actor-offset indexes](SYNC_INDEX.md)
now provide cheap small deltas in standard stores; their first legacy-checkpoint
rebuild and sequential fallback still scan history. Sparse overlay connectedness
is separate work.

## Validation

`tests/unit/sync-cursor.test.mjs` covers short reads, page/oversize bounds, exact
bulk parity, write fences, governance invalidation and witnessed history, CRC and
signature tampering, equivocation, cursor capacity/expiry/shutdown, checkpoint
recovery, and real-core stream ACK backpressure with concurrent live writes.
`tests/browser/sync-cursor.spec.mjs` exercises Worker RPC, OPFS, real DataChannels,
watermark holes, reload/reconnection and live edits with bulk methods disabled.
These establish bounded page behavior; they are not a large-swarm memory benchmark.
