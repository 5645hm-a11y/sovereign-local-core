# Paged key epochs and revocation witnesses

Status: included in v0.3.0. The public v0.2.0 package predates this extension.
This protocol removes the single-record bottleneck for project key rotation;
it does not establish unlimited project membership or constant-memory recovery.

## API and cutover

The existing API keeps its event/snapshot result. Small rotations still use the
schema-3 inline format. The engine automatically chooses pages when either array
exceeds 4,096 entries or the complete encoded inline event would exceed 1 MiB.
Applications can request pages explicitly:

```ts
import { EpochIncompleteError } from 'sovereign-local-core';

const result = await admin.revokeMember(targetActorId, { paged: true });
console.log(result.event.id, result.pageCount);

const info = await replica.getProjectInfo();
for (const pending of info.pendingEpochs) {
  console.log(pending.manifestId, pending.missingKeyPages,
    pending.missingHistoryPages);
}

try {
  await replica.dispatch({
    type: 'ITEM_ADDED', itemId: 'records/example', fields: { value: 1 },
  });
} catch (error) {
  if (error instanceof EpochIncompleteError) {
    // Keep the authorized transport open so remaining control pages can arrive.
    // Retry the application operation after pendingEpochs becomes empty.
  } else throw error;
}
```

Worker RPC preserves the named error class. `ReadDomainsClient.revokeMember`
forwards these options independently to opened domains and returns each domain's
result, including optional `pageCount`. Cross-domain rotation is not atomic.

Every preparation page is root-signed, appended and flushed before the final
`MEMBER_REVOKED` manifest. Pages alone change neither revocation nor the active
key, and preserve existing native rows. A crash before the manifest leaves the
previous epoch active. Retrying uses a fresh random epoch ID and key; preparation
records from the failed attempt remain in the append-only log.

On receiving the signed manifest, the replica immediately enforces revocation.
It requires **all committed key and witness pages** before activating the new
epoch. During an incomplete transition:

- New-epoch writes, imports, discovery key access and default storage key access
  fail with `EpochIncompleteError`. They never fall back to the old key.
- Even a newer invitation/bootstrap containing the new key cannot bypass this
  incomplete state after the manifest is learned.
- Affected historical events are conservatively ineligible until the full witness
  commitment resolves. Their rows may temporarily disappear, then return when
  the exact witnessed history becomes eligible again.
- Unaffected old-epoch history remains readable with known keys. Already received
  keys/plaintext cannot be erased from a revoked recipient.

`getProjectInfo().pendingEpochs` reports missing page counts. Standard
`SyncSession` cursor catch-up sends governance before application events; durable
receipt summaries let interrupted sessions request missing controls again. Manual
bulk imports must likewise deliver controls before dependent data; a missing-key
failure does not persist that dependent event. The network does not authorize
pages or write them directly to OPFS.

## Signed binary protocol

Schema 4 adds `KEY_EPOCH_PAGE` and a paged form of `MEMBER_REVOKED`. Ordinary
events and inline revocations remain schema 3. Schema-4 events use canonical
binary signatures only; there is no legacy JSON signature fallback. Older clients
reject unsupported schema 4 rather than silently downgrade.

The final revocation keeps empty inline envelope/witness arrays and adds:

```ts
interface EpochCommitment {
  id: string;             // epoch_ + a fresh random 32-byte base64url nonce
  version: 1;
  pageSize: 128;
  keyCount: number;
  historyCount: number;
  keyRoot: string;        // SHA-256 Merkle commitment
  historyRoot: string;
}
```

Each page binds its epoch ID, new key fingerprint, revoked target, full commitment,
kind (`keys` or `history`), index, sorted entries and inclusion proof. Key entries
are existing recipient-encrypted ECDH envelopes; witnesses contain an exact event
ID and canonical unsigned-payload digest. Root signatures bind these headers.
The epoch nonce is independent of future actor sequence numbers, so a crashed
preparation does not reserve event IDs needed by a retry.

Leaf hashing binds the protocol domain, project, key, epoch, page kind, index and
entries. Internal nodes have a separate hash domain. Odd levels duplicate their
last node; verification checks that duplicated sibling and exact proof depth.
Empty witness sets use a separately tagged empty root. Both per-page and
cross-page ordering/uniqueness are checked, along with counts and placement.
[RFC 9162 section 2.1](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1)
describes Merkle inclusion commitments; this SDK's binary encoding and
duplicate-last tree are its own protocol, not Certificate Transparency encoding.

Only the pinned root can prepare or commit a rotation. Matching pages must precede
the manifest in both root sequence and Lamport order. A page's signature and
Merkle proof are checked even when its manifest has not arrived. Conflicting
headers, duplicate page slots under distinct signed event IDs, reused epoch IDs,
reused rotation keys, recipient leaks to known revoked delegations and complete
plans omitting the root envelope are rejected. A known target's delegated
descendants are also excluded during preparation, before the manifest exists.

The resolved epoch is cached separately from the original signed event; signed
objects are never rewritten to inject resolved arrays. Historical authorization
still requires the root's exact payload digest and a Lamport at/below the cutoff.
A clock alone never authorizes backdated work from a revoked key.

## Storage and finite bounds

| Boundary | Contract |
| --- | --- |
| Entries per page | 128, with an exact shorter final page |
| Encoded page body | At most 96 KiB; signed event also obeys the log's 1 MiB bound |
| Recipients per paged epoch | 65,536 maximum |
| Historical witness entries per paged epoch | 65,536 maximum |
| Inclusion proof | Exact tree depth, at most 9 siblings |
| Uncommitted preparation groups | At most 32 per evaluated history |
| Existing invitation keyring | Still at most 128 epochs |

Pages are encrypted key envelopes and public digest commitments, not raw project
keys. Metadata, recipients, target, counts and signatures remain visible like
existing governance metadata. Authorization/decryption remains in the Worker;
the C++ ABI-1 reducer still receives only validated plaintext commands.

Each page has the normal flush-before-publication contract. Root-generated pages
avoid replaying the native data projection individually; final cutover reevaluates
authoritative history. Manifest-first receivers revalidate as missing pages arrive.
Owner-signed/encrypted checkpoints retain partial/complete controls; replay checks
their signatures, proofs and policy before use. Cache failure leaves the durable
log authoritative.

The root currently constructs a complete bounded plan. Retained controls,
governance evaluation, checkpoint size and assembled witness maps grow with total
history; this is record paging, not a disk-resident or constant-memory governance
engine. No preparation garbage collection/cancellation protocol exists yet.
Repeated failed attempts can exhaust the 32 orphan-group allowance. Invitations,
native candidate history, browser quotas and other resource bounds still apply.

Version 0.3.0 [discovery recovery](DISCOVERY_RECOVERY.md) now provides a separate
control-only, recipient-encrypted path for replicas holding old keys. Normal
discovery rebinds automatically; existing authorized DataChannels carry rotations.
Recovery requires a reachable current replica with the controls and recovery
enabled. Otherwise updated authenticated bootstrap or another authorized transport
is needed. Broadcast/rate limits and WAN reachability remain separate concerns.
See [scalability](SCALABILITY.md).

## Verification and measurement

Unit tests cover bounded 10k synthetic record plans, altered proofs/project/index,
role forgery, manifest substitution, duplicate slots, revoked descendants,
manifest-first and preparation-first delivery, restart/checkpoints, a failed
manifest flush followed by retry, new-key invitation bypass attempts, and exact
historical authorization. A separate test uses **4,097 real signed/encrypted
events from one writer**, automatically producing 34 pages. This is not a
4,097-member test.

Chrome tests use real Workers, OPFS, Web Crypto and native DataChannels to verify
partial recovery, key cutover, ciphertext storage, catch-up and bidirectional live
writes. They use a local SDP harness, not public Nostr/WAN discovery.

Run `npm run benchmark:epochs`. The recorded Node v24.15.0 / Windows / Intel
i7-10700 fixture contains 10,000 synthetic envelope records and 10,000 synthetic
witnesses, one genuine root-recipient key, real root signatures and verification:

| Measurement | Recorded result |
| --- | --- |
| Pages | 158 |
| Largest signed page | 81,434 bytes |
| Final signed manifest | 2,406 bytes |
| All signed records | 9,302,688 bytes |
| Hypothetical inline record | 8,791,904 bytes (invalid under legacy limits) |
| Complete plan construction | 1,615.73 ms |
| Root signing | 2,773.16 ms |
| Complete verification / root unwrap | 3,986.58 ms |

Paging reduces the largest record, while proof/header overhead increases total
bytes. The hypothetical inline record is only a size comparison, not an admitted
or timed legacy rotation. These timings do not measure OPFS flushes, peak RAM,
Worker RPC, data-history replay, RTC or WAN latency. Copied envelopes at synthetic
actor IDs are not usable grants to 10,000 wallets. Raw scope/results are in
[epoch-pages-node.json](benchmarks/epoch-pages-node.json).
