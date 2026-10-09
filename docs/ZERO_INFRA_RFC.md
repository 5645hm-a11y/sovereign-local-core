# RFC: autonomous agents and disconnected operation

Date: 2026-10-08. Status: proposal for review, not an implemented API.

This historical RFC evaluates the v0.1.0 baseline and proposes the next boundaries.
Version 0.2.0 subsequently implemented public encrypted discovery, generic Streams
sync, multi-peer mesh and native write policies/checkout invariants. See
[Discovery](DISCOVERY.md), [Policies](POLICIES.md) and the [changelog](../CHANGELOG.md)
for implemented contracts; the remaining moonshots below are proposals.
No runtime modules, published artifacts or GitHub releases are changed by this RFC.
The goal is useful operation without an application database service, with explicit
dependencies and measurable failure guarantees. Universal discovery, unlimited
offline authority and absolute survival are not achievable promises.

## Current source findings

| Component | Observed behavior | Consequence for the roadmap |
| --- | --- | --- |
| `native/core_engine.cpp`, `core_session.inc` | ABI 1 scalar LWW registers; ordinal ActorID/Lamport/sequence comparison; owned state, tombstones, staged updates, native checkpoints; 128 MiB input/output bound | A good deterministic reducer boundary. It lacks causal text revisions, typed invariant enforcement and a real-time execution bound. |
| `src/engine.ts`, `project.ts` | Serialized writes; Web Crypto signature/certificate/key checks; a full native query view built before each append, published only after durable append; root-witnessed historical revocation exceptions | All new transports must feed this validation path. AI and couriers must not directly mutate native state or disk. Large views also motivate an incremental query/diff ABI. |
| `src/wasm-loader.ts` | Producer-encoded binary commands; one `HEAPU8.set` into a reusable arena after Web Crypto decryption; native output copied for checkpoints | Binary-first, not literal zero-copy. Web Crypto returns its own output buffer. Keep this boundary rather than substituting custom cryptography for a copy optimization. |
| `src/checkpoints.ts`, `event-index.ts` | Two authenticated encrypted checkpoint slots; raw log-prefix digest; checkpoint exports one digest per event; contiguous actor watermarks | Native restoration avoids event replay, but cold prefix verification still reads prefix bytes and index restoration is O(event count). Watermarks do not prove edit causality or complete global history. |
| `src/p2p-sync.ts` | Binary events/chunks, durable batch acknowledgements, bounded fragmentation/backpressure, reliable ordered RTCDataChannel coupling, required signaling URL | Extract transport-independent sync before adding serial/BLE/courier/discovery providers. |
| `src/opfs.ts`, `framed-log.ts` | Exclusive Worker writer, append then `flush`, incomplete-tail handling, fail-stop on uncertain commits/corruption | Preserve acknowledgement semantics. Reload/Worker termination tests do not establish a physical power-loss or storage-device guarantee. |

The current reducer uses `std::map`, hash maps, strings and allocations; native
speed does not imply bounded worst-case latency. It also includes an Emscripten
heap dependency, so it is not yet a portable embedded/native engine.

## 1. Semantic conflict assistance with a local SLM

### Feasibility and trust boundary

Local inference in a separate Worker is feasible with an optional WebLLM/WebGPU
adapter [1]. A pinned model, prompt, seed and temperature do not establish
identical output across hardware/runtime versions; WGSL permits floating-point
variation [2]. Arbitrary generated merge functions do not establish CRDT laws.

The authoritative merge must remain deterministic. Preserve concurrent text
versions with a causal multi-value register; let an SLM produce a proposed
resolution, and replicate the approved bytes as a signed operation. Recipients
never rerun inference to reproduce an accepted resolution. CRDT convergence is
about the same valid update set reaching the same state, not factual correctness [3].

### Proposed contract

- A field schema selects `lww`, `mv-text`, or a later explicit CRDT type. Schema
  and resolver policy versions are signed/pinned by the project root.
- Text revisions carry authenticated parent references `(eventId, payloadDigest)`.
  The reducer retains revisions not causally superseded. Lamport order alone is
  insufficient to determine whether two edits were concurrent.
- `MERGE_PROPOSED` contains target item/field, exact input revision references,
  proposed text, provenance spans, and hashes of model/tokenizer/runtime/prompt/
  policy artifacts. These identifiers are audit metadata, not correctness proofs.
- `MERGE_APPROVED` references a proposal and the revisions it consumes. The
  authorized reviewer signs the exact output; it becomes a new text revision.
- A local approval checks that the proposed input heads are still appropriate.
  On remote replay, applicability is based on authenticated causal references,
  never on the order in which a replica received events. Unseen concurrent edits
  remain heads. Concurrent approvals remain visible conflicts requiring another
  resolution; arrival order cannot silently select the winner.
- Missing parents/policies are dependency-incomplete, not accepted into the view.
  Bounded staging and explicit dependency requests prevent unbounded memory/disk
  use. Distinguish a staging receipt from an acknowledgement of validated commit.
- A critical field remains unresolved until the configured human/threshold
  approval is present. Model confidence is not a safety signal. No inference can
  directly issue tools, elevate permissions, or approve a maintenance action.

Example: “No leak observed at 09:00” and “Leak observed after pressure test at
10:00” must retain both observations and their context. A generated sentence
claiming “No leak” must not overwrite their source reports. Incident context may
also be insufficient to decide whether the reports refer to the same equipment.

Use a dedicated semantic Worker, outside the persistence/crypto Worker. It receives
only explicitly selected plaintext and returns bounded proposals. Ship the model,
tokenizer, runtime glue and assets in an integrity-pinned offline installation
bundle; caching after an internet download alone is not an air-gapped installer.
Evaluate a 0.5–1.5B quantized model on real Hebrew/domain data before selecting it.
At four bits, 0.5B weights alone are approximately 250 MB; actual RAM/VRAM also
includes runtime, buffers and KV cache. There is no inferred latency guarantee.
Use request cancellation, GPU device-loss handling and a manual merge fallback.

Integration: add versioned event-envelope/codec support and an ABI 2 feature
negotiation for causal registers and checkpoint state. Continue reading ABI 1;
older clients must explicitly refuse unsupported new operations. Do not encode
causal parents as an ambiguous JSON string inside an ABI-1 scalar field.

Acceptance: randomized delivery orders, duplication, delayed parents, late edits,
concurrent approvals, revocation/replay, model failure and poisoned report text
produce convergent heads without loss of original evidence. Run domain evaluation
separately from algebraic convergence tests.

## 2. Disconnected physical transfer and store-carry-forward

### Feasibility

An ordinary Web Bluetooth site connects as a BLE central to a remote GATT server;
it cannot advertise itself as a browser-hosted peripheral. Device selection needs
a user gesture, and the API is Window-exposed [4, 5]. Two unmodified browsers do
not create a BLE mesh. Use a companion app or BLE bridge peripheral. Acquisition
and Bluetooth I/O stay in the UI adapter; bytes cross a MessagePort to sync/engine.

Web Serial supports approved serial ports and streams, with initial user selection
[6]. A USB serial bridge, two radio-equipped adapters, or a native host can link
machines without an IP router. Two USB hosts connected by an arbitrary USB cable
do not constitute a serial transport. Evaluate throughput and reconnect behavior
on the actual bridge before claiming suitability for video.

This is a disconnected network with declared import/export paths. A courier that
later connects to the internet is a bridge across isolation domains; a strictly
air-gapped deployment needs explicit policy for that crossing. The full app and
Worker assets must also be installed beforehand, with a stable origin/storage
namespace, rather than fetched from a website each launch.

### Shared transport and session layer

Illustrative interfaces only; these are not current exports:

```ts
interface ByteLink {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly maxFragmentBytes: number;
  close(reason?: string): Promise<void>;
}

interface SyncSession {
  attach(link: ByteLink, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

interface DiscoveryProvider {
  exchange(local: SignedSignalEnvelope, signal?: AbortSignal):
    AsyncIterable<SignedSignalEnvelope>;
}
// SignedSignalEnvelope is a separately versioned proposed signaling contract.
```

Extract wire framing and catch-up/chunk state machines from `p2p-sync.ts` into a
bounded `sync-session.ts`. RTC, serial and BLE adapters present streams; actual
read/write boundaries are not message boundaries. Capabilities negotiate versions,
fragment size and credit. For BLE, fragment further to the characteristic's tested
write/notification limit; never send a whole 1 MiB chunk as one GATT write.

Preserve signed events, certificate validation, chunk hashes, AES-GCM integrity,
deduplication and flush-before-commit-ACK in the existing engine. Transport CRCs
only identify framing errors; they do not authenticate data. ACK/write-drain at
the physical link is not database durability. Use bounded credit windows, retries,
fair scheduling of events versus chunks, transfer IDs, reconnect/resume and
AbortSignal cancellation. Retain existing LocalCoreClient API and RTC tests.

### Courier bundles

Use a delay-tolerant store-carry-forward design inspired by BPv7 [7], without
claiming BPv7 wire compatibility. A portable binary bundle includes a version,
project-root binding, content hashes, dependency/control records and encrypted
events. Optional chunks are explicitly selected; normal FILE_ADDED handling
remains lazy. Signed dependency manifests, length/resource limits and separate
ciphertext custody storage prevent a courier from bypassing engine authorization.

For the first prototype, couriers are already authorized members. A blind
non-member courier later requires a separate `CourierStore` and recipient-sealed
envelopes: the current engine/storage provider intentionally refuses non-members.
Give custody receipts and validated-commit receipts different names and meanings.
Use quotas/hop limits and deduplication for blind custody; TTL is a local forwarding
hint, not trustworthy authorization when wall clocks can be wrong.

Acceptable proof: A writes offline; A meets B; A disconnects; B later meets C;
C validates/flushes the events and pulls explicitly selected chunks. After a
worker restart, frame loss, duplicate bundle and reconnect, all intended writes
and byte hashes match. A never needed to be online concurrently with C. Add a
real hardware serial smoke test; mocks cannot prove BLE/radio operation.

## 3. Discovery without a project-operated signaling service

### Feasibility

Nostr relays are WebSocket servers, not server elimination [8]. A provider can
remove the developer's need to deploy a relay, while depending on selected public
infrastructure. Relays can refuse, rate-limit, drop and retain messages. The
BitTorrent mainline DHT uses UDP for routing/peer-contact lookup, not a generic
SDP mailbox [9]; access is not available to a normal website through WebRTC.
An IWA Direct Sockets deployment or native companion can explore UDP/DHT [10],
but changes installation and permissions and still needs bootstrap contacts.
Neither option removes ICE connectivity needs or possible TURN relay use [11].

### Proposed contract

- Split signaling discovery from PeerConnection/data sync. Preserve the explicit
  WebSocket provider; add manual QR/file exchange first, optional Nostr later.
- Pin a discovery profile in the invitation: permitted providers/addresses,
  version, independent random rendezvous secret and expiry policy. No hidden
  hardcoded third-party network calls. “No setup” can mean invitation-provided
  configuration; it cannot mean no rendezvous knowledge or connectivity.
- Derive rotating routing topics and separate AEAD keys with domain separation
  from the rendezvous secret. Do not expose a hash of a human-readable project
  name as a public discovery identifier. Rotate material on revocation; old
  offline participants cannot learn fresh discovery material instantly.
- Encrypt SDP/ICE payloads; bind inner P-256 signatures to project root, peer,
  session, challenges and the handshake contents including DTLS fingerprints.
  Enforce payload limits, replay caches and fresh challenge response. A room tag
  or valid Nostr event never grants project membership.
- Nostr requires secp256k1 Schnorr signatures, while our core uses P-256 Web Crypto
  [8, 12]. Keep an optional transport identity/implementation, bind it inside the
  project-signed handshake, and never reuse the project private key. This adds
  an audited cryptographic dependency or native helper; it is not an all-Web-Crypto
  implementation. Nostr JSON stays in discovery, outside the binary data path.
- Choose an appropriately allocated application event kind and verify relay
  support. Ephemeral events and expiration hints are not guaranteed deletion.
  Subscribe before publishing, retry boundedly, and reconnect with fresh sessions.
  Multi-relay operation improves robustness but does not create an SLA.
- Manual SDP exchange needs no relay for signaling. It still fails when there is
  no usable data path; it does not turn an offline Bluetooth pair into WebRTC.

Acceptance: forged/replayed signaling is rejected, secrets/SDP are absent from
public payloads, offline-clock behavior is explicit, provider outages cannot corrupt
database state, and discovery failure reports unavailable connectivity rather than
silently switching to an undisclosed service.

## 4. Three additional architectural directions

### A. Capability-restricted agent branches

Give agents separate actors and signed capabilities for branches, schemas,
operations and resource budgets. An agent writes to a deterministic fork pinned to
an authenticated causal frontier/policy version, produces a typed proposed patch,
and requests an authorized promotion. Do not permit model-generated JS/C++ to run
inside the reducer. Replay the same accepted commands to inspect a proposal.

Check capabilities in the engine on local dispatch, incoming events and recovery,
not just in an SDK. Branches are not native ABI-1 functionality: require a versioned
branch identity, ancestry, approvals and new checkpoint semantics. Field/table read
isolation also needs separate encryption domains and keys; a scoped certificate
cannot hide data from an actor already holding the whole project key.
An untrusted agent runtime needs a separate origin/process and an allowlisted
bridge; a same-origin Worker is not an access-control sandbox for that origin's
storage. Use distinct delegated agent/device signing identities rather than
cloning an active writer vault across concurrent hosts with the same sequence space.

Expired/revoked authority cannot be known instantly during isolation. Define a
conservative epoch/witness policy; authority-sensitive external effects need a
reachable authority or must wait. Global offline budgets require preallocated
escrow rights, not a local counter. DB replay does not make payments, equipment
commands or other external effects exactly once; those endpoints need idempotency.

Feasibility: high for typed proposal branches, medium for replicated capability
and budget enforcement. Measure rejected scope violations, fork replay equivalence,
competing promotions and unchanged production state before approval.

### B. Verifiable recovery and explicit survival guarantees

Segment the encrypted log and chunks into content-addressed objects with signed
Merkle manifests. Separate the local physical append-prefix root (arrival order)
from a canonical logical event-set/state commitment (same valid event set).
Use authenticated segment indexes/range proofs for anti-entropy and partial
recovery; do not confuse inclusion proofs with complete or honest history.

Add independent custody receipts and optional erasure coding over ciphertext.
With an `(n,k)` scheme, any k valid shards reconstruct a segment, tolerating up
to n-k missing shards, provided placement is across independent failure domains.
Storage overhead is n/k; loss of too many custodians or all decryption keys is
unrecoverable. Hashes detect corruption; recoverable redundancy supplies repairs.

Cold startup has a deliberate choice: eager integrity validation still reads all
relevant bytes; lazy verification avoids that scan but reports an incompletely
scrubbed state until blocks are checked. No Merkle root abolishes disk reads.
Checkpoint signatures authenticate the signer/bytes, not the correctness of
arbitrary remote state. Accept a remote checkpoint only under an explicit trusted
witness policy or verified replay, never as a shortcut around authorization.

Feasibility: medium. First ship portable encrypted backup/restore and periodic
scrub/repair with measured resource bounds. Existing `index.export()` and cached
raw-prefix hashes identify concrete O(N) growth to address; do not delete old
history/tombstones before defining offline retention and governance reconstruction.

### C. One deterministic core, browser and bounded native hosts

Extract a platform-neutral reducer/codec library from the Emscripten boundary.
Keep browser crypto/OPFS adapters and add explicit native crypto/file adapters for
headless agents or installations requiring filesystem fsync semantics. Pin protocol,
toolchain and policy versions; use fixed capacity/arenas, per-call work budgets,
bounded diagnostics, integer/unit-typed critical quantities and identical fixtures.
Add a versioned changed-record/query-diff ABI so each commit need not decode and
allocate the entire view in JavaScript; preserve the current full snapshot API
for explicit queries and define exactly when subscribers see a flushed delta.

Native/WASM differential tests, malformed-input fuzzing, crash injection and
convergence property tests provide evidence. They do not certify a browser or
provide hard real-time scheduling. Airborne safety use has assurance requirements
of its own; FAA AC 20-115D recognizes DO-178C as an acceptable assurance route [13].
Operational maintenance records and fault-report assistance are a reasonable first
deployment scope; flight-critical control requires a separate assurance program.

Feasibility: medium for a portable native host; high effort for bounded execution
and substantially higher effort for a certified airborne integration. Publish the
exact failure envelope, not an “absolute survivability” claim.

## Recommended implementation sequence

1. **Transport-independent sync + courier bundles.** Extract the existing RTC
   state machine, preserve compatibility, add a streaming bundle import/export
   and mock-stream adapter, then a real Web Serial bridge test. Initially use
   authorized carriers and ABI 1. Demonstrate the A → B → C disconnected scenario.
   This enables the physical network and future discovery providers without
   waiting for GPU, model-quality or new CRDT semantics.
2. **Causal registers + agent proposal/approval contracts.** Specify envelope/ABI
   migration and prove deterministic behavior before optional SLM inference.
3. **Verifiable backup/recovery and native host work**, prioritized by operational
   requirements. Preserve historical governance dependencies and private keys.
4. **Optional Nostr discovery**, after provider abstraction, transport identity
   review and measured relay compatibility. Do not make public relays a hidden
   default or a prerequisite for local operation.

First-step proposed files: `src/sync-session.ts`, `src/transports/rtc.ts`,
`src/transports/serial.ts`, `src/courier-bundle.ts`, and focused transport/courier
tests. These names specify future work; they are not present exports. No performance
numbers or completion dates are promised for these new features before measurement.

## Primary references checked for this proposal

1. [WebLLM Worker and caching documentation](https://webllm.mlc.ai/docs/user/advanced_usage.html).
2. [WGSL floating-point evaluation](https://www.w3.org/TR/WGSL/#floating-point-evaluation).
3. [Conflict-free Replicated Data Types, Preguiça](https://arxiv.org/abs/1805.06358).
4. [Chrome Web Bluetooth roles and user activation](https://developer.chrome.com/docs/capabilities/bluetooth).
5. [Web Bluetooth specification and Window exposure](https://bluetooth.spec.whatwg.org/).
6. [Chrome Web Serial permission and streaming guide](https://developer.chrome.com/docs/capabilities/serial).
7. [RFC 9171, Bundle Protocol v7](https://www.rfc-editor.org/rfc/rfc9171.html).
8. [Nostr NIP-01: signatures, relay endpoints and event kinds](https://github.com/nostr-protocol/nips/blob/master/01.md).
9. [BitTorrent BEP 5: mainline DHT](https://bittorrent.org/beps/bep_0005.html).
10. [Chrome IWA Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets).
11. [RFC 8445, ICE](https://www.rfc-editor.org/rfc/rfc8445.html).
12. [Web Crypto algorithms](https://www.w3.org/TR/webcrypto-2/).
13. [FAA AC 20-115D](https://www.faa.gov/airports/resources/advisory_circulars/index.cfm/go/document.information/documentNumber/20-115D).
