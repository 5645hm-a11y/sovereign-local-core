# Encrypted out-of-band P2P storage

File bytes never enter the event log or native reducer. `LocalCoreClient.storage`
is a main-thread facade over a Worker-side `StorageEngine`, a separate encrypted
OPFS blob store, and on-demand pulls through existing `P2PSync` DataChannels.
No runtime dependency or signaling-server change was added.

## Public API

```ts
// db is an opened, authorized LocalCoreClient; sync is its connected P2PSync.
const removePeer = db.storage.addPeer(sync);

const { manifest, event, snapshot } = await db.storage.upload(file, {
  name: file.name,
  // chunkSize defaults to 1 MiB; MIME defaults to file.type or application/octet-stream.
});

// Another member sees the metadata through ordinary log synchronization, without a download.
const metadata = await otherDb.storage.info(manifest.fileId);
otherDb.storage.addPeer(otherSync);

// Small image/document: Blob preserves the manifest MIME type.
const blob = await otherDb.storage.readBlob(manifest.fileId);
const url = URL.createObjectURL(blob);
image.src = url;
// URL.revokeObjectURL(url) when the UI no longer uses it.

// Large file: consume one chunk at a time, never collect all bytes into an array.
const controller = new AbortController();
const readable = await otherDb.storage.readStream(manifest.fileId, { signal: controller.signal });
await readable.pipeTo(destinationWritable, { signal: controller.signal });
// Equivalent: await otherDb.storage.pipeTo(manifest.fileId, destinationWritable, ...).

removePeer(); // sync.stop() closes the connection; db.close() closes its Worker.
```

`destinationWritable` can be a user-selected file's `createWritable()` stream or a
bounded streaming processor. It belongs to the application; the encrypted local
cache does not persist a decrypted assembled file. `readBlob` deliberately rejects
files above **16 MiB**, before downloading. A native Blob constructor or
`Response(stream).blob()` does not establish a bounded-memory guarantee for a
500 MiB result. Use `readStream`/`pipeTo` for that size. Plaintext delivered to the
application is necessarily readable by the authorized application.

Existing `LocalCoreClient` methods and the C++ ABI remain unchanged. Added low-level
client RPCs are `uploadFile`, `fileInfo`, `readFileChunk`, `acceptFileChunk`,
`createChunkRequest` and `serveChunk`; normal callers use `db.storage`. Worker replies
and imported chunk buffers use transferable ArrayBuffers. Project CryptoKey handles
stay inside the Worker and are never returned over RPC.

## Upload, encryption and durable publication

1. Validate file/manifest limits and select the current project key epoch.
2. Read `blob.slice(start, end).stream()` for one fixed-size chunk at a time. Slice
   bounds also protect against a source whose `stream()` yields a huge buffer.
3. Encrypt independently with AES-GCM-256, a fresh random 12-byte IV and a 128-bit
   tag. Binary AAD binds the project ID, pinned root/genesis, file ID, key epoch,
   total size, chunk size, chunk index and exact plaintext length.
4. Hash the complete stored chunk (header + IV + ciphertext/tag) using SHA-256.
   The hash is the content address, not a hash of public plaintext.
5. Close the OPFS writable stream, then explicitly acquire/flush/close a sync
   handle. Short-lived handles are not left open between chunks. Await completion
   before moving on to the next chunk.
6. After every chunk succeeds, dispatch one encrypted/signed `FILE_ADDED`
   containing `storageType: "FILE_ADDED"` and one binary-encoded scalar manifest.
   The core's usual append/flush/CRDT/notification lifecycle publishes it.

The manifest has `version, fileId, name, mime, size, chunkSize, keyId, chunks`.
`chunks` is the ordered list of ciphertext hashes. It is encoded with the existing
canonical binary codec and adapted to a base64url scalar because the current CRDT
field contract is scalar-only. This adapter is metadata, not file content or JSON.
Keeping the entire descriptor in one atomic field prevents independently merged
fields from accidentally combining two different manifests. The item ID is a fresh
`file_<UUID>`; names are metadata and never filesystem paths.

`FILE_ADDED` is an explicit logical event type whose signature and AES-GCM AAD bind
that type. Its metadata command maps to the existing native add operation in ABI 1;
no file bytes or new native opcode are introduced. The engine validates the exact
manifest field set and file ID on dispatch and after decryption, before accepting
even genuinely signed incoming events. Files receive existing E2EE, RBAC,
checkpoints and deterministic LWW behavior. They appear in
the existing Snapshot item list. Deleting the item through `ITEM_DELETED` removes
it from the view; it does not physically garbage-collect chunks.

OPFS path:
`sovereign-local-core/<databaseName>/<projectId>/blobs/<SHA-256-base64url>`.
Each replica has its own cache, avoiding additional cross-replica writer locks.
Stored chunks are SLB1 binary: little-endian magic `0x31424c53`, version 1,
u32 plaintext length, 12-byte IV, then GCM ciphertext/tag. Overhead is 40 bytes.
Full file content is never serialized into JSON, base64 or a WASM command.

Failure before metadata commit leaves only unreferenced encrypted chunks; it never
publishes an incomplete file. An event may survive a crash before acknowledgement,
as with ordinary dispatch. Physical GC/resumable uploads/idempotent upload commands
are separate work; the implementation never guesses which unreferenced chunks are
safe to delete. Quota errors propagate without publishing a manifest.

## Pull protocol and authorization

SVB1 logical messages on the existing ordered/reliable DataChannel:

```text
CHUNK_REQUEST  { v: 2, type, request }
CHUNK_RESPONSE { v: 2, type, requestId, hash, data: Uint8Array | null }
```

The Worker signs each request with ECDSA. The request contains a random request ID,
project/root/genesis identity, requesting ActorID and certificate, file ID, chunk
index and hash. Signatures cover a domain-separated canonical binary transcript.
The serving Worker verifies the pinned trust chain, signature, certificate subject,
current revocations and exact file-manifest hash/index before reading ciphertext.
A hash or room token alone grants no access. A null response covers absent,
unauthorized or otherwise unavailable chunks without exposing rejection details.
Requests are read-only: repeated requests are still checked against current policy;
request IDs correlate responses rather than serve as an anti-rollback/freshness proof.

Transport only routes bytes and coordinates framing. The requester Worker verifies
the hash against its own authorized manifest, validates the header, decrypts and
checks GCM/AAD integrity, then durably stores **ciphertext**, not plaintext. Only
after this succeeds does it return a bounded plaintext chunk to the stream. Bad
hashes, wrong position/file binding and failed AES authentication never enter the
cache. The manifest digest is pinned for the read, so replacement midway fails
instead of silently producing a mixed file or bypassing the Blob size cap.

Receiving metadata does not issue any request. Cache hits require no peer. Missing
chunks are requested sequentially from explicitly registered peers; an unavailable
or corrupt provider allows the next peer to try. A successfully cached recipient
can itself serve later pulls. Both endpoints need the storage-aware code to accept
new `FILE_ADDED` events and answer chunk requests. Older marker-based `ITEM_ADDED`
file manifests remain readable; their historical signatures/bytes are not rewritten.

## Streaming, backpressure and lifecycle

- Default chunk: 1 MiB. Configurable 64 KiB–1 MiB, maximum 1,024 chunks and 1 GiB
  per file. A smaller chunk size reduces the maximum supported total size.
- The readable has `highWaterMark: 0`: opening it does not download anything.
  Each consumer pull produces one chunk; downstream backpressure controls progress.
- Per peer, concurrent readers are serialized: one active chunk request and at
  most eight active/queued small requests. Overflow fails explicitly. No unbounded
  queue of ciphertext responses is accumulated by legitimate transfers.
- Existing 16 KiB fragmentation, 256/64 KiB channel backpressure and 2 MiB message
  limit remain. Chunk headers/envelopes fit that limit at 1 MiB. The receive queue
  is capped at 32 logical messages to bound hostile/misbehaving peer traffic.
- Request timeout defaults to the configured acknowledgement timeout (15 seconds).
  Abort cancels the active pull; queued aborted work is discarded before sending.
  Late responses are ignored. Pair replacement/close rejects pending pulls.
- Existing P2P reconnection still works. An interrupted stream errors; retrying the
  read uses already flushed chunks locally and requests only remaining chunks.
  Retrying an export from the start requires resetting/replacing its destination.

Memory remains proportional to a bounded number of chunk buffers, manifests and
the existing database state. It is not literally one buffer/zero-copy: Web Crypto,
codec/framing and Blob slicing allocate bounded buffers. Browser internal memory,
the application's original File/Blob and a consumer that accumulates every chunk
are outside the streaming implementation's bound. No plaintext temporary OPFS
assembly file is created to hide RAM usage.

Historical file keys cannot be taken back from a revoked recipient. New uploads
use the current epoch; a peer that has learned a revocation rejects that actor's
pulls. A disconnected peer cannot enforce an unseen revocation. Project-level
membership permits access to all project files; per-file ACLs are not implemented.
No cloud backup, automatic replication, provider discovery, erasure coding or
guaranteed availability is implied: at least one registered peer must hold a missing
chunk and be online. Backups now need the encrypted blob directory as well as the
vault, project metadata and authoritative event log.

## Verification

`tests/unit/storage.test.mjs` uses actual crypto/core/WASM and an ordered DataChannel
mock. It verifies exact splitting, metadata-only commits, independent IVs, durable
write failure, lazy pulls/framing, cache hits, alternate providers, hash and GCM/AAD
failure, certificate/actor/project mismatch, revocation, cancellation, manifest
replacement, concurrent readers, size-cap pinning and a streaming download >16 MiB.
The 500 MiB virtual unit-test source rejects whole-file reads and creates only bounded slices;
its discard sink verifies all 500 encrypted writes. This demonstrates processing
and buffer bounds, not 500 MiB durability or a measured browser RAM high-water.

`tests/browser/storage.spec.mjs` exercises real OPFS/Workers with both a mocked
channel and actual WebRTC between isolated browser profiles. It verifies no eager
chunks, encrypted disk bytes, exact reassembly, corrupt chunk rejection and cached
offline reopening. A separate 256 MiB + 137-byte virtual file test runs two actual
Workers, durably writes 257 encrypted chunks in source OPFS, synchronizes the
`FILE_ADDED` event over a mock DataChannel, and requests/caches all 257 chunks in
recipient OPFS only when consumed. A streaming sink checks every byte and chunk
position without assembling a whole-file buffer. The test verifies producer and
plaintext chunks never exceed 1 MiB, ciphertext size includes exactly 40 bytes per
chunk, frame/buffer bounds hold, and both metadata logs stay under 100,000 bytes.
It tests actual file durability and transfer, not a measured total browser RAM
high-water. The rest of the storage/identity/RBAC/P2P suite stays enabled.

The storage unit suite also checks signed logical type binding, whole-batch
rejection of malformed encrypted `FILE_ADDED` metadata and native checkpoint/delta
reopening with files on both sides of the checkpoint boundary.

Validated in this workspace: TypeScript build, **57/57 unit tests** (including
14 storage tests) and **26/26 Chrome browser tests** (including three storage
tests). The full 256 MiB + 137-byte OPFS/mock-P2P test completed in 18.1 seconds
in the full browser run; this is a test duration including encryption, durable
chunk writes, transfer, decryption and assertions, not a standalone throughput
benchmark or RAM measurement.

```sh
npm test
npm run test:browser
# Targeted after building:
node --test tests/unit/storage.test.mjs
npx playwright test tests/browser/storage.spec.mjs
```

Primary API references: [Blob streams](https://developer.mozilla.org/en-US/docs/Web/API/Blob/stream),
[Web Crypto AES-GCM](https://www.w3.org/TR/webcrypto/#aes-gcm),
[OPFS writable/sync access](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).
