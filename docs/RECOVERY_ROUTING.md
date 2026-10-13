# Routed discovery recovery (v0.3.0)

Available in v0.3.0; the public v0.2.0 artifact predates this extension. This opt-in extension reduces recovery
fanout while retaining [control-only recovery](DISCOVERY_RECOVERY.md) and its
recipient encryption, root-authorized controls, durable admission and finite bounds.
Normal WebRTC discovery is configured separately.

## Configuration

Enable routing on the **independent recovery provider**:

```ts
const sync = new P2PWebRTC(client, {
  discovery: new NostrDiscovery({ routing: { bucketCount: 64, sampleBuckets: 3 } }),
  recovery: {
    discovery: new NostrDiscovery({
      routing: { bucketCount: 64, sampleBuckets: 3, rotationIntervalMs: 3000 },
    }),
    intervalMs: 30000,
    responseTimeoutMs: 15000,
  },
});
await sync.start();
```

All routed recovery participants must agree on their recovery bucket layout.
The normal discovery layout need not be identical to the recovery layout, but
must independently agree among normal-discovery peers. Never share provider
instances between the two channels or among read domains.

Without `routing`, the previous broadcast recovery mode remains available.
Routed mode requires the provider's `startRouted`/`publishRouted` methods and the
core's new `createRoutedDiscoveryRecoveryRequest` and
`handleRoutedDiscoveryRecoveryRequest` methods. `getDiscoveryRecoveryInfo` adds
a random `instanceId` for this local core's lifetime. A missing capability, inbox
or mode mismatch fails explicitly; there is no broadcast downgrade or automatic
bridge between layouts. Invitations do not negotiate these transport settings.

## Probe, select, then pull

1. The requester publishes an encrypted signed probe to its hashed presence
   bucket. Enabled peers listen to their own bucket plus a bounded rotating
   sample, and retain their own stable inbox subscription.
2. An authorized current responder sends a small signed **offer** directly to
   the requester's inbox. It contains its epoch fingerprint and return inbox,
   with zero control bytes and **no allocated serving cursor**.
3. The requester validates membership, nonce/session and placement before pinning
   one responder/inbox. If the offered epoch already matches its complete local
   epoch, the query completes without a cursor or control replay.
4. Otherwise, a fresh addressed request selects that responder. Only this step
   creates a bounded serving cursor. All subsequent fragment requests/replies go
   directly between the two inboxes, independently of sampled-bucket rotation.

Known older-epoch offers cannot downgrade or select a responder for a locally
known newer epoch. A signature does not establish unseen-history freshness;
same-epoch completion is relative to observed history. A malicious/stale first
responder can still delay progress. Timeouts restart from durable controls.

The probe's signed `replyTo` is the requester's random instance inbox token.
The offer and later responses sign the responder's `replyTo`. The selected
cursor binds the requester actor, session and return token; the receiver pins
the responder actor, epoch and return token. Changing either route during a
transfer is rejected. Routes are hints, never membership proofs. The recipient
ECDH box remains addressed to the wallet; redirecting ciphertext does not grant
another inbox's owner decryption rights.

The main thread receives only verified routing hints plus ciphertext. Ordinary
legacy requests/responses keep their canonical fields/signatures. Routed payloads
add signed `replyTo`; an offer also has `offer: true`, null cursor, zero sizes/
counts/bytes and `done: false`. Invalid/unknown fields are rejected. Routed and
broadcast core handlers reject each other's request modes. The encrypted outer
envelope and its separate signature/AES domains remain unchanged.

## Lifecycle and resource contracts

The adapter reuses [hashed routing](DISCOVERY_ROUTING.md) over the separate
genesis-derived recovery topic: one static inbox/own-bucket subscription plus
one rotating sample subscription per relay. In routed mode the raw recovery
topic is never published as a project-wide tag. The Nostr filters follow
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md); filter-honoring
relays are an assumption, not an authorization boundary.

Initial probe retry waits use 80–100% of the configured response wait (minimum
100ms) to reduce phase locking with rotating subscriptions. Selected fragment
waits stay fixed. Every retry creates a fresh session/nonce. Sampling can still
miss probes; neither jitter nor receipt of a relay ACK proves peer delivery.
Sparse layouts require matching sample/probe cadence and reachable responders.

Packet/fragment limits remain 32/16 KiB, one outgoing record assembly up to 1 MiB,
8 selected serving cursors, 65,536 controls per transfer, 32 queued packets and
4,096 unexpired nonces per request/response replay window. Unselected probes
consume signature/replay/offer work but no transfer cursor or history copy.
Several offers can reach a requester before selection; only the selected flow
advances. Stop/start, queued callbacks, relay reconnect and rotating samples keep
the provider's existing bounded lifecycle behavior.

These changes reduce disclosure of ciphertext to unrelated subscribers and
unnecessary allocations. They do not hide connecting IPs/timing from relays or
provide anonymity. Old-key holders can know the stable locator, grind placements,
flood probes or withhold traffic. Fixed bucket counts still cause quadratic
aggregate probe work; adaptive layouts, publication budgets, responder fairness,
targeted known-peer hints and governance memory remain future work. Automatic
cross-layout compatibility and arbitrary-size membership are not claimed.

## Verification and delivery model

Unit tests verify repeated probes allocate zero cursors, signed selection,
same-epoch completion, pinned routes, known-old/expired offers, mode/capability
failure and actual Nostr inbox routing across sample rotation. An unrelated
sample subscriber receives probes but no directed offers/replies. Chrome tests
run cold and partial-manifest recovery through a Member with the root offline,
then ordinary RTC data, lazy file pulls, revoked-wallet exclusion and OPFS reopen,
in both routed and broadcast modes. Installed-package tests exercise the new RPCs
and reject broadcast calls in routed mode.

Run `npm run benchmark:recovery`. The recorded delivery-count model uses production
address/sample derivation for **10,000 synthetic instance IDs**, 1,024 buckets,
3 sampled buckets, one probe per ID and 64 selected request/response fragment
pairs per requester. It assumes every non-self probe delivery elicits an offer,
one responder is selected and unique inbox filters deliver each directed packet
once. It does not simulate valid membership or establish successful selection.

| Model measurement | Recorded result |
| --- | --- |
| Probe deliveries, including self delivery | 400,769 |
| Directed offer deliveries | 390,769 |
| Directed fragment deliveries | 1,280,000 |
| Total routed deliveries | 2,071,538 |
| Same hypothetical workload on a project-wide topic | 12,900,000,000 |
| Delivery reduction in this model | 99.98394% |
| Probe deliveries per receiver, mean / maximum | 40.08 / 68 |
| Subscriptions per relay / speculative serving cursors per probe | 2 / 0 |

The comparison assumes one selected responder in the hypothetical broadcast
workload too; extra broadcast respondents are excluded. It is not an old-protocol
timing benchmark. The model's 1,024 buckets differ from the SDK default of 64.
There are no 10k wallets, sockets, signatures, OPFS flushes, peak-RAM, nonce-budget,
relay billing or WAN measurements. Payload byte sizes and offers' availability
are not measured. [Raw report](benchmarks/recovery-routing-node.json).
