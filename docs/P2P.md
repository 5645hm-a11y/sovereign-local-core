# Two-peer P2P synchronization, binary protocol v2

This page describes the retained `P2PSync` WebSocket signaling API. Since version
0.2.0 it delegates synchronization to `SyncSession`; encrypted public
Nostr discovery uses the new `P2PWebRTC` wrapper. See [DISCOVERY.md](DISCOVERY.md).

Version 0.3.0 [recovery and rekeying](DISCOVERY_RECOVERY.md) belong to `P2PWebRTC`:
normal subscriptions rebind on epoch changes, and an optional independent
control-only relay lets authorized cold peers recover signed governance. This
does not change the retained two-peer WebSocket wrapper.

Version 0.3.0 adds [bounded neighbor exploration](SPARSE_OVERLAY.md), with
authenticated expiring hints, idle-edge rotation and a `topology: 'fixed'` option.
This is separate from project membership; inspect per-edge states and candidate
diagnostics rather than interpreting `online` as global connectedness.
The wire format, external legacy API and native ABI remain compatible.
`P2PWebRTC` now manages multiple independent edges and enables durable imported-event
forwarding for sparse meshes. The legacy wrapper remains two-peer/local-commit-only;
see [mesh and native business contracts](POLICIES.md).

## Boundaries

`P2PSync` uses `ISyncCore`, normally implemented by `LocalCoreClient`. It does not
open files, append records, allocate event clocks, or apply CRDTs. The client forwards
RPCs to the existing Dedicated Worker. `LocalCore` verifies incoming event signatures
against their public-key ActorIDs and signed project IDs, verifies certificate chains,
revocation policy and AES-GCM content integrity, then checks
event identities, flushes them to the append-only log, applies registers, updates
Lamport time, and notifies subscribers only after durable commit.

The signaling relay routes opaque string bodies containing SDP/ICE between two
WebSockets. It parses the routing envelope, not the body, and never receives database
events in the normal protocol. It has no database, message queue, replay, payload
logging, or persistent files. Live socket membership and a random pairing epoch are
necessarily temporary routing state; a WebSocket room relay cannot be literally
memoryless. Empty rooms are removed and restart loses all membership. The server
limits each room to two peers and designates one offerer to avoid offer glare.

"Blind" here means payload-agnostic and non-persistent, NOT cryptographically unable
to inspect SDP/ICE. Signaling bodies are not end-to-end encrypted; the host can observe
connection metadata. Room token possession is not cryptographic peer authentication.
Events now carry independently verified signatures, project binding, authorization
certificates and encrypted content. A known project ID or room token is insufficient
for membership. The handshake itself is not signed; authenticated transport pairing,
malicious clocks and equivocation reconciliation remain future work. A hostile
relay/peer can withhold history; event signatures do not prove completeness.
Conflicting event IDs are rejected, not resolved by a consensus protocol.

## Browser API

```ts
import { LocalCoreClient, P2PSync } from "/dist/index.js";

const db = new LocalCoreClient();
await db.open("replica-a-v3", { email, password, projectId: "my-project", invitation });
// invitation is needed on first join; subsequent opens use pinned local metadata.
// Another tab uses replica-b-v3 with its own identity and Admin-signed invitation.

const sync = new P2PSync(db, {
  roomId: "<shared-random-UUID-or-base64url-token>",
  signalingUrl: "ws://127.0.0.1:8787",
  iceServers: [], // local demo; configure YOUR STUN/TURN for internet deployment
  onError: error => console.error(error.message),
});
sync.onStateChange(state => console.log(state));
db.onCommit(({ source, event }) => console.log(source, event));
sync.start();
await db.dispatch({ type: "ITEM_ADDED", itemId: "task-1", fields: { title: "hello" } });

// Local dispatch remains available when the transport is stopped/disconnected.
sync.stop();
// sync.start() reconnects and catches up from the durable log.
```

`state` is `offline | connecting | syncing | online | stopped`. `online` means the
initial two-way catch-up has completed, not that every subsequent live write has
already been acknowledged. `dispatch()` acknowledges local durability only.
`stats` reports attempted event sends, received batches/events, unique applied events
and pairing counts. `lastError` explains failures and clears on successful catch-up.

## Signaling envelopes

Client joins with `{ kind: "join", roomId }`; the random token must be 22–128 ASCII
letters/digits/underscore/hyphen. The relay answers `joined` and `waiting`, then sends
`{ kind: "paired", session, offerer }` to both peers. Clients relay only:

```json
{ "kind": "signal", "session": "pair-epoch", "body": "opaque SDP/ICE JSON string" }
```

The relay drops stale epochs and forwards within the joined room. It never accepts
arbitrary destination IDs or database sync messages as protocol operations. A third
peer is rejected with WebSocket close code 4403. The session changes whenever peers
are paired again, isolating late ICE candidates from an earlier connection. Pending
ICE candidates are queued until the remote session description is installed.

Default listener: loopback port 8787. Set `LOCAL_CORE_SIGNALING_HOST` and
`LOCAL_CORE_SIGNALING_PORT` to change it. Serve an HTTPS web app with WSS signaling
when deployed; TLS termination is external to this minimal relay.

## Data-channel messages

The channel label `events-v1` is retained and remains ordered/reliable. Logical
messages now use version 2 and canonical SVB1 binary envelopes; events retain
encrypted/authorized schema version 3. Both peers must run the new transport;
the label does not imply compatibility with old JSON v1 clients. The released
v0.2.0 baseline sends:

1. `hello`: `{ v: 2, type: "hello", summary: { actorId: contiguousSequence } }`.
2. `batch`: `{ v: 2, type: "batch", batchId, events }` for missing events.
3. `ack`: `{ v: 2, type: "ack", batchId }` only after engine validation, per-event
   disk flush and materialization. One outgoing batch awaits its durable ACK before
   the next outgoing batch. ACKs themselves do not wait for another ACK.
4. `done`: signals completion of this direction's initial catch-up. Both directions
   must complete before the connection becomes `online`.

Watermarks describe the highest CONTIGUOUS sequence starting at 1. Knowing sequence
3 alone advertises 0, not 3. Filling 1 then 2 advances the watermark to 3. Sparse
known events beyond the watermark can be resent; event identity deduplication makes
that harmless. `readMissingEvents` validates the summary and scans OPFS in the engine,
selecting eligible events with sequence above the peer watermark. Ineligible records
after learned revocation remain in the append-only audit log but are not sent.
Filtered actor sequence gaps can cause repeated sparse suffix delivery; compaction
and policy-aware sequence summaries are future work. At most 4096 actors are
supported by the released/legacy v2 handshake; a larger summary is rejected.
Version 0.3.0 negotiates [paged-frontier-v1](SYNC_FRONTIERS.md) within binary
v2: 128-actor / 32 KiB pages, generation/order/completion checks and page ACKs,
with a defensive 262,144-actor total bound. New cores opt in automatically.
Small legacy peers remain supported with conservative duplicate traffic; larger
frontiers require upgrading both ends. Standard clients now use
[bounded log cursors](SYNC_CURSORS.md) for source-side catch-up, fetching the next
disk page only after a nonempty batch's durable ACK. This removes the bulk export
array/decryption step. [Authenticated address indexes](SYNC_INDEX.md) now skip
known frames in standard OPFS stores; old checkpoints may require a one-time
rebuild. Sequential/custom fallback still scans history, and custom cores/stores
without cursor support retain bulk export.

`ingestEvents` validates the entire batch's schema, signatures, project binding,
certificate chains, revocation eligibility, ciphertext integrity and identity
consistency before writing. Even duplicate events are verified. An invalid event
rejects the batch without changing the log, view or watermarks and without
a durable ACK. Batches are NOT atomic multi-event transactions: a storage failure or crash
can leave a durable prefix. Recovery rebuilds its watermark; next catch-up transmits
the remaining suffix and duplicates are ignored. The recovered Lamport maximum
advances subsequent local event clocks without consuming the local actor's sequence.

The worker emits durable `onCommit` notifications for local and imported events.
Only local notifications trigger live sends, preventing echo loops. The subscription
is attached before connection/handshake; live writes during catch-up are queued after
the local hello. In paged mode, live sends also await complete bidirectional
frontiers. Missed sends during a disconnection remain in OPFS for the next hello.
Received commits can update the UI through the same observer API. Events in observers
are ciphertext; call `snapshot()` for the authorized local decrypted view.

Invitations and revocations share the same event transport. Within an incoming batch,
control events precede item events to install new key epochs before their ciphertext.
Revocation becomes enforceable once the peer learns it. An affected old event needs
the root's exact history commitment; a self-asserted old Lamport value is insufficient.
A revoked peer's stale batch may fail the sync session; possession of an old key does
not gain durable acceptance or access to newly rotated content. See
[the project protocol](CRYPTO_RBAC.md) for trust bootstrap and offline policy.

## Framing and backpressure

Catch-up batches contain at most 64 events, with an approximate 128 KiB target size.
A single larger event may occupy a batch by itself. SVB1 messages encode IVs,
ciphertext, signatures and other cryptographic properties as byte blobs, not base64
JSON. They are split into binary frames of at most 16 KiB (or a smaller negotiated
SCTP maximum). Signaling alone retains its JSON envelopes.
A 16-byte frame header contains magic/version, message ID, total length and offset.
Ordered delivery permits one bounded reassembly buffer. Logical messages are limited
to 2 MiB; stored records retain the local log's 1 MiB limit.

Sending pauses above 256 KiB buffered data and resumes at 64 KiB. A stalled channel,
closed channel or missing durable ACK fails the session rather than pretending data
was saved. The ACK timeout defaults to 15 seconds. Application dispatch can outpace
network throughput; the shared session now caps pending live sends at 32 operations
and closes on overflow, with the durable log providing recovery on reconnect.
Large-scale queue coalescing,
streaming disk iteration and bandwidth scheduling are not implemented yet.

## On-demand file chunks

Storage-aware clients also carry `CHUNK_REQUEST` and `CHUNK_RESPONSE` logical v2
binary messages on the same channel. The request is signed by a project member;
the serving Worker verifies current membership/revocation and file-manifest binding.
The response carries at most one 1 MiB encrypted chunk plus its header/tag, or null.
The receiving Worker checks hash and AES-GCM integrity before caching ciphertext.
The transport performs no decryption, merge or disk writes.

File metadata is an encrypted `FILE_ADDED` CRDT event with an atomic manifest,
mapped to the native add operation. Existing marker-based `ITEM_ADDED` file records
remain readable. Receiving metadata never downloads a file. Register the
connection with `db.storage.addPeer(sync)` to enable lazy `readStream`/`readBlob`.
Concurrent readers serialize pulls, with one active request and at most eight
active/queued requests per peer. The receive queue is bounded to 32 messages.
Late replies after timeout/cancellation are ignored; close/replacement rejects
outstanding pulls. After reconnect a new read reuses durable cached chunks.

`connectDataChannel(channel, optionalPeerConnection)` supports applications with an
existing reliable ordered channel and deterministic mocks; signaling remains the
normal `start()` path. Externally supplied channels require the caller to reconnect.
Both peers need storage-aware code for new file events and chunk transfer. See [STORAGE.md](STORAGE.md)
for signatures, memory bounds, quotas and file availability.

## Reconnection and NAT

WebSocket reconnect uses exponential backoff with jitter (250 ms initial, 15 s cap).
Failed ICE, a closed data channel, or disconnection lasting more than 2 s initiates
a fresh pairing. A browser `online` event retries an unavailable channel. Reopening
the app requires constructing the transport again with the same room/configuration;
the local database supplies durable recovery. Pair-specific queues and ACKs are
discarded on reconnect; old asynchronous work cannot send on the new channel.

An established data channel stays usable during a signaling outage. The socket
reconnects in the background; a new server pairing renegotiates and runs another
handshake. No events are persisted or recovered through the signaling relay.

Signaling exchanges addresses; it does NOT do NAT hole punching itself. ICE uses
explicitly configured STUN to discover reflexive candidates and TURN to relay where
direct connections are impossible. No public STUN service is silently configured.
The local automated tests use host candidates on one computer and do not establish
arbitrary internet/NAT connectivity. Configure organization-owned STUN/TURN for
that deployment; neither STUN nor this relay guarantees that TURN is unnecessary.

## Automated verification

```sh
npm test
npm run test:browser
```

The browser suite starts the static server on port 4174 (override with
`LOCAL_CORE_TEST_PORT`) and an actual WebSocket signaling relay on an ephemeral port.
It uses native WebRTC Data Channels and OPFS in headless installed Google Chrome.
Tests cover independent browser profiles and two tabs with distinct replica files,
initial bidirectional catch-up, live edits, concurrent convergence, remote persistence
after reload, offline edits, zero redundant sends on a no-change reconnect, signaling
restart, Unicode messages exceeding SCTP frame size, and interruption after a durable
catch-up prefix before its ACK. Unit tests cover watermark holes, deduplication,
whole-batch validation, Lamport advancement and storage failures during import.
The identity browser tests additionally prove forged ActorID rejection, signed-field
tampering rejection, vault unlock/reload, and preservation of a poisoned OPFS file.
The RBAC suite checks outsiders, revoked/backdated writes, encrypted OPFS storage,
key rotation, late joining, chained Admin delegation, and unauthorized-disk preservation.
See [the identity contract](IDENTITY.md) and [project encryption](CRYPTO_RBAC.md).

## Compact durable ingestion (v0.3.0)

`SyncSession` prefers optional `ISyncCore.ingestCommitted` and falls back to
`ingestEvents` for custom/older cores. Admission, merge, append/flush and durable
ACK order are unchanged; a receipt avoids building a full rows/decisions Snapshot
for each batch. UI observers can still request full views explicitly. Cursor
backpressure and interrupted-prefix recovery tests exercise the receipt path.
See [query/receipt contracts and scopes](QUERY_PAGES.md).

## References

- [WebRTC connectivity and ICE](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
- [Data-channel bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount)
- [Node ws library](https://github.com/websockets/ws)
