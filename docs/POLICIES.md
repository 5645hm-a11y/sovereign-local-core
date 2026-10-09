# Sovereign wallets, native write policies and deterministic loans

These APIs ship in version 0.2.0. Install its GitHub release artifact using the
[README](../README.md), or build from source with [Contributing](../CONTRIBUTING.md).
Existing email-based clients and policy-free projects remain supported.

## Trust and execution boundary

```text
local wallet -> P-256 event signature + project membership certificate
  -> Worker: verify signature, pinned root chain, revocation, AES-GCM and binding
  -> C++: authenticated role + bound binary command + root-signed policies
  -> deterministic candidate replay -> row state + decisions
  -> encrypted append / flush -> publish view and durable sync ACK
```

The Worker uses Web Crypto to authenticate every event, including OPFS recovery.
The C++ reducer applies write policies and business predicates. It does not verify
ECDSA itself: the role argument is trusted only after Worker verification. Calling
the low-level WASM exports with an invented role is outside this trust boundary.
Recipients using the normal core still verify the signed event and certificate.

## Wallets without email or an authentication server

```ts
import { LocalCoreClient, libraryPolicies } from 'sovereign-local-core';

const db = new LocalCoreClient();
await db.createProject('library_local_replica', {
  mode: 'wallet', walletId: 'desk_admin', passphrase: userSuppliedPassphrase,
  projectId, policies: libraryPolicies('book_'),
});
```

`walletId` is a local identifier; it is not a globally registered username.
Passphrases must meet the existing minimum of 12 characters. The credential
selector is domain-separated from email vaults. Random P-256 signing and ECDH
keys are encrypted in the existing PBKDF2/AES-GCM vault; the signing public key is
the ActorID. Credentials unlock the vault; they do not regenerate a deleted key.
Unlocked private key handles are non-extractable. Back up the encrypted vault and
project data, and use distinct wallets for concurrent writers.

`createWalletVault` / `unlockWalletVault` are also exported for identifying a device
before inviting it. `db.identify({mode: 'wallet', walletId, passphrase})` exposes
the ActorID without creating a project. Joining uses `db.open(databaseName,
{mode: 'wallet', walletId, passphrase, projectId, invitation})`; subsequent opens
reuse the locally persisted invitation. Email/password is an optional vault UI,
not an external Auth dependency. This is a public-key wallet and certificate
model, not an implementation of W3C DIDs or Verifiable Credentials.

## Roles and Web of Trust

The project creator pins a root ActorID and signs its own Admin certificate.
`await db.inviteMember(deviceActorId, 'Kiosk')` issues a signed role certificate
and ECDH-encrypted project-key envelope. Roles are `Admin`, `Member` and `Kiosk`.
Events carry their certificate proof; certificate chains are verified against the
pinned project root before a role reaches native code.

Only the root can grant Admin. A delegated Admin can invite Members and Kiosks,
but cannot delegate another Admin. The existing ancestor revocation, signed
historical witnesses and project-key rotation apply to Kiosks as well. An
untrusted role string, self-issued non-root Admin certificate or foreign-project
certificate grants no authority. Invitation delivery must authenticate the root.

## Immutable, root-signed policy configuration

`policies` is an optional `createProject` / `open` option. Enabling it creates a
version-2 root-signed project descriptor. Every invitation binds the exact policy
configuration. Reopening with different policies, tampering or downgrading the
descriptor fails. Configuration is immutable for this version; changing policies
requires an explicit new-project migration. Existing version-1 projects keep
their original LWW behavior, and older clients fail closed on version 2.

```ts
import type { ReducerPolicies } from 'sovereign-local-core';

const policies: ReducerPolicies = {
  version: 1, defaultAllow: false,
  rules: [{
    prefix: 'note_',
    create: ['Admin', 'Member'], update: ['Admin', 'Member'], delete: ['Admin'],
    checkout: [], return: [], ownerField: 'ownerId', library: false,
  }],
};
```

The longest matching **item-ID prefix** selects a rule. A mutable `kind` field
cannot change a row's security classification. Every rule explicitly lists roles
for `create`, `update`, `delete`, `checkout` and `return`. No implicit Admin bypass
overrides these lists. `defaultAllow` covers unmatched generic item/file writes;
CHECKOUT/RETURN always require an explicit library rule. The library preset denies
unmatched writes, permits Admin create/update/delete and Admin/Kiosk checkout/return.
Add an explicit `file_` rule if that project needs file metadata writes.

For `ownerField`, non-Admins must supply their authenticated ActorID at creation
and cannot change it to someone else. Subsequent actions must target their own
row in the deterministic replay state. Admins bypass the owner predicate but
still need the action's role permission. Rules are strictly normalized, unique,
limited to 32, with ASCII identifier prefixes/owner-field names of 1–128 characters.
Library-managed `loanId`, `borrowerId` and `checkedOutBy` cannot be written through
generic add/update commands or selected as owner fields.

These are **write/merge policies**, not row-level confidentiality. Authorized
members share the project key and can decrypt the project's events regardless
of write permissions. Read/SELECT isolation needs distinct row/group keys and
separate key-distribution rules; it is not implemented here.

## Exclusive checkout state machine

```ts
await db.dispatch({ type: 'ITEM_ADDED', itemId: 'book_copy_1',
  fields: { title: 'Distributed Systems' } }); // Admin

const result = await db.dispatch({ type: 'CHECKOUT', itemId: 'book_copy_1',
  fields: { borrowerId: 'reader_42' } }); // Admin or certified Kiosk

const decision = result.snapshot.decisions?.find(d => d.eventId === result.event.id);
console.log(decision?.status); // ACCEPTED or REJECTED_CONFLICT

await db.dispatch({ type: 'RETURN', itemId: 'book_copy_1',
  fields: { checkoutId: result.event.id } }); // References this exact loan
```

The reducer retains every authenticated, statically permitted candidate and
replays in ascending `(Lamport, ordinal ActorID, sequence)` order. With equal
Lamport clocks, the smaller ActorID wins. Arrival order and duplicate delivery
have no effect on the final view for the same eligible event set and policy.
Generic fields retain LWW ordering; conditional commands use the replay state:

- CHECKOUT requires a present, unborrowed copy; acceptance sets the loan ID to
  the checkout event ID, borrower ID and signing ActorID.
- RETURN requires a present copy whose current loan ID matches `checkoutId`.
  A stale return cannot clear another checkout.
- Deleting a borrowed copy becomes `REJECTED_CONFLICT`, even for an Admin.
  Return the exact loan before deleting the copy.
- An owner mismatch against replay state becomes `REJECTED_POLICY`.

`snapshot.decisions` contains every CHECKOUT/RETURN decision and rejected stateful
generic command, with `{eventId, itemId, type, status}`. Static role denials reject
the operation before append; they do not appear as durable decision records.
A batch containing such a denial is rejected before its first write. The native
session stages candidate/state changes and publishes them only after validation
succeeds; a policy denial does not freeze a healthy core.

An invariant loser is still an authenticated event: it remains encrypted in the
append-only log and synchronizes to other peers. `dispatch()` resolving means
durable receipt, not irrevocable business acceptance. Listen for later commits
and refresh the decision. Earlier events learned later can replace a provisional
winner and invalidate a return that had previously succeeded. Discarding losing
candidates or checkpointing only the winning row would break convergence.

Two offline kiosks can temporarily each accept a checkout. This convergent view
cannot stop both physically handing out a resource while disconnected, establish
that all history has arrived, or prevent an authorized actor choosing misleading
clocks. Physical exclusivity/finality requires preallocated escrow ownership or
coordination. This is a fixed deterministic policy/state-machine DSL, not arbitrary
JavaScript contracts, Byzantine consensus or general distributed transactions.
See [Coordination Avoidance in Database Systems](https://arxiv.org/abs/1402.2237)
for the distinction between merge convergence and invariant-preserving execution.

## Binary ABI and recovery

The base C ABI remains 1; its legacy exports/SCW1 command layout remain usable for
policy-free projects. Additive `core_session_configure` consumes SCP1 policies.
`core_session_apply_authorized` consumes an authenticated role and bound command,
or role 0 with an SCB2 batch of role/command pairs. CHECKOUT/RETURN use SCW1 command
version 2 (opcodes 4/5); generic commands keep version 1. Policy snapshots use SOV
version 2 for the decision suffix, and checkpoints use SCK2. Configured sessions
reject the legacy unprivileged apply path and mismatched/legacy checkpoint restore.

Checkpoints retain the exact policies, candidate binary commands and verified
roles. The existing owner-encrypted, signed OPFS checkpoint wrapper authenticates
these cached values. Restore recomputes decisions before applying the verified log
tail. Governance changes rebuild from eligible authoritative history, so a revoked
certificate cannot keep its effects merely because it was cached. Complete invalid
logs fail closed before incomplete-tail repair; their bytes are preserved.

This first business reducer caps retained history at 100,000 candidates and
128 MiB of raw command bytes. It stages a candidate-history copy and replays the
ordered set on ingestion/restore. Those bounds are not a peak-RAM guarantee.
There is no safe garbage collection of losing history implemented yet. The old
LWW kernel/checkpoint benchmark numbers do not measure this replay path; no new
throughput or startup-time claim is made. Per-row indexing, proven stable frontiers
and escrow are follow-up work, not current capabilities.

## Multi-peer WebRTC mesh

```ts
import { P2PWebRTC } from 'sovereign-local-core';
import { NostrDiscovery } from 'sovereign-local-core/nostr';

const sync = new P2PWebRTC(db, { discovery: new NostrDiscovery(), maxPeers: 8 });
const removePeer = db.storage.addPeer(sync);
try { await sync.start(); }
catch (error) { removePeer(); sync.stop(); throw error; }
console.log(sync.peers); // instanceId, actorId, connection state per edge
// Dispose: removePeer(); sync.stop(); await db.close();
```

Each edge owns a PeerConnection, challenge-bound negotiation, SyncSession,
backpressure queues and retry state. Presence continues while online so late
members can join. `maxPeers` defaults to 8 and is configurable from 1 to 32; each
remote ActorID has at most one edge. A disconnected or failing edge does not
close other healthy connections. Aggregate `online` means at least one caught-up
edge, not that every member is present or every candidate is globally known.
Inspect `sync.peers` for individual link states.

The mesh uses `SyncSession({forwardRemote: true})`: durable imported events are
forwarded along other edges and duplicates emit no new commit, preventing endless
echoes. A sparse A–B–C topology can synchronize even without a direct A–C edge.
Lazy file pulls try online peers in turn; chunks remain encrypted and verified by
the Worker. No file is downloaded merely because its metadata arrived. Full mesh
cost grows quadratically; the degree limit bounds local connections, not global
membership. Public relays/STUN and optional injected TURN remain external services.
See [Discovery](DISCOVERY.md) for their limits and key-epoch reconnect behavior.

## Verification

`tests/unit/policies.test.mjs` tests wallet isolation, signed policy tampering,
Member deletion denial, every ordering of double checkout, stale returns,
ownership, atomic rejection, protected fields, checkpoint/late-delta recovery,
legacy bypass prevention and two-hop forwarding without indefinite echoes.
`tests/browser/policies.spec.mjs` uses actual Chrome Workers/OPFS and three real
PeerConnections over blind mock Nostr discovery to test convergence, wallet reload,
late joins, peer failure isolation and lazy cached-file failover.

Run `npm test`, `npm run test:browser` and `npm run test:dx`. These tests exercise
selected contracts; they are not an independent security audit or proof of
complete correctness for arbitrary business rules.
