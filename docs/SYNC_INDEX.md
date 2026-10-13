# Authenticated log addresses for small deltas (v0.3.0)

Standard OPFS clients now use an actor/sequence address index behind the existing
[sync cursor API](SYNC_CURSORS.md). A peer missing only a suffix reads only those
event frames; it no longer re-reads and re-verifies the known prefix on every
catch-up. Available in v0.3.0; the public v0.2.0 artifact predates this extension. This does not change event
signatures, native ABI, external commands, wire protocol or frontier semantics.

## Data and trust boundary

`LogOffsetIndex` holds one address `{ id, offset, length }` per unique durable
event. Events are grouped by actor and sorted by sequence. Binary search skips
entries at or below that actor's **contiguous** peer watermark. Unknown actors
start at zero, so holes still cause the appropriate sparse suffix to be sent.
Each page selects at most 64 frames / 128 KiB, allowing one oversized frame
within the existing 1 MiB payload plus header limit. No full missing-event array
is constructed. Selection order is actor/sequence, rather than physical append
order; native convergence does not depend on arrival order. Authenticated
governance still precedes data in the cursor protocol.

The index is an address hint, never an admission proof. Each selected frame is
read from the actual file, checked for length/CRC/encoding and exact expected
event identity, then verified in the core for signature, certificate, project,
namespace and exact content against the authenticated durable `EventIndex`.
Current revocation/history-witness rules still filter exports, and the receiving
core still performs full decryption and native authorization before durable ACK.
An index cannot substitute another correctly signed event at a different address.

Known frames skipped by the index are **not audited on that catch-up**. A later
selected read, full `client.readEvents()` validation or recovery may reveal
corruption. Existing owner-checkpoint prefix verification still reads/hashes the
prefix during startup. This optimization cannot establish fresh whole-log
integrity while intentionally not reading its known bytes, and does not prevent
whole-history rollback.

## Durability and recovery

New addresses are installed only after the event frame has successfully flushed.
An uncertain append faults the writer; recovery reconstructs addresses only for
complete, authenticated records. Exact duplicate events retain their original
address. The append-only file remains the authoritative history.

Checkpoints now optionally contain a compact binary `logLocations` buffer,
inside the existing encrypted and owner-signed checkpoint envelope, bound to its
project, owner, committed byte offset and raw prefix hash. There is no unsigned
sidecar index. Restoration checks:

- Every authenticated checkpoint event ID has exactly one address; no omitted,
  duplicated or unexpected IDs.
- Offsets/lengths are safe integers, bounded by record and committed prefix limits.
- Addresses are ordered by physical offset and do not overlap. Gaps may contain
  the identity frame or redundant physical copies of the same event.

The little-endian `LIX1` buffer contains a magic/count header followed by 16-byte
records: checkpoint event-ID ordinal (`u32`), byte offset (`u64`, safe JS integer),
and frame length (`u32`). IDs are referenced from the authenticated admission
index rather than serialized twice. Duplicate/missing ordinals, unsupported
formats and trailing/truncated buffers fail validation. Address storage costs
`8 + 16 * eventCount` bytes before checkpoint encryption, avoiding one extra
nested object per event and the binary codec's node-count limit.

These structural checks happen **before incomplete-tail repair**. A structurally
invalid owner-signed address map fails closed and preserves the file. Torn or
unauthenticated checkpoint slots retain their existing fallback behavior.
Selected reads subsequently verify that each address names its expected event.
The durable tail after the checkpoint is authenticated and indexed by normal
recovery; a crash cannot publish addresses for discarded incomplete bytes.

Old checkpoints without addresses remain valid. Their first indexed catch-up
rebuilds the addresses once through bounded sequential pages, checking signatures
and the existing authenticated content index without plaintext replay. That first
call can still scan all history. The complete rebuilt index is published only
after successful validation and included in the next scheduled checkpoint.
Old clients can ignore the optional checkpoint field; logs/native state remain
unchanged. Do not remove the admission index or native history to retain only
addresses: the latter cannot reconstruct or authorize state by themselves.

## Fences, lifecycle and custom stores

An indexed scan captures actors and a committed byte fence. Every selected address
must end within that fence. Each page re-seeks by the last sequence instead of
retaining a mutable array position; late inserts cannot shift its position or
include writes after the fence. New writes use live sync. Governance commits
invalidate old cursors as before. ACK backpressure, 32-cursor capacity, expiry,
shutdown and connection-loss cleanup also apply to the underlying selection.

`ILocalStore.openMissingEventScan(summary, end)` is optional and returns a local
`StoredEventScan` with `readPage()` and idempotent `close()`. `SyncEventPage`
reports selected physical records/bytes and explicit completion. A non-final
empty indexed page is rejected to avoid a stalled adapter spinning indefinitely.
The core accepts stores with either indexed selection or sequential `readEventPage`
plus `endOffset`; older stores retain the sequential/bulk fallback. This callback
is Worker-internal: no keys, file handles or address maps cross the client RPC.

Custom adapters must provide complete selections for the captured frontier/fence
and preserve flush/ownership/integrity contracts; completeness cannot be inferred
from an arbitrary adapter's claim alone. Remote peers cannot inject local index
addresses. Frontiers remain untrusted anti-entropy hints, not authenticated
assertions that a peer truly stores everything it advertises.

## Measurements and remaining costs

Run `npm run benchmark:sync`; it compares bulk, sequential cursor and indexed
cursor paths. [Raw indexed results](benchmarks/sync-cursor-indexed-node.json)
use Node 24.15.0, Windows x64, i7-10700, 2,000 signed/encrypted events with
128-character fields plus revision, 4,769,716 log bytes, a warm-up and three
samples per path/scenario. The timestamp is host-recorded. The index and native
admission are prepared before timing. The file is an **in-memory SyncFile**;
OPFS latency, index construction, checkpoint costs, cold startup, RTC, receiving,
flush and peak memory are excluded. Medians:

| Scenario | Bulk total | Sequential total | Indexed total | Indexed bytes read |
| --- | --- | --- | --- | --- |
| All 2,000 missing | 1,940.32 ms | 1,998.15 ms | 1,970.28 ms | 4,769,358 |
| Last 20 missing | 1,936.92 ms | 1,991.39 ms | 20.36 ms | 47,760 |

The small-tail case is about **98 times faster than sequential export** in this
fixture and reads about 100 times fewer bytes. Full-history export remains
similar (slightly slower than bulk here); indexing cannot skip missing data.
First full-transfer batch is ready in 53.72 ms indexed versus 1,937.94 ms bulk.
These are source-side measurements, not global throughput or browser latency.

The resident address index and checkpoint metadata are **O(events)** and add
memory/disk/serialization overhead. Actor enumeration is O(actors); initial
per-actor sorting can cost O(n log n) for out-of-order history, and concurrent
post-fence entries may be examined and skipped. This is not a disk-resident B-tree,
Merkle range proof, compaction or partial replication implementation. Initial
recovery, checkpoint prefix hashing and governance replay retain their existing
costs. Large-scale sparse overlay connectedness and paged group-key distribution
remain separate requirements; see [scalability](SCALABILITY.md).

## Validation

`tests/unit/log-offset-index.test.mjs` covers exact bulk parity and selected-byte
reads, short I/O, complete peer knowledge, out-of-order history, sequence holes,
in-flight late writes, address substitution, coverage/range failures, signed
checkpoint restore with durable deltas and incomplete tails, old-checkpoint
rebuild/migration, corruption during rebuild and a stalled custom adapter.
Chrome tests check selective Worker/OPFS export after real checkpoint recovery
and after WebRTC catch-up; cursor/crypto/policy suites retain their regression
checks for revocation, witnesses, reconnect and live edits.
