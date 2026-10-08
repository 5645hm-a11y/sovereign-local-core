# Core contracts and implementation

NPM/React integration is available through `sovereign-local-core` and
`sovereign-local-core/react`. See [bundling, hooks, examples and installation](DX.md).

A browser event-sourced database with encrypted project data, certificate-based
permissions, signed identities, and two-peer WebRTC synchronization. TypeScript,
C++20/WASM projection, binary event records and recoverable checkpoints, a Dedicated
Worker, native Web Crypto, and OPFS; the browser core has no runtime
packages. The optional Node.js signaling relay uses `ws` and stores no application
data. This repository is a working prototype.

## Run

Activate an Emscripten SDK first; this checkout also detects its task-local SDK.
The compiler is a build dependency only. See [WASM build and bridge](WASM.md).

```sh
npm ci
npm run dev:fixtures
```

Open http://127.0.0.1:4173 and call `await example()` in the browser console.
Reload restores the encrypted log, the same vault identity, and its decrypted view.
The examples visibly disclose their public demo credentials; they are integration
demos, not an account/login product. Use the same origin, port, and browser profile
to reopen the same OPFS replica.

```sh
npm test
npm run test:browser
```

The browser suite uses installed Google Chrome, an isolated static server on 4174,
and signaling on an ephemeral port. It does not replace a development server on 4173.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Commands, signed encrypted events, certificates, and sync interfaces |
| `src/identity.ts` | PBKDF2/AES-GCM vault, P-256 identities, event signatures |
| `src/identity-storage.ts` | Encrypted vault persistence and actor/project writer leases |
| `src/certificates.ts` | Admin/Member chains and pinned root verification |
| `src/project-crypto.ts` | AES-GCM field encryption, ECDH/HKDF key envelopes |
| `src/project.ts` | Authorization, key epochs, decryption, revocation evaluation |
| `src/project-storage.ts` | Signed project descriptor and encrypted bootstrap key persistence |
| `src/crdt.ts` | Authorized/decrypted per-field LWW materialization |
| `native/core_engine.cpp` | Native LWW stamps/registers and binary Snapshot output |
| `native/core_session.inc` | Persistent registers, binary checkpoints and atomic native updates |
| `src/binary-command.ts` | Encode plaintext commands once at production using ABI 1 |
| `src/binary-codec.ts` / `src/binary-events.ts` | Canonical binary envelopes and public object adapters |
| `src/wasm-loader.ts` | Async WASM loading, reusable native arenas and sessions |
| `src/checkpoints.ts` | Owner-encrypted/signed, alternating durable checkpoint slots |
| `src/framed-log.ts` | CRC framing, partial I/O, flush, and tail recovery |
| `src/local-store.ts` | Append-only event store and duplicate/owner checks |
| `src/engine.ts` | Serialized commands, authorization, durable state publication |
| `src/worker.ts` / `src/client.ts` | Worker-owned keys/storage/state and main-thread RPC |
| `src/event-index.ts` | Contiguous durable actor watermarks |
| `src/p2p-sync.ts` | Ciphertext transport, catch-up, live sync, reconnect, and backpressure |
| `src/storage.ts` / `src/storage-format.ts` | Streamed encrypted chunks, atomic CRDT file manifests and signed pull requests |
| `src/blob-store.ts` | Separate content-addressed OPFS ciphertext files |
| `src/storage-client.ts` | Lazy file streams, peer fallback, bounded Blob convenience API |

See [identity vaults](IDENTITY.md), [encryption and RBAC](CRYPTO_RBAC.md),
and [the P2P protocol](P2P.md) for contracts and limitations. The
[file storage contract](STORAGE.md) describes out-of-band streaming transfers. The
[WASM bridge](WASM.md) and [measured benchmarks](WASM_BENCHMARKS.md)
describe the native backend.

## Create, invite, write, and recover

```ts
import { LocalCoreClient } from "./dist/index.js";

const projectId = "project-42";
const admin = new LocalCoreClient();
await admin.createProject("admin-replica-v3", {
  email: adminEmail, password: adminPassword, projectId,
});

const member = new LocalCoreClient();
const memberCredentials = { email: memberEmail, password: memberPassword, projectId };
const { actorId } = await member.identify(memberCredentials);
const { invitation } = await admin.inviteMember(actorId, "Member");

// Authenticate invitation delivery / compare rootActorId through a trusted channel.
await member.open("member-replica-v3", { ...memberCredentials, invitation });
const { event, snapshot } = await member.dispatch({
  type: "ITEM_ADDED", itemId: "task-1", fields: { title: "Private task", done: false },
});
console.log(event.encryptedFields, snapshot); // Ciphertext event, decrypted local view.

// Transport forwards the ciphertext event; recipient authorization/decryption is in its Worker.
await admin.ingestEvents([event]);
await member.close();

const reopened = new LocalCoreClient();
await reopened.open("member-replica-v3", memberCredentials); // Saved vault/project metadata.
console.log(await reopened.readEvents(), await reopened.snapshot());
```

`open` on a new replica requires a trusted invitation. It never grants Admin just
because a project ID matches. `identify` initializes/unlocks an identity without a
project; `createProject` explicitly bootstraps a new root. `getProjectInfo` returns
public descriptor/certificate/current epoch metadata. `inviteMember` emits
`MEMBER_INVITED`; root `revokeMember` emits `MEMBER_REVOKED` and rotates the AES key.

For custom Workers: unlock an identity, create/open a `ProjectContext`, then call
`openOPFSStore(databaseName, actorId, projectId, project)` and
`LocalCore.open(store, identity, project)`. Standalone verified replay uses
`await new LWWMerge(project).materialize(events)`; the project context includes
trusted permissions and decryption keys. The normal client API does not expose keys.

## Event and merge contract

Version-3 events carry project ID, full public-key ActorID, sequence, Lamport, an
authorization certificate, ciphertext/control body, and signature. Every signed
field is canonicalized. Project binding, certificate chains and AES-GCM integrity
are checked before accepting data. Neither CRC nor room membership grants permission.
New event signatures cover canonical binary bytes. AES-GCM encrypts ABI-1 binary
commands; OPFS records and WebRTC application messages carry raw ciphertext bytes.
Public events retain their existing object/base64url shape. Deduplication verifies
signatures even for known IDs and compares canonical payload fingerprints;
different valid ECDSA signatures for identical ciphertext remain idempotent.

Decrypted fields are finite JSON scalars. Each field and item existence is an LWW
register ordered by `(lamport, actorId, sequence)` with ordinal string comparison.
Add sets existence true and specified fields; update changes fields without changing
existence; delete sets existence false. A later explicit add can restore an item.
Unspecified old fields remain; `null` is a value, not field deletion.

For a fixed authorized event set, projection is deterministic and idempotent. LWW
chooses one conflicting scalar value; it does not merge text or enforce business
invariants. A query `Snapshot` is not a replay checkpoint: native checkpoints also
preserve tombstones, hidden fields and register stamps. Revocation rebuilds the view from eligible
history, so previously accepted writes later invalidated by policy are excluded.

## Storage lifecycle

1. Unlock/create and flush the encrypted identity vault.
2. Verify/pin the signed project descriptor and flush recipient-encrypted project
   keys in `sovereign-local-core/<databaseName>/project.slp`.
3. Acquire a browser Web Lock for one writer per actor/project and an exclusive
   synchronous OPFS handle for `events.slc`.
4. Authenticate the newest valid checkpoint, bind it to the raw log prefix, restore
   native registers/counters/index, and validate only delta event records. Without a
   cache, verify the complete history. Validation precedes incomplete-tail repair.
5. Sign and authorize each append, write the CRC-framed record completely despite
   short I/O, and call `flush()`. Publish state/notify P2P only after success.
6. Every 1,000 durable events, encrypt/sign a native checkpoint with an owner-only
   key and flush the older of two cache slots. A cache failure does not uncommit an
   acknowledged event. On reopen, replay the delta; governance changes rebuild from
   full authorized history. Only incomplete
   tail bytes can be truncated. Complete corruption or unauthorized records stop
   recovery while preserving the file.
7. An uncertain write/flush failure freezes the core until reopen. `close()` releases
   handles/leases; correctness does not depend on an unload handler or shutdown flush.

An event persisted before its acknowledgement may survive a crash. A retry with
`dispatch` creates a new command/event; identical event imports are deduplicated.
Batches may retain a durable prefix on I/O failure. OPFS is subject to browser quotas,
eviction and user deletion. Backups need vault + wrapped project metadata + event log.
Signed encrypted JSON v3 records remain readable; new appends use binary SLC2 frames
without rewriting old bytes. Version-1/2 logs are preserved and rejected for explicit
migration. Checkpoints are optional caches, not substitutes for the authoritative log.

## Permissions and revocation scope

Members write items; delegated Admins additionally invite Members. Only the pinned
root delegates Admin or revokes/rotates, avoiding competing administrative histories.
Revocation excludes the target and its revoked certificate descendants from new key
distribution. Historical keys/content already held by a member cannot be taken back.

Lamport alone cannot prove an offline event predates revocation: a revoked signer can
backdate an event. Old affected events remain syncable only when their exact payload
hash was witnessed in the root's signed revocation. Unwitnessed offline work is
rejected by this conservative policy. A disconnected peer enforces revocation once
it receives it. The full policy is in [CRYPTO_RBAC.md](CRYPTO_RBAC.md).

## P2P demo

Run `npm run signaling` and `npm run dev:fixtures`. Open:

- `http://127.0.0.1:4173/examples/p2p.html?db=replica-a`
- `http://127.0.0.1:4173/examples/p2p.html?db=replica-b`

Await `window.ready` in both tabs. In A, call `await createDemoProject()`. Get B's
ActorID from `(await window.ready).actorId`, then call
`await db.inviteMember(bActorId)` in A. Transfer its invitation to B and call
`await joinDemoProject(invitation)`. Finally call
`await connectP2P(sharedRandomRoomToken)` in both tabs and dispatch edits.

The two tabs use distinct vaults/actors and replica files. Shared room possession
alone grants no project membership. ICE requires explicitly configured STUN/TURN for
arbitrary internet connectivity; local tests use host candidates. No public STUN is
configured implicitly.

## Encrypted file storage

```ts
db.storage.addPeer(sync); // Existing connected P2PSync; register on the receiving client too.
const { manifest } = await db.storage.upload(file); // File or Blob; default chunks are 1 MiB.
const blob = await db.storage.readBlob(manifest.fileId); // Up to 16 MiB, for image/document UI.
// Large files: bounded stream, no whole-file assembly in RAM.
await db.storage.pipeTo(manifest.fileId, destinationWritable);
```

After all chunks are durably stored, an encrypted/signed `FILE_ADDED` event publishes
only the CRDT manifest. Ciphertext chunks are pulled when read and cached separately
in OPFS. Requests require signed project
membership. Upload supports up to 1 GiB/1,024 chunks; failed uploads can leave
unreferenced encrypted chunks. Availability needs an online peer holding missing
chunks. See [storage lifecycle, limits and tests](STORAGE.md). Backups must also
include the blob directory.

## Current limits

- One local writer per actor/project; cloned identities across independent devices
  need device-specific sequence allocation.
- Metadata remains visible. Email identifies a local vault and is not mail-verified.
- Identity recovery requires the encrypted vault; credentials alone cannot recreate
  the random key after site data deletion.
- Ordinary item writes validate/apply only new events. Governance and explicit
  audit/catch-up APIs still evaluate full history; public Snapshot decoding costs
  O(visible fields). Streaming and compaction remain future work.
- Checkpoint startup still hashes raw prefix bytes and restores an O(history)
  deduplication index. It skips old event decoding, signature checks and decryption.
- Web Crypto allocates decrypted buffers; one copy into WASM remains. Full replay
  of individual binary records is still slower than the old projection bridge in
  the measured workload; checkpoint recovery and live writes avoid that replay.
- No SQL, nested/text CRDTs, multi-event transactions, consensus, or anti-rollback
  checkpoints. Valid malicious clocks and withheld history are not fully solved.

## References

- [Web Crypto primitives](https://www.w3.org/TR/WebCryptoAPI/)
- [OPFS exclusive sync handles](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
- [flush persistence](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush)
- [Browser quota/eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
