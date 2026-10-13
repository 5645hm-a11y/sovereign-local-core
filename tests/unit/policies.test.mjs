import test from "node:test";
import assert from "node:assert/strict";
import { createWalletVault, unlockWalletVault, unlockIdentityVault, signEvent } from "../../dist/identity.js";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { BinaryProjection } from "../../dist/wasm-loader.js";
import { libraryPolicies } from "../../dist/policies.js";
import { encodeCommands } from "../../dist/binary-command.js";
import { encryptFields, fieldsAAD } from "../../dist/project-crypto.js";
import { Device, alice, bob, projectId, store, permutations } from "../helpers/core-fixtures.mjs";
import { LWWMerge } from "../../dist/crdt.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { SyncSession } from "../../dist/sync-session.js";
import { setTimeout as pause } from "node:timers/promises";

async function group(policies = libraryPolicies()) {
  const root = await ProjectContext.create(alice, projectId, policies), initial = await root.evaluate([]);
  const invitation = await root.invite(bob.actorId, "Kiosk", 0, initial);
  const kiosk = await ProjectContext.open(invitation, bob, projectId);
  const member = await ProjectContext.open(await root.invite(bob.actorId, "Member", 0, initial), bob, projectId);
  const make = async (context, sequence, type, fields = {}, lamport = sequence, itemId = "book_1") => {
    const key = initial.keys.get(initial.currentKeyId), identity = context.identity;
    const metadata = { schemaVersion: 3, projectId, id: `${identity.actorId}:${sequence}`, actorId: identity.actorId,
      sequence, lamport, certificate: context.certificate };
    return signEvent({ ...metadata, type, itemId, keyId: key.id,
      encryptedFields: await encryptFields(fields, fieldsAAD(metadata, type, itemId, key.id), key) }, identity);
  };
  return { root, kiosk, member, make };
}
async function open(device, context) { return LocalCore.open(await store(device, context.identity), context.identity, context); }

test("sovereign wallets need no email; keys are random, encrypted and non-extractable after unlock", async () => {
  const a = await createWalletVault("kiosk_A", "wallet-secret-passphrase"), b = await createWalletVault("kiosk_A", "wallet-secret-passphrase");
  assert.notEqual(a.identity.actorId, b.identity.actorId);
  const unlocked = await unlockWalletVault(a.vault, "kiosk_A", "wallet-secret-passphrase");
  assert.equal(unlocked.actorId, a.identity.actorId); assert.equal(unlocked.privateKey.extractable, false);
  await assert.rejects(unlockWalletVault(a.vault, "kiosk_B", "wallet-secret-passphrase"));
  await assert.rejects(unlockIdentityVault(a.vault, "wallet@example.test", "wallet-secret-passphrase"));
  assert.ok(!JSON.stringify(a.vault).includes(a.identity.actorId));
});

test("root-signed immutable policies cannot be altered or downgraded in an invitation", async () => {
  const { root, kiosk } = await group();
  assert.equal(root.descriptor.version, 2); assert.equal(kiosk.certificate.role, "Kiosk");
  const descriptor = { ...kiosk.descriptor, policies: { ...kiosk.descriptor.policies, defaultAllow: true } };
  await assert.rejects(ProjectContext.open({ ...kiosk.invitation, descriptor }, bob, projectId));
  const { policies, ...downgraded } = kiosk.descriptor;
  await assert.rejects(ProjectContext.open({ ...kiosk.invitation, descriptor: { ...downgraded, version: 1 } }, bob, projectId));
  const forged = { ...kiosk.invitation, certificate: { ...kiosk.certificate, role: "Admin" } };
  await assert.rejects(ProjectContext.open(forged, bob, projectId));
});

test("native RLS denies a correctly signed Member deletion before append and leaves the writer usable", async () => {
  const { root, member, make } = await group(), core = await open(new Device(), root);
  try {
    await core.dispatch({ type: "ITEM_ADDED", itemId: "book_1", fields: { title: "Encrypted book" } });
    const prior = await core.readEvents(), denied = await make(member, 1, "ITEM_DELETED", {}, 2);
    await assert.rejects(core.ingestEvents([denied]), e => e.name === "NativeMergeError" && e.status === 3);
    assert.equal((await core.readEvents()).length, prior.length); assert.equal((await core.snapshot()).items.length, 1);
    const memberCore = await open(new Device(), member);
    try { await assert.rejects(memberCore.dispatch({ type: "ITEM_DELETED", itemId: "book_1" }), e => e.status === 3); assert.equal((await memberCore.readEvents()).length, 0); }
    finally { await memberCore.close(); }
    await core.dispatch({ type: "ITEM_DELETED", itemId: "book_1" });
    assert.equal((await core.snapshot()).items.length, 0);
  } finally { await core.close(); }
});

test("double checkout converges for every ordering and duplicate delivery; late winners replace provisional winners", async () => {
  const { root, kiosk, make } = await group();
  const add = await make(root, 1, "ITEM_ADDED", { title: "One physical copy" });
  const left = await make(root, 2, "CHECKOUT", { borrowerId: "reader_A" }, 10);
  const right = await make(kiosk, 1, "CHECKOUT", { borrowerId: "reader_B" }, 10);
  const winner = alice.actorId < bob.actorId ? left : right, loser = winner === left ? right : left;
  let expected;
  for (const order of permutations([add, left, right])) {
    const snapshot = await new LWWMerge(root).materialize([...order, right, left]);
    assert.equal(snapshot.items[0].fields.loanId, winner.id);
    assert.equal(snapshot.decisions.find(d => d.eventId === loser.id).status, "REJECTED_CONFLICT");
    assert.equal(snapshot.decisions.find(d => d.eventId === winner.id).status, "ACCEPTED");
    expected ??= snapshot; assert.deepEqual(snapshot, expected);
  }
  const core = await open(new Device(), root);
  try {
    await core.ingestEvents([add, loser]); assert.equal((await core.snapshot()).items[0].fields.loanId, loser.id);
    await core.ingestEvents([winner]); assert.deepEqual(await core.snapshot(), expected);
    assert.equal((await core.readEvents()).length, 3);
  } finally { await core.close(); }
});

test("late earlier checkout invalidates its stale return; exact-return semantics do not clear another loan", async () => {
  const { root, kiosk, make } = await group(), core = await open(new Device(), root);
  const add = await make(root, 1, "ITEM_ADDED", { title: "Book" });
  const late = await make(kiosk, 1, "CHECKOUT", { borrowerId: "late_reader" }, 5);
  const returned = await make(kiosk, 2, "RETURN", { checkoutId: late.id }, 6);
  const early = await make(root, 2, "CHECKOUT", { borrowerId: "early_reader" }, 4);
  try {
    await core.ingestEvents([add, late, returned]); assert.equal((await core.snapshot()).items[0].fields.loanId, null);
    await core.ingestEvents([early]);
    const snapshot = await core.snapshot(); assert.equal(snapshot.items[0].fields.loanId, early.id);
    assert.equal(snapshot.decisions.find(d => d.eventId === returned.id).status, "REJECTED_CONFLICT");
    await assert.rejects(core.ingestEvents([await make(root, 3, "ITEM_UPDATED", { loanId: null }, 7)]), e => e.status === 3);
    await core.ingestEvents([await make(root, 3, "ITEM_DELETED", {}, 7)]);
    assert.equal((await core.snapshot()).items.length, 1);
    await core.ingestEvents([await make(root, 4, "RETURN", { checkoutId: early.id }, 8)]);
    await core.ingestEvents([await make(root, 5, "ITEM_DELETED", {}, 9)]);
    assert.equal((await core.snapshot()).items.length, 0);
  } finally { await core.close(); }
});

test("owner policies use authenticated ActorIDs and longest prefix; role denial aborts an entire native batch", async () => {
  const all = ["Admin", "Member", "Kiosk"], rules = [{ prefix: "note_", create: all, update: all, delete: all,
    checkout: [], return: [], ownerField: "owner", library: false },
    { prefix: "note_secret_", create: ["Admin"], update: ["Admin"], delete: ["Admin"], checkout: [], return: [], ownerField: null, library: false }];
  const { root, member, make } = await group({ version: 1, defaultAllow: false, rules }), core = await open(new Device(), root);
  try {
    const add = await make(root, 1, "ITEM_ADDED", { owner: alice.actorId, text: "owned" }, 1, "note_1");
    await core.ingestEvents([add]);
    const edit = await make(member, 1, "ITEM_UPDATED", { text: "unauthorized owner" }, 2, "note_1");
    await core.ingestEvents([edit]);
    assert.equal((await core.snapshot()).items[0].fields.text, "owned");
    assert.equal((await core.snapshot()).decisions[0].status, "REJECTED_POLICY");
    const good = await make(root, 2, "ITEM_UPDATED", { text: "valid" }, 3, "note_1");
    const bad = await make(member, 2, "ITEM_DELETED", {}, 4, "note_secret_1");
    await assert.rejects(core.ingestEvents([good, bad]), e => e.status === 3);
    assert.equal((await core.readEvents()).length, 2); assert.equal((await core.snapshot()).items[0].fields.text, "owned");
  } finally { await core.close(); }
});

test("native checkpoints retain losing candidates and proofs; restore rejects policy mismatch and legacy bypass", async () => {
  const policy = libraryPolicies(), native = await BinaryProjection.create(policy), restored = await BinaryProjection.create(policy);
  const command = (actorId, sequence, lamport, type, fields) => encodeCommands([{ id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId: "book_1", ...(type === "ITEM_DELETED" ? {} : { fields }) }]);
  const add = command(alice.actorId, 1, 1, "ITEM_ADDED", { title: "Book" });
  const later = command(bob.actorId, 1, 8, "CHECKOUT", { borrowerId: "reader_B" });
  const early = command(alice.actorId, 2, 5, "CHECKOUT", { borrowerId: "reader_A" });
  let checkpoint;
  try {
    native.applyAuthorized([add, later], ["Admin", "Kiosk"]); checkpoint = native.checkpoint();
    restored.restore(checkpoint); restored.applyAuthorized([early], ["Admin"]);
    native.applyAuthorized([early], ["Admin"]); assert.deepEqual(native.snapshot(8), restored.snapshot(8));
    assert.equal(restored.snapshot(8).decisions.find(d => d.eventId === `${bob.actorId}:1`).status, "REJECTED_CONFLICT");
    await assert.rejects(async () => restored.apply(add), e => e.status === 1);
    const wrong = await BinaryProjection.create({ ...policy, defaultAllow: true });
    try { assert.throws(() => wrong.restore(checkpoint), e => e.status === 1); } finally { wrong.close(); }
    const legacy = await BinaryProjection.create();
    try { legacy.apply(add); const cp = legacy.checkpoint(); assert.throws(() => restored.restore(cp), e => e.status === 1); cp.fill(0); } finally { legacy.close(); }
    const snapshot = native.snapshot(8);
    assert.throws(() => native.applyAuthorized([command(alice.actorId, 3, 10, "ITEM_UPDATED", { title: "bad partial" }), command(bob.actorId, 2, 11, "ITEM_DELETED")], ["Admin", "Member"]), e => e.status === 3);
    assert.deepEqual(native.snapshot(8), snapshot);
  } finally { checkpoint?.fill(0); native.close(); restored.close(); }
});

test("native duplicate batches preserve checkpoints and reject changed payloads or roles atomically", async () => {
  const native = await BinaryProjection.create(libraryPolicies());
  const command = (sequence, lamport, type, fields) => encodeCommands([{ id: `${alice.actorId}:${sequence}`,
    actorId: alice.actorId, sequence, lamport, type, itemId: "book_1", fields }]);
  const add = command(1, 1, "ITEM_ADDED", { title: "Original" });
  const edit = command(2, 2, "ITEM_UPDATED", { title: "Valid edit" });
  const loan = command(3, 3, "CHECKOUT", { borrowerId: "reader_A" });
  let checkpoint;
  try {
    native.applyAuthorized([add, loan, loan], ["Admin", "Admin", "Admin"]);
    checkpoint = native.checkpoint();
    const snapshot = native.snapshot(3);
    native.applyAuthorized([loan, add, loan], ["Admin", "Admin", "Admin"]);
    assert.deepEqual(native.checkpoint(), checkpoint);
    assert.deepEqual(native.snapshot(3), snapshot);
    const changed = command(3, 3, "CHECKOUT", { borrowerId: "reader_B" });
    const changedClock = command(3, 4, "CHECKOUT", { borrowerId: "reader_A" });
    // New events preceding a conflicting duplicate must not leak into state/history.
    for (const [block, role] of [[changed, "Admin"], [changedClock, "Admin"], [loan, "Kiosk"]]) {
      assert.throws(() => native.applyAuthorized([edit, block], ["Admin", role]), e => e.status === 1);
      assert.deepEqual(native.checkpoint(), checkpoint);
      assert.deepEqual(native.snapshot(3), snapshot);
    }
    // Conflicting copies of a new identity in the same batch also abort atomically.
    assert.throws(() => native.applyAuthorized([edit, command(2, 2, "ITEM_UPDATED", { title: "Changed" })], ["Admin", "Admin"]), e => e.status === 1);
    assert.deepEqual(native.checkpoint(), checkpoint);
    native.applyAuthorized([loan, edit, edit], ["Admin", "Admin", "Admin"]);
    assert.equal(native.snapshot(3).items[0].fields.title, "Valid edit");
    assert.equal(native.snapshot(3).decisions.length, 1);
  } finally { checkpoint?.fill(0); native.close(); }
});

test("signed unauthorized policy events in a local log fail closed on recovery", async () => {
  const { root, member, make } = await group(), device = new Device();
  const log = await store(device); await log.append(await make(member, 1, "ITEM_DELETED")); await log.close();
  const original = device.durable.slice();
  await assert.rejects(open(device, root), e => e.status === 3);
  assert.deepEqual(device.durable, original);
});

test("encrypted Core checkpoints restore candidates, counters and a late earlier delta", async () => {
  const { root, kiosk, make } = await group(), devices = [new Device(), new Device(), new Device()];
  const openCheckpoint = async () => {
    const context = await ProjectContext.open(root.invitation, alice, projectId);
    const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], context);
    const log = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
    return LocalCore.open(log, alice, context, { checkpointInterval: 2 });
  };
  const add = await make(root, 1, "ITEM_ADDED", { title: "Checkpoint book" });
  const late = await make(kiosk, 1, "CHECKOUT", { borrowerId: "later" }, 8), early = await make(root, 2, "CHECKOUT", { borrowerId: "earlier" }, 5);
  let core = await openCheckpoint();
  try {
    await core.ingestEvents([add, late]); assert.equal(core.checkpointStatus.events, 2);
    await core.close(); core = await openCheckpoint(); assert.equal(core.recovery.checkpointEvents, 2); assert.equal(core.recovery.replayedEvents, 0);
    assert.equal((await core.snapshot()).items[0].fields.loanId, late.id);
    await core.ingestEvents([early]); const expected = await core.snapshot();
    assert.equal(expected.items[0].fields.loanId, early.id); await core.close(); core = await openCheckpoint();
    assert.equal(core.recovery.checkpointEvents, 2); assert.equal(core.recovery.replayedEvents, 1);
    assert.deepEqual(await core.snapshot(), expected);
    const next = await core.dispatch({ type: "RETURN", itemId: "book_1", fields: { checkoutId: early.id } });
    assert.equal(next.event.sequence, 3); assert.ok(next.event.lamport > 8); assert.equal(next.snapshot.items[0].fields.loanId, null);
  } finally { await core.close(); }
});

test("a sparse mesh forwards durable imported events across two hops without infinite echoes", async () => {
  const third = (await createWalletVault("courier_C", "synthetic-courier-passphrase")).identity;
  const root = await ProjectContext.create(alice, projectId), initial = await root.evaluate([]);
  const bp = await ProjectContext.open(await root.invite(bob.actorId, "Member", 0, initial), bob, projectId);
  const cp = await ProjectContext.open(await root.invite(third.actorId, "Member", 0, initial), third, projectId);
  const cores = await Promise.all([open(new Device(), root), open(new Device(), bp), open(new Device(), cp)]);
  const [a, b, c] = cores, sessions = [new SyncSession(a, { forwardRemote: true }), new SyncSession(b, { forwardRemote: true }), new SyncSession(b, { forwardRemote: true }), new SyncSession(c, { forwardRemote: true })];
  const wait = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await pause(10); } throw new Error("Sparse mesh timed out"); };
  const edge = (left, right) => {
    const lr = new TransformStream(), rl = new TransformStream();
    left.connect({ readable: rl.readable, writable: lr.writable, close() {} });
    right.connect({ readable: lr.readable, writable: rl.writable, close() {} });
  };
  try {
    edge(sessions[0], sessions[1]); edge(sessions[2], sessions[3]);
    await wait(() => sessions.every(s => s.state === "online"));
    await a.dispatch({ type: "ITEM_ADDED", itemId: "routed", fields: { text: "A via B to C" } });
    await wait(async () => (await c.snapshot()).items[0]?.fields.text === "A via B to C");
    await c.dispatch({ type: "ITEM_UPDATED", itemId: "routed", fields: { text: "C via B to A" } });
    await wait(async () => (await a.snapshot()).items[0]?.fields.text === "C via B to A");
    await pause(100);
    for (const core of cores) assert.equal((await core.readEvents()).length, 2);
    assert.deepEqual((await a.snapshot()).items, (await c.snapshot()).items);
    assert.ok(sessions.reduce((n, s) => n + s.stats.eventsSent, 0) <= 8);
  } finally { sessions.forEach(s => s.stop()); await Promise.all(cores.map(c => c.close())); }
});
