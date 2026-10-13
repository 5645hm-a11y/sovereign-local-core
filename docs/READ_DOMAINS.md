# Cryptographic read domains for a general-purpose database

Status: included in v0.3.0. The published v0.2.0 package does not
include these APIs. Read domains apply to arbitrary scalar records and streamed
files; they are not tied to a particular application or business workflow.

## Security and storage model

`ReadDomainsClient` presents one logical namespace over independent projects.
Each domain has its own randomly generated AES-256 key, membership certificates,
OPFS event log, native reducer/checkpoints, blob store and discovery swarm. Keys
are **not** derived from a shared key. A reader invited to one domain receives
only recipient-encrypted keys for its granted projects.

Descriptor version 3 signs the complete routing map, project IDs, domain IDs,
prefixes, read roles and write policies. The longest item-ID prefix determines
the domain. Unknown prefixes fail; there is no implicit public fallback. The
same map is signed in each child descriptor, so omitting an invitation cannot
reroute a private prefix into a shared project. Local replicas pin this map.

The core enforces the boundary even if the facade is bypassed:

- Certificate verification rejects roles excluded from the domain's `readRoles`.
- Normal invitation issuance denies excluded roles before wrapping keys.
- Dispatch and imported/recovered data events must belong to this domain's
  signed namespace before decryption/projection.
- Native write policies still apply to every readable command. Read access does
  not imply create/update/delete permission.
- File manifests and chunk keys belong to the same independently keyed project;
  signed chunk requests cannot cross the project boundary.

This is cryptographic partitioning of reads at an immutable namespace boundary,
not a SELECT filter inside a shared-key project. There is no new native ECDSA
implementation: the Worker verifies signatures/certificates and C++ retains its
existing write-policy/invariant contract. The existing C ABI and checkpoints are
unchanged. Older clients reject descriptor v3.

## Create domains and write records

```ts
import { ReadDomainsClient, type ReadDomainDefinition } from 'sovereign-local-core';

const credentials = { mode: 'wallet' as const, walletId, passphrase };
const rule = (prefix: string, roles: ('Admin' | 'Member')[]) => ({
  prefix, create: roles, update: roles, delete: ['Admin'] as const,
  checkout: [], return: [], ownerField: null, library: false,
});

const definitions: ReadDomainDefinition[] = [
  {
    id: 'shared', prefixes: ['record_', 'file_'], readRoles: ['Admin', 'Member'],
    policies: { version: 1, defaultAllow: false,
      rules: [rule('record_', ['Admin', 'Member']), rule('file_', ['Admin', 'Member'])] },
  },
  {
    id: 'private', prefixes: ['private_', 'file_private_'], readRoles: ['Admin'],
    policies: { version: 1, defaultAllow: false,
      rules: [rule('private_', ['Admin']), rule('file_private_', ['Admin'])] },
  },
];

const db = await ReadDomainsClient.create('application_data', credentials, definitions);
await db.dispatch({ type: 'ITEM_ADDED', itemId: 'record_1', fields: { text: 'Shared content' } });
await db.dispatch({ type: 'ITEM_ADDED', itemId: 'private_1', fields: { text: 'Internal content' } });
const view = await db.snapshot();
console.log(view.items, view.unavailableDomains);

// Save this recipient-encrypted bootstrap and the encrypted wallet vault for recovery.
const bootstrap = db.bootstrap;
const trust = { rootActorId: db.rootActorId, spaceId: db.space.spaceId };
```

Domain/project IDs are generated randomly. `Admin` must be a read role in every
domain so its pinned root can administer/revoke/rotate it. The current role set
remains Admin/Member/Kiosk; write permissions are configured explicitly, and
applications can issue per-actor grants to selected domains. Custom role names
and dynamic read predicates are not implemented.

Definitions are strictly normalized: 1–16 domains, unique IDs/project IDs,
1–16 prefixes each, at most 64 total unique prefixes, identifiers up to 64 ASCII
characters and unique known read roles. Each opened domain currently owns a
Dedicated Worker. These are resource limits of this implementation, not a claim
of unlimited project size. See [scalability contracts](SCALABILITY.md).

## Grant access and join

```ts
// recipientActorId comes from the recipient's local wallet identification.
const invitation = await db.inviteMember(recipientActorId, 'Member', ['shared']);
const text = JSON.stringify(invitation); // Public descriptors + recipient-encrypted keys.

// On the other device, authenticate the root and space through a trusted channel.
// Do not obtain the expected root only from an untrusted invitation itself.
const joined = await ReadDomainsClient.open(
  'application_data', recipientCredentials, JSON.parse(text),
  { rootActorId: expectedRootActorId, spaceId: expectedSpaceId, requiredDomainIds: ['shared'] },
);
```

Without a domain list, `inviteMember` selects domains allowing that role. An
explicit list can grant a subset, enabling separate teams/collections with the
same role. Missing domains remain explicitly unavailable. The signed routing map
still includes them, so dispatch/read attempts fail rather than falling back.
`requiredDomainIds` lets a caller enforce trusted invitation completeness.
Different subjects/roles, substituted roots/maps, duplicates, tampering and
unsupported descriptors fail preflight before starting domain Workers.

`db.domain(id)` exposes the authorized `LocalCoreClient` for ordinary queries,
sync APIs or per-domain management. It throws for an ungranted domain. Existing
single-project APIs remain supported. Existing React `useProject` can also open
one granted project with its credentials/invitation/readDomain configuration;
do not open the same actor/project simultaneously through a facade and a hook.

## Files and P2P

```ts
import { NostrDiscovery } from 'sovereign-local-core/nostr';

await db.connect(() => ({ discovery: new NostrDiscovery(), maxPeers: 8 }));
console.log(db.network); // Per-domain state, peers and counters.

const { manifest } = await db.uploadFile('private', file, { name: file.name });
const stream = await db.readFileStream(manifest.fileId);
await stream.pipeTo(destination); // Bounded chunk reads; no whole-file buffering.

await db.close(); // Stops owned discovery/RTC sessions and closes all domain Workers.
```

Configure a `file_..._` prefix in a file-bearing domain; upload chooses its first
matching file prefix, or accepts an explicit `filePrefix` option. Longest-prefix
routing reserves `file_private_` for the private domain even when `file_` is
shared. A wrong-domain upload fails before writing its first chunk. Legacy
`file_<uuid>` IDs remain valid.

`connect` starts discovery, not a guarantee of online peers or completed catch-up.
Inspect `db.network` before requesting an uncached file. Files remain lazy;
manifest receipt does not download chunks. An Admin can read private files over
its private swarm; a shared Member neither joins that swarm nor holds its key.
Public relay/STUN and optional TURN dependencies remain as documented in
[Discovery](DISCOVERY.md).

`disconnect` releases owned transports while keeping local storage open.
Callbacks include `domainId`, and aggregate decisions also include it: event
IDs/sequences are scoped to each project. `snapshot.domains` retains each
domain's separate clock/view; the facade does not invent a global transaction
clock or claim an atomic snapshot across independent Workers.

## Revocation, recovery and partial operations

`await db.revokeMember(actorId)` requires the pinned root in every opened domain.
It revokes/rotates in opened domains where the actor is known. A partial facade
cannot revoke unopened domains. Revocation cannot erase old plaintext or keys
already held by a reader. Existing signed historical witnesses still apply.
Restart discovery after a key-epoch change with `disconnect()`/`connect(...)`.

Each domain flushes acknowledged events before publication and uses existing
owner-encrypted checkpoints/recovery. Reopen with the saved bootstrap and the
same wallet; credentials do not recreate deleted random keys. There is no atomic
commit across domains. Keep each business invariant within one domain.

Creation may leave durable partial initialization. `ReadDomainInitializationError`
lists successfully opened `createdDatabases` and `attemptedDatabases` that may
contain partial data. All started Workers are closed on failure; data is preserved.
Do not retry creation over existing data as if it were a rollback. Invitation and
revocation failures report `ReadDomainOperationError.completedDomainIds` and
`failedDomainId`; completed actions remain committed and require explicit retry.

Existing policy-free/shared-key projects are not retroactively made private.
Create a new signed read space and migrate authorized records/files into the
correct domains, validating counts, denied access and backups before cutover.
The root and authorized readers can intentionally disclose plaintext/keys;
metadata such as domain IDs, project IDs, prefixes, roles and traffic can be
visible. This is not protection against an authorized endpoint being compromised.

## Verification

`tests/unit/read-domains.test.mjs` tests independent keys against captured
ciphertext, signature/root/map tampering, role admission, cross-domain injection,
namespaced private files, checkpoint recovery and key rotation. Real Chrome
tests exercise three devices, independent encrypted Nostr/WebRTC swarms, live
shared edits, private lazy pulls only to granted readers, reload recovery,
revocation and preflight failures without pinning untrusted OPFS metadata.
