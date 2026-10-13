import test from "node:test";
import assert from "node:assert/strict";
import { PeerCandidates } from "../../dist/peer-candidates.js";
import { P2PWebRTC } from "../../dist/p2p-webrtc.js";

test("candidate floods stay bounded, expire and cannot displace active identities", () => {
  const cache = new PeerCandidates(4, 100), protectedIds = new Set(["active"]);
  cache.observe("active", "alice", 0, protectedIds);
  cache.observe("other-tab", "alice", 10, protectedIds);
  cache.observe("active", "forged-actor", 20, protectedIds);
  for (let i = 0; i < 10000; i++) cache.observe(String(i), `actor-${i}`, 30, protectedIds);
  assert.equal(cache.size, 4);
  assert.deepEqual(cache.next(30, id => id === "active"), { id: "active", actor: "alice" });
  cache.prune(200, protectedIds); assert.equal(cache.size, 1);
  assert.equal(cache.next(200, () => true), null);
  cache.prune(200, new Set()); assert.equal(cache.size, 0);
});

test("candidate exploration is fair within a stable bounded view and skips cooldown/ineligible actors", () => {
  const cache = new PeerCandidates(8, 1000), none = new Set();
  for (const id of ["d", "a", "c", "b"]) cache.observe(id, `actor-${id}`, 0, none);
  assert.deepEqual(Array.from({ length: 6 }, () => cache.next(10, id => id !== "b")?.id), ["a", "c", "d", "a", "c", "d"]);
  cache.observe("new-a", "actor-a", 20, none);
  assert.equal(cache.size, 4);
  assert.equal(cache.next(20, id => id === "a"), null);
  cache.forget("new-a"); assert.equal(cache.next(20, id => id === "new-a"), null);
  cache.observe("new-a", "actor-a", 21, none);
  assert.deepEqual(cache.next(21, id => id === "new-a"), { id: "new-a", actor: "actor-a" });
  cache.clear(); assert.equal(cache.size, 0);
});

test("topology configuration rejects unbounded candidate counts and invalid timers", () => {
  const core = {}, discovery = {};
  for (const options of [{ maxCandidates: 4097 }, { maxCandidates: 1 }, { candidateTtlMs: NaN },
    { rotationIntervalMs: 0 }, { minPeerLifetimeMs: -1 }, { rotationIdleMs: Infinity }, { topology: "unbounded" }]) {
    assert.throws(() => new P2PWebRTC(core, { discovery, ...options }), TypeError);
  }
});
