# Paged actor frontiers (v0.3.0)

Available in v0.3.0; the public v0.2.0 artifact predates this extension. This source adds `paged-frontier-v1` to
`SyncSession`, used automatically by both WebRTC adapters when their cores expose
`readMissingEventsPaged`. `LocalCore` and `LocalCoreClient` expose it; external
implementations of `ISyncCore` can keep their existing methods unchanged.

## Wire contract

The binary v2 `hello` now optionally carries a versioned frontier manifest:

```ts
{
  v: 2, type: "hello", summary: {},
  frontier: { version: 1, id: "<fresh UUID>", actors: 10000, pages: 79 }
}
```

Both peers must advertise the extension before using `frontier-page` and
`frontier-ack`. Each snapshots its contiguous durable actor watermarks once.
Subsequent commits cannot move that generation's page boundaries.

- Pages contain at most **128 actors** and **32 KiB** of encoded message bytes.
- Each page references the generation UUID and a zero-based consecutive index.
- Exactly `ceil(actors / 128)` pages are required; an empty frontier uses one
  empty page. Every other page has the exact expected count.
- Actor ranges must be strictly increasing across pages. Duplicate, overlapping,
  skipped, wrong-generation and extra pages fail closed. Incomplete frontiers
  cannot be used for catch-up or cause an `online` state.
- One frontier page awaits an ACK per direction. ACKs are processed without
  blocking the receive loop on writes. Event batches likewise await durable ACKs.
- The receiver refreshes a 20-second inactivity deadline per page; the sender
  applies the configured acknowledgement timeout to each page.

Catch-up and live events wait until the local frontier is acknowledged **and**
the remote frontier is complete. This prevents a peer with fewer pages from
starting events while the other peer is still sending its actor ranges. Both
catch-up completion markers must arrive before `online`.

Watermarks remain **highest contiguous sequence**, rather than maximum observed
sequence. A replica holding event 3 without 1/2 advertises zero, so those holes
cannot disappear behind a high watermark. Duplicate event 3 is harmless; signed
content equivocation still fails in the core.

## Compatibility and reconnection

A v0.2.0 peer ignores the optional manifest and receives an empty, conservative
legacy summary: it sends its eligible history rather than assuming missing
knowledge. The new peer reads the old peer's legacy summary normally. This costs
extra duplicate traffic but preserves the existing small-project API/protocol.

If the new peer knows more than 4,096 actors and the other peer does not advertise
the extension, it closes with an explicit compatibility error. Large projects
must upgrade both ends. Unsupported manifest versions also fail closed.

On connection loss, assemblers, incomplete frontiers, pending ACKs and queued
waiters are discarded. Durable events remain in the core. The transport adapter
reconnects with a **fresh generation built from durable receipt**, not a reused
partial frontier. `SyncSession` itself owns one supplied stream; its caller
supplies a fresh link after stopping/replacing a broken session.

## Security and resource boundaries

Frontiers are untrusted anti-entropy hints, not membership or business proofs.
Their pages are bound to an ordered connection/generation but are not independently
signed Merkle proofs. WebRTC protects the channel; other `ByteLink` providers must
supply any required transport authentication/confidentiality. Event signatures,
project membership, read domains, revocation, RLS and native invariant checks stay
inside the Worker/core. Frontier ACKs assert transport receipt, not disk writes;
event ACKs follow validation, append, flush and merge.

The defensive total limit is **262,144 actors per frontier**, not unlimited users.
Wire pages and in-flight page count are bounded; total wire bytes and retained
frontier memory remain **O(actors)** per connection. The complete frontier is
assembled before catch-up. `getSyncSummary()` and its Worker RPC still produce a
full map. Standard OPFS clients now use [bounded log cursors](SYNC_CURSORS.md)
for catch-up without whole-log export arrays. Standard stores also use
[authenticated address indexes](SYNC_INDEX.md) to skip known frames; sequential
fallback and cold prefix verification still read history.
`readMissingEventsPaged()` remains a bulk compatibility API for explicit calls
and custom stores/cores without cursor support. This does **not** implement
Merkle range queries, bounded whole-core memory, partial
replication or sparse-overlay connectedness.
The existing event batch (64), send/live queue (32), frame (16 KiB) and logical
event/chunk message (2 MiB) limits continue to apply.

## Validation

Run `npm test` and `npm run test:browser`. The new tests cover:

- 10,000 **synthetic writing actors** at the sync boundary, including holes,
  partially shared histories, a previously unknown actor and live edits.
- 119 frontier pages across both directions for that fixture; largest encoded
  page **25,816 bytes**, frame plus stream prefix at most **16,388 bytes**.
  Total observed traffic was approximately **7.04 MB**, including catch-up/live
  batches, both frontiers, ACKs and framing. These are protocol measurements,
  not a production throughput or end-to-end crypto benchmark.
- Interrupting after 192 received/acknowledged events and reconnecting sends
  the remaining 9,808, using durable contiguous watermarks.
- Dropped/repeated pages, changed generations, overlapping/missing ranges,
  unsupported versions and the legacy fallback/large-frontier error.
- A real cryptographic core accepts a 10k-entry hint map, retains the legacy
  limit, and rejects forged signatures/equivocation without changing durable bytes.
- Duplicate signed invitations/revocations, including a known invitation mixed
  with a new data event, remain authorized and idempotent. Invalid duplicate
  signatures still fail before writes; controls take the full governance path.
- Chrome passes a 10k-entry **synthetic hint map** over real DataChannels into
  actual Workers, transfers real signed events, flushes OPFS, reloads and resumes
  live edits. This does not create 10,000 real certified project members.

Synthetic encodings are deliberately not usable signing identities. The tests
separate frontier-size behavior from the existing real signature, certificate,
private-domain, storage and recovery suites. Membership envelope limits and
large-swarm availability remain separate work; see [scalability](SCALABILITY.md).
