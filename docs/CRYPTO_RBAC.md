# Project encryption, certificate chains, and revocation

## Modules and boundary

| Module | Responsibility |
| --- | --- |
| `certificates.ts` | Signed Admin/Member certificates, bounded chains, pinned root verification |
| `project-crypto.ts` | AES-GCM fields, ECDH/HKDF key envelopes, signed invitation bundles |
| `project.ts` | Authorized history evaluation, decryption, revocation filtering, current key epoch |
| `project-storage.ts` | Persist public trust anchor and recipient-encrypted keys in OPFS |
| `engine.ts` | Serialize commands, validate complete batches, append/flush, publish authorized views |
| `crdt.ts` / `native/core_engine.cpp` | Verified wrapper and C++/WASM per-field LWW projection |
| `p2p-sync.ts` | Carry ciphertext events; no keys, decryption, disk writes, or permission decisions |

The normal client API keeps identity handles and raw project key material inside its
Dedicated Worker. A snapshot exposes decrypted fields to the local application;
events returned by `dispatch`, `readEvents`, and `onCommit` contain ciphertext.
No cryptographic npm dependency was added.

## Creating, joining, and reopening

```ts
import { LocalCoreClient } from "./dist/index.js";

const admin = new LocalCoreClient();
await admin.createProject("admin-replica-v3", {
  email: adminEmail, password: adminPassword, projectId: "project-42",
});

const member = new LocalCoreClient();
const { actorId } = await member.identify({ email: memberEmail, password: memberPassword });
const { invitation } = await admin.inviteMember(actorId, "Member");

// Transfer the invitation through an authenticated channel and compare the project root.
await member.open("member-replica-v3", {
  email: memberEmail, password: memberPassword, projectId: "project-42", invitation,
});
await member.dispatch({ type: "ITEM_ADDED", itemId: "task-1", fields: { title: "Private content" } });

// A normal P2PSync can now exchange the two clients' signed ciphertext event logs.
await admin.revokeMember(actorId);
```

`identify` initializes/unlocks the password-protected identity vault without opening
a project. It returns only ActorID. `createProject` creates a random 32-byte master
key, a self-signed root Admin certificate, and a root-signed project descriptor.
`inviteMember` emits a durable `MEMBER_INVITED` event and returns a signed recipient
invitation. `open` without saved project metadata requires an invitation; it never
silently creates a new Admin for an arbitrary project ID.

On later opens, credentials and database name recover the saved project descriptor,
membership certificate, and encrypted key envelopes. An incoming invitation cannot
replace a pinned root for an existing replica. A joined actor starts its Lamport
clock at least at its certificate issuance clock, and writes using the current epoch
from the signed invitation, including before initial network catch-up.

The first invitation is the trust-bootstrap step. A valid self-signed descriptor
alone does not prove that its signer is the intended project's administrator. The
application must deliver invitations authentically or compare `rootActorId` through
a trusted channel. A shared project/room name is not a trust anchor.

## Permissions

Certificates contain `version`, `projectId`, `subject`, `issuer`, `role`,
`issuedLamport`, `parent`, and `signature`. Their signatures cover a domain-separated
canonical binary tuple, recursively including the signed parent. Actor IDs are full public
P-256 points. Chains must terminate at the exact root certificate pinned by the signed
project descriptor, whose signature also binds the genesis key fingerprint.

Every wire event carries its author's certificate. Verification requires a valid
event signature, matching certificate subject/ActorID, matching project, a valid chain,
and an event clock at least as large as certificate issuance. Knowing an AES key is
not enough to gain permission. A self-signed Admin certificate from another key is
rejected even if it uses the correct project ID and has a genuine ECDSA signature.

| Actor | Write items | Invite Member | Invite Admin | Revoke/rotate |
| --- | --- | --- | --- | --- |
| Member | Yes, while authorized | No | No | No |
| Delegated Admin | Yes, while authorized | Yes | No | No |
| Pinned root Admin | Yes | Yes | Yes | Yes |

Root-only revocation/rotation is an explicit policy of this implementation. It avoids
cyclic/concurrent revocation authority among administrators without introducing a
consensus protocol. Delegated Admin certificates support actual chains (root → Admin
→ Member); revoking the Admin also invalidates its descendants after the cutoff.
Root cannot revoke itself. Directly revoked actors cannot be re-invited through the
current API; reinstatement needs an explicit future policy/new identity.

## Event encryption and signatures

Event schema is now version 3. Item events have no plaintext `fields` property:

```ts
{
  schemaVersion: 3,
  projectId, id, actorId, sequence, lamport, certificate,
  type: "ITEM_ADDED", itemId, keyId,
  encryptedFields: { iv, ciphertext },
  signature,
}
```

AES-GCM-256 encrypts a producer-encoded SCW1 ABI-1 command, including typed scalar
fields and redundant metadata, with a fresh random 12-byte IV and a 128-bit tag.
Delete commands contain no fields. Additional authenticated data is the canonical
binary encoding of this tuple:

```text
["sovereign-local-core/fields/v1", schemaVersion, projectId,
 id, actorId, sequence, lamport, type, itemId, keyId]
```

The event signature covers the canonical tuple:

```text
["sovereign-local-core/event-binary/v1", schemaVersion, projectId,
 id, actorId, sequence, lamport, normalizedCertificate, type, normalizedBody]
```

For items, `normalizedBody` is `{ itemId, keyId, encryptedFields: { iv, ciphertext } }`;
for administrative events it is the normalized invitation/revocation object. The
SVB1 encoder sorts object keys ordinally and encodes crypto properties as raw byte
blobs. Public APIs retain base64url strings. ECDSA signatures use SHA-256 and 64-byte
P1363 `r || s`. Deduplication compares SHA-256 canonical payload fingerprints after
verifying signatures; randomized signing of the same ciphertext remains
idempotent. Encrypting the same command again generates a different event payload.

Only after signature/authorization checks does a recipient decrypt, bind the native
command metadata to its signed envelope, and validate scalar fields in C++. A
genuinely signed event with invalid AES-GCM or native command content is
rejected before disk writes. Metadata, including actors, item IDs, event types, clocks,
certificates, key fingerprints and ciphertext sizes, remains visible by design.

## Recipient key envelopes

For each recipient, the sender generates a fresh ephemeral P-256 ECDH key pair.
The recipient's existing P-256 ActorID is imported as an ECDH public point. On vault
unlock, its PKCS8 identity key is additionally imported as a non-extractable ECDH
`deriveBits` handle; the original ECDSA signing handle remains separate. This keeps
the existing ActorID/vault format compatible, while using the same underlying
identity scalar for signing and agreement. A future separate encryption-key identity
format would require a signed key binding and migration.

ECDH produces a 256-bit shared secret, then HKDF-SHA-256 derives an AES-GCM wrapping
key with a random 32-byte salt and the binary envelope context as `info`. The
canonical binary context/AAD is:

```text
["sovereign-local-core/project-key/v1", projectId,
 keyId, recipientActorId, ephemeralPublicKey, salt]
```

The envelope carries `{ keyId, recipient, ephemeralPublicKey, salt, iv, ciphertext }`.
The wrapped plaintext is exactly the 32-byte project key. Unwrap verifies its
SHA-256 fingerprint against `keyId`. The invitation's independent Admin signature
binds the entire descriptor, certificate, envelope array, and `currentKeyId`, so a
bootstrap attacker cannot substitute ciphertext or downgrade the current epoch.
The enclosing administrative event signs that bundle again for the event log.

All known historical keys are wrapped for newly invited members so they can replay
existing history. Project metadata stores only signed public material and wrapped
keys. Raw AES key bytes remain in Worker memory to support future Admin distribution;
the normal client API does not return them.

## Revocation and offline history

A `MEMBER_REVOKED` event is root-signed and contains:

- The target ActorID; its event Lamport is the cutoff.
- `allowedHistory`: exact event IDs and SHA-256 canonical payload digests witnessed
  by the root, including affected descendant events.
- A fresh AES key fingerprint and individually wrapped envelopes for remaining
  known members, excluding the target and revoked delegations.

After observing revocation, an affected event is eligible only if its Lamport is at
or below the cutoff **and** its exact payload digest occurs in the root's commitment.
All later or uncommitted affected events are rejected before append, including
duplicates and deliberately backdated, correctly signed events. Witnessed old events
may arrive after revocation and are still accepted. Existing append-only records
invalidated by a newly learned revocation remain for audit; the view is rebuilt from
eligible history so arrival order does not determine the result. Catch-up filters
ineligible records out of outgoing batches.

Lamport is not a trusted wall clock. A revoked key holder can generate an event now
and claim an old Lamport value. Therefore an offline event that was never witnessed
before revocation cannot automatically be distinguished from a later forgery. This
implementation deliberately rejects such uncommitted history; it does not claim
arbitrary offline work can be safely preserved. A separate reconciliation/attestation
workflow is needed to change that policy.

Rotation is necessary because removing a certificate cannot erase an old shared
key. Normal writes switch to the new epoch. A revoked holder cannot decrypt new
epoch content with old keys, but retains the ability to decrypt historical content
it already had keys for. Non-revoked offline writers can still submit authorized
old-epoch work; rotation does not invalidate their history. Authorized members can
deliberately disclose plaintext/keys to others; this is outside what group encryption
can prevent.

Revocation is eventual: a disconnected peer cannot know an unseen revocation. Once
it learns the root command it enforces the policy. Withholding history, rollback of
an entire valid local log, and compromised root keys require additional checkpoint,
anti-rollback, and root recovery designs. Local checkpoints do not prove remote
history freshness or prevent whole-log rollback. Static-recipient ECDH envelopes do not
provide forward secrecy against later compromise of the recipient identity.

## Persistence and prototype limits

The Worker flushes the identity vault, then `project.slp` bootstrap metadata, before
opening `events.slc`. A valid checkpoint restores native registers and policy after
signature/AES authentication and raw-log-prefix verification; only the delta then
needs event signature, certificate, AES and native validation before incomplete-tail
repair. Without a checkpoint, the whole log is verified. A complete
unauthorized record with correct CRC preserves every byte and stops recovery. Each
event is flushed before state publication and P2P live notification. Storage errors
freeze the writer until reopen; batches can retain a durable prefix.

Existing signed JSON v3 certificates, descriptors, invitations, wrapped keys, events
and revocation witness digests have read-only compatibility paths. New appends use
binary transcripts and SLC2 event frames. Version-1/2 logs are rejected and preserved
for explicit migration. OPFS remains subject to quota/eviction/user deletion. Backups
must include the identity vault, wrapped project metadata, and encrypted event log.
One local writer per actor/project remains enforced; independently cloning one
identity into multiple writers still requires a device-actor/sequence design.

Ordinary item writes use incremental authorization and persistent native registers;
permission changes rebuild the projection from eligible history. Default checkpoints
occur every 1,000 durable events, alternating between two signed/encrypted OPFS slots.
Their AES key is derived from the local owner's self-ECDH/HKDF identity and project
context, not an old shared project key. A revoked holder of historical project keys
cannot decrypt newer cached state. Cache failure leaves the flushed log authoritative.
Startup still hashes raw prefix bytes and restores a history-sized deduplication index.
Explicit audit/catch-up and governance evaluation still scan history. Streaming,
compaction and anti-rollback remain future work. Authorization and decryption use
JS/Web Crypto; projection/checkpoint registers use WASM. See [the WASM contract](WASM.md).
Limits include 8 certificate delegations, 128 keys
per invitation, 4,096 history commitments/rotation recipients, 1 MiB stored records,
and 64 events per incoming batch. Exhausting these limits fails explicitly.

## Verification

`npm test` and `npm run test:browser` cover the existing storage/P2P regressions with
encrypted events, plus `tests/browser/crypto-rbac.spec.mjs`: outsider and role rejection,
revoked/backdated writes, attested offline replay, key rotation and exclusion,
encrypted OPFS bytes, AES-GCM rejection despite a genuine signature, late joining,
invitation tampering, delegated Admin chains, descendant revocation, and poisoned
OPFS recovery without mutation. Unit tests also check permutation-independent
revocation projection.

## Primary reference

[W3C Web Cryptography](https://www.w3.org/TR/WebCryptoAPI/) specifies the native
ECDSA, ECDH, HKDF and AES-GCM primitives used here.
