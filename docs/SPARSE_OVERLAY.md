# Bounded neighbor exploration (v0.3.0)

`P2PWebRTC` now separates authenticated presence hints from active connections.
It periodically explores a different neighbor when its edge budget is full.
The reducer, event format, discovery encryption and native ABI are unchanged.
The public v0.2.0 artifact does not include these options.

```ts
const sync = new P2PWebRTC(db, {
  discovery: new NostrDiscovery(),
  maxPeers: 8,
  topology: 'rotating', // default; 'fixed' retains legacy first-fit behavior
  maxCandidates: 256,
  candidateTtlMs: 120_000,
  rotationIntervalMs: 30_000,
  minPeerLifetimeMs: 30_000,
  rotationIdleMs: 5_000,
});
```

## Admission and lifetime

Only presence already authenticated by the Worker enters the candidate cache.
It retains at most one instance per signing actor, cannot change an instance's
signing actor, and does not replace a protected active identity with a second tab.
Expired inactive hints are removed; oldest inactive hints are evicted at capacity.
Candidate capacity must cover `maxPeers` and cannot exceed 4,096. Timers must be
finite and positive. Hints alone do not allocate a PeerConnection.
Use a capacity greater than `maxPeers` to retain additional exploration hints;
active protected hints alone can fill a cache configured equal to the edge cap.

Fresh eligible candidates are visited in lexical round-robin order within the
current bounded view. Empty slots can be filled on a hello/timer tick. Backoff and
one-edge-per-actor admission apply to both incoming and outgoing proposals.
Candidates may be missed if presence expires or the bounded view is overwhelmed.
Failed instances lose their hint and must advertise afresh before retry; cached
presence cannot repeatedly reserve an actor slot for a browser instance that
disappeared during reload. Backoff still applies to fresh advertisements.

When full, at most one eligible idle edge is replaced per rotation interval.
There must be at least two connected online edges at the decision point; one is
retained. The victim must have completed catch-up, survived the minimum lifetime,
and remained locally quiescent for the idle grace. No deliberate rotation occurs
with an outstanding durable ACK, partial frame/message, import, queued live send,
queued/active chunk pull or chunk response. A replaced edge enters cooldown.
With `maxPeers: 1`, full-capacity rotation is disabled; a connected global network
of more than two nodes cannot be assumed with a degree-one budget.

Local quiescence is advisory: a remote send can start immediately afterward.
Concurrent traffic/connection failure can interrupt a transfer; committed events
recover through the normal authenticated cursor catch-up, and file pulls can fail
and be retried. This is not an atomic agreement that both ends are idle.

Either instance may propose a challenge. If proposals cross before proof/SDP,
the lexically smaller instance wins. Established/proven sessions are never
replaced by a competing session ID. The same two fresh challenges, actor/session
binding, signature, expiry and replay rules still guard SDP/ICE. Presence retries
pending challenges/offers because relay acceptance does not prove delivery.
Retries are throttled to at most one proposal per second per edge (or the hello
interval if longer), avoiding a handshake flood from fast presence ticks.
The discovery packet schema is unchanged. Legacy smaller-initiator peers remain
compatible, but cannot participate in this exploration policy themselves.

`sync.candidateCount` reports retained hints; `sync.topologyStats` counts rotations
and crossed-proposal resolutions. `stop()` closes edges, clears hints/retry state
and stops discovery. `online` still describes at least one completed edge, not
global connectedness or a durable backup count.

## Evidence and limits

The browser fixture uses six distinct cryptographic wallets, real Workers/OPFS,
native WASM and real host-only WebRTC DataChannels. A local blind Nostr relay
initially separates two three-node groups, each saturated at two edges per node.
After discovery can cross groups, the test checks data convergence across all six,
then stops a peer and checks subsequent edits reach the remaining five. It tracks
the edge budget and verifies shutdown cleanup. This is a reachability test on one
machine, not a global internet/TURN benchmark or a proof under arbitrary churn.

Candidate tests cover 10,000 injected **presence hints**, capacity, active-identity
protection, expiry and stable-view fairness. They do not represent 10,000 running
authorized RTC replicas.

Exploration needs fresh authenticated cross-component discovery and achievable
RTC connections (TURN where necessary). Sustained writes/pulls can defer rotation
indefinitely. Deterministic exploration and oldest-entry eviction do not prevent
an authorized adversary from eclipsing a view or grinding identities. There is no
global topology consensus, random-walk peer gossip, guaranteed connected backbone,
or periodic anti-entropy on an unchanged edge yet. Legacy broadcast presence and the
Worker's 4,096-unexpired-nonce replay budget still limit large discovery swarms;
this change does not remove those bounds. With default 3-second presence and
roughly 90-second nonce retention, each continuously observed actor occupies
about 30 slots from hellos alone: roughly 130 broadcasting actors can already
approach the 4,096-slot budget, before directed negotiation traffic. This is a
protocol-budget estimate, not a measured capacity or a safe deployment threshold.
See [scale boundaries](SCALABILITY.md).

The newer opt-in [routed discovery](DISCOVERY_ROUTING.md) reduces presence fanout
and targets directed signaling to stable inboxes. The same six-wallet bridge,
failure and shutdown fixture now runs in legacy and routed modes. Replay bounds
remain unchanged; the presence-only synthetic routing model does not establish
large-member governance, a connected backbone or safe deployment capacity.
