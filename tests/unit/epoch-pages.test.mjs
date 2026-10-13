import test from "node:test";
import assert from "node:assert/strict";
import { alice, bob, Device, projectId, store } from "../helpers/core-fixtures.mjs";
import { epochFixture } from "../helpers/epoch-fixtures.mjs";
import { buildEpochPages, verifyEpochPage, MAX_EPOCH_PAGE_BYTES, normalizeEpochCommitment } from "../../dist/epoch-pages.js";
import { encodeWire, decodeWire } from "../../dist/binary-events.js";
import { toBase64Url } from "../../dist/crypto-codec.js";
import { signEvent, verifySignature } from "../../dist/identity.js";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { encryptFields, fieldsAAD, generateProjectKey, wrapProjectKey } from "../../dist/project-crypto.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { LocalEventStore } from "../../dist/local-store.js";

test("10k synthetic envelope/witness records produce bounded pages and project/index/entry-bound inclusion proofs", async () => {
  const f = await epochFixture();
  try {
    const envelope = f.rootInvitation.keys[0], keys = [], history = [];
    // Synthetic routing IDs/envelopes, not 10k valid wallets or decryptable grants.
    for (let i = 1; i <= 10000; i++) {
      const point = new Uint8Array(65); point[0] = 4; new DataView(point.buffer).setUint32(61, i);
      const actor = `p256_${toBase64Url(point)}`;
      keys.push({ ...envelope, recipient: actor }); history.push({ id: `${actor}:1`, digest: "A".repeat(43) });
    }
    const plan = await buildEpochPages(projectId, envelope.keyId, bob.actorId, `epoch_${"A".repeat(43)}`, keys, history);
    assert.equal(plan.pages.length, 158); assert.equal(plan.commitment.keyCount, 10000);
    assert.equal(plan.commitment.historyCount, 10000);
    for (const p of plan.pages) {
      assert.ok(p.entries.length <= 128); assert.ok(encodeWire(p).length <= MAX_EPOCH_PAGE_BYTES);
      assert.equal(p.proof.length, 7); await verifyEpochPage(projectId, p);
      await verifyEpochPage(projectId, decodeWire(encodeWire(p)));
    }
    const p = plan.pages[0];
    await assert.rejects(verifyEpochPage("foreign-project", p), /proof/);
    await assert.rejects(verifyEpochPage(projectId, { ...p, index: 1 }), /proof/);
    await assert.rejects(verifyEpochPage(projectId, { ...p, entries: p.entries.map((e, i) => i ? e : { ...e, salt: "A".repeat(43) }) }), /proof/);
    await assert.rejects(buildEpochPages(projectId, envelope.keyId, bob.actorId, `epoch_${"A".repeat(43)}`, [keys[0], keys[0]], []), /Duplicate/);
    assert.throws(() => normalizeEpochCommitment({ ...plan.commitment, keyCount: 65537 }), /bounds/);
  } finally { await f.close(); }
});

test("manifest-first revocation is immediate; partial pages survive restart without key fallback, then witnessed history and future data recover", async () => {
  const f = await epochFixture();
  try {
    const witnessed = (await f.b.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { text: "witnessed" } })).event;
    await f.a.ingestEvents([witnessed]);
    const late = (await f.b.dispatch({ type: "ITEM_ADDED", itemId: "unwitnessed", fields: { text: "offline" } })).event;
    const revoked = await f.a.revokeMember(bob.actorId, { paged: true });
    const pages = (await f.a.readEvents()).filter(e => e.type === "KEY_EPOCH_PAGE");
    assert.equal(revoked.pageCount, 2); assert.equal(revoked.event.schemaVersion, 4);
    assert.ok(pages.every(e => e.schemaVersion === 4)); assert.ok(await verifySignature(revoked.event));
    const future = (await f.a.dispatch({ type: "ITEM_ADDED", itemId: "future", fields: { text: "rotated" } })).event;
    await f.c.ingestEvents([revoked.event]);
    assert.equal((await f.c.getProjectInfo()).pendingEpochs.length, 1);
    await assert.rejects(f.c.dispatch({ type: "ITEM_ADDED", itemId: "fallback", fields: {} }), { name: "EpochIncompleteError" });
    await assert.rejects(f.c.ingestEvents([late]), /revoked/);
    await assert.rejects(f.c.ingestEvents([future]), { name: "EpochIncompleteError" });
    await f.c.ingestEvents(pages.filter(e => e.epochPage.kind === "keys"));
    const before = (await f.c.getProjectInfo()).pendingEpochs;
    assert.deepEqual([before[0].missingKeyPages, before[0].missingHistoryPages], [0, 1]);
    await f.reopenReader();
    assert.deepEqual((await f.c.getProjectInfo()).pendingEpochs, before);
    await assert.rejects(f.c.getDiscoveryInfo(), { name: "EpochIncompleteError" });
    await f.c.ingestEvents(pages.filter(e => e.epochPage.kind === "history"));
    assert.deepEqual((await f.c.getProjectInfo()).pendingEpochs, []);
    await f.c.ingestEvents([witnessed, future]);
    assert.deepEqual((await f.c.snapshot()).items, (await f.a.snapshot()).items);
    await f.b.ingestEvents([...pages, revoked.event]);
    await assert.rejects(f.b.dispatch({ type: "ITEM_ADDED", itemId: "revoked", fields: {} }), /current project key/);
    assert.ok(pages.filter(e => e.epochPage.kind === "keys").every(e => e.epochPage.entries.every(k => k.recipient !== bob.actorId)));
  } finally { await f.close(); }
});

test("prepared pages preserve existing native rows and incomplete preparation never switches epochs", async () => {
  const f = await epochFixture();
  try {
    await f.a.dispatch({ type: "ITEM_ADDED", itemId: "retained", fields: { text: "keep" } });
    await f.c.ingestEvents(await f.a.readEvents());
    const before = (await f.c.getProjectInfo()).currentKeyId;
    const result = await f.a.revokeMember(bob.actorId, { paged: true });
    const pages = (await f.a.readEvents()).filter(e => e.type === "KEY_EPOCH_PAGE");
    assert.equal(pages.length, 1);
    await f.c.ingestEvents(pages); await f.c.ingestEvents(pages);
    assert.equal((await f.c.getProjectInfo()).currentKeyId, before);
    assert.equal((await f.c.snapshot()).items[0].fields.text, "keep");
    await f.reopenReader(); assert.equal((await f.c.getProjectInfo()).currentKeyId, before);
    await f.c.dispatch({ type: "ITEM_ADDED", itemId: "old-epoch-write", fields: {} });
    await f.c.ingestEvents([result.event]); assert.notEqual((await f.c.getProjectInfo()).currentKeyId, before);
    assert.equal((await f.c.snapshot()).items.find(i => i.id === "retained").fields.text, "keep");
  } finally { await f.close(); }
});

test("new-key invitations and bootstrap cannot bypass an incomplete signed epoch", async () => {
  const f = await epochFixture(); let context;
  try {
    const old = (await f.b.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { text: "witness" } })).event;
    await f.a.ingestEvents([old]);
    const rev = await f.a.revokeMember(bob.actorId, { paged: true });
    const pages = (await f.a.readEvents()).filter(e => e.type === "KEY_EPOCH_PAGE");
    const grant = await f.a.inviteMember(f.readerIdentity.actorId);
    const future = (await f.a.dispatch({ type: "ITEM_ADDED", itemId: "new", fields: {} })).event;
    await f.c.ingestEvents([rev.event, grant.event]);
    await assert.rejects(f.c.ingestEvents([future]), { name: "EpochIncompleteError" });
    await assert.rejects(f.c.ingestEvents([grant.event, future]), { name: "EpochIncompleteError" });
    context = await ProjectContext.open(grant.invitation, f.readerIdentity, projectId);
    const pending = await context.evaluateBinary([rev.event, grant.event]);
    assert.equal(pending.keys.has(rev.event.revocation.keyId), false);
    await assert.rejects(context.extend(pending, [future]), { name: "EpochIncompleteError" });
    await assert.rejects(context.evaluateBinary([rev.event, grant.event, future]), { name: "EpochIncompleteError" });
    await f.c.ingestEvents(pages); await f.c.ingestEvents([old, future]);
    assert.equal((await f.c.getProjectInfo()).pendingEpochs.length, 0);
    assert.equal((await f.c.snapshot()).items.find(i => i.id === "new").id, "new");
  } finally { context?.close(); await f.close(); }
});

test("valid signatures cannot authorize Member pages, altered Merkle paths, manifest substitution or duplicated slots", async () => {
  const f = await epochFixture();
  try {
    const rev = await f.a.revokeMember(bob.actorId, { paged: true });
    const page = (await f.a.readEvents()).find(e => e.type === "KEY_EPOCH_PAGE");
    const sign = async (value, identity = alice) => { const { signature, ...unsigned } = value; return signEvent(unsigned, identity); };
    const hostile = await sign({ ...page, actorId: bob.actorId, certificate: (await f.b.getProjectInfo()).certificate,
      sequence: 1, id: `${bob.actorId}:1` }, bob);
    assert.ok(await verifySignature(hostile));
    const before = f.devices[2].durable.slice();
    await assert.rejects(f.c.ingestEvents([hostile]), /pinned root/);
    const bad = await sign({ ...page, epochPage: { ...page.epochPage, commitment: { ...page.epochPage.commitment, keyRoot: "A".repeat(43) } } });
    assert.ok(await verifySignature(bad)); await assert.rejects(f.c.ingestEvents([bad]), /proof/);
    assert.deepEqual(f.devices[2].durable, before);
    await f.c.ingestEvents([page]);
    const duplicate = await sign({ ...page, sequence: page.sequence - 1, id: `${alice.actorId}:${page.sequence - 1}` });
    // Sequence is already occupied by an invitation: authenticated equivocation also fails.
    await assert.rejects(f.c.ingestEvents([duplicate]), /Conflicting|Duplicate/);
    const mismatch = await sign({ ...rev.event, revocation: { ...rev.event.revocation, epoch: { ...rev.event.revocation.epoch, keyRoot: "A".repeat(43) } } });
    await assert.rejects(f.c.ingestEvents([mismatch]), /match root manifest/);
    assert.equal((await f.c.getProjectInfo()).currentKeyId, f.readerInvitation.currentKeyId);
    await assert.rejects(f.c.revokeMember(bob.actorId, { paged: true }), /Only project root/);
  } finally { await f.close(); }
});

test("cursor catch-up sends prepared controls before data and completes a paged rotation for a late replica", async () => {
  const f = await epochFixture();
  try {
    const old = (await f.b.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { text: "retained" } })).event;
    await f.a.ingestEvents([old]); await f.a.revokeMember(bob.actorId, { paged: true });
    await f.a.dispatch({ type: "ITEM_ADDED", itemId: "new", fields: {} });
    const cursor = await f.a.openSyncCursor(await f.c.getSyncSummary()); let seenData = false, count = 0;
    do {
      const page = await f.a.readSyncCursor(cursor.id); count++;
      for (const e of page.events) { if (e.type.startsWith("ITEM_")) seenData = true; else assert.equal(seenData, false); }
      await f.c.ingestEvents(page.events); if (page.done) break;
    } while (true);
    assert.ok(count >= 2); assert.deepEqual((await f.c.snapshot()).items, (await f.a.snapshot()).items);
    assert.deepEqual((await f.c.getProjectInfo()).pendingEpochs, []);
  } finally { await f.close(); }
});

test("4097 genuine witnessed events automatically choose bounded schema-4 pages instead of an oversized revocation", async () => {
  const context = await ProjectContext.create(alice, projectId), initial = await context.evaluate([]);
  const invitation = await context.invite(bob.actorId, "Member", 1, initial), key = initial.keys.get(initial.currentKeyId);
  const events = [await signEvent({ schemaVersion: 3, projectId, actorId: alice.actorId, sequence: 1, lamport: 1,
    id: `${alice.actorId}:1`, certificate: context.certificate, type: "MEMBER_INVITED", invitation }, alice)];
  for (let offset = 0; offset < 4097; offset += 32) events.push(...await Promise.all(Array.from({ length: Math.min(32, 4097 - offset) }, async (_, i) => {
    const sequence = offset + i + 1, metadata = { schemaVersion: 3, projectId, actorId: bob.actorId, sequence, lamport: sequence + 1,
      id: `${bob.actorId}:${sequence}`, certificate: invitation.certificate };
    return signEvent({ ...metadata, type: "ITEM_ADDED", itemId: "history", keyId: key.id,
      encryptedFields: await encryptFields({ revision: sequence }, fieldsAAD(metadata, "ITEM_ADDED", "history", key.id), key) }, bob);
  })));
  // In-memory adapter avoids quadratic file-copy overhead; every signature/command is real.
  const appended = [], adapter = { actorId: alice.actorId, projectId, recovery: { eventCount: events.length, discardedTailBytes: 0 },
    readEvents: async () => [...events, ...appended], async append(event) { assert.ok(encodeWire(event).length < 1048576); appended.push(event); return { appended: true }; }, async close() {} };
  const core = await LocalCore.open(adapter, alice, context);
  try {
    const result = await core.revokeMember(bob.actorId);
    assert.equal(result.pageCount, 34); assert.equal(result.event.schemaVersion, 4);
    assert.equal(result.event.revocation.epoch.historyCount, 4097);
    assert.equal(appended.filter(e => e.type === "KEY_EPOCH_PAGE").length, 34);
    assert.equal(result.snapshot.items[0].fields.revision, 4097);
  } finally { await core.close(); }
});

test("owner-signed checkpoints restore partial and complete epoch proofs, including later witness eligibility", async () => {
  const f = await epochFixture(), devices = [new Device(), new Device(), new Device()]; let reader;
  const open = async () => {
    const context = await ProjectContext.open(f.readerInvitation, f.readerIdentity, projectId);
    const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], context);
    const store = await LocalEventStore.open(devices[0].open(), { actorId: f.readerIdentity.actorId, projectId }, () => {}, undefined, journal);
    return LocalCore.open(store, f.readerIdentity, context, { checkpointInterval: 1 });
  };
  try {
    const old = (await f.b.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { text: "checkpoint witness" } })).event;
    await f.a.ingestEvents([old]);
    const rev = await f.a.revokeMember(bob.actorId, { paged: true }), pages = (await f.a.readEvents()).filter(e => e.type === "KEY_EPOCH_PAGE");
    reader = await open(); await reader.ingestEvents([rev.event]);
    await reader.ingestEvents(pages.filter(e => e.epochPage.kind === "keys")); await reader.close(); reader = await open();
    assert.ok(reader.recovery.checkpointEvents > 0); assert.equal((await reader.getProjectInfo()).pendingEpochs[0].missingHistoryPages, 1);
    await assert.rejects(reader.dispatch({ type: "ITEM_ADDED", itemId: "unsafe", fields: {} }), { name: "EpochIncompleteError" });
    await reader.ingestEvents(pages.filter(e => e.epochPage.kind === "history")); await reader.close(); reader = await open();
    assert.deepEqual((await reader.getProjectInfo()).pendingEpochs, []);
    await reader.ingestEvents([old]); assert.equal((await reader.snapshot()).items[0].fields.text, "checkpoint witness");
    await reader.close(); reader = await open(); assert.equal((await reader.snapshot()).items[0].fields.text, "checkpoint witness");
    assert.equal(reader.checkpointStatus.lastError, undefined);
  } finally { await reader?.close(); await f.close(); }
});

test("a root crash after flushed preparation pages leaves the previous epoch writable on recovery", async () => {
  const f = await epochFixture(); let root;
  try {
    await f.a.dispatch({ type: "ITEM_ADDED", itemId: "preparation-row", fields: { intact: true } });
    const before = (await f.a.getProjectInfo()).currentKeyId;
    // One key page, then the final manifest. Fail the second flush.
    const device = f.devices[0];
    // Existing handle's flush closure consults device.flushFailure dynamically.
    const off = f.a.onCommit(n => { if (n.event.type === "KEY_EPOCH_PAGE") device.flushFailure = true; });
    await assert.rejects(f.a.revokeMember(bob.actorId, { paged: true }), /flush/); off();
    await f.a.close(); device.flushFailure = false;
    const context = await ProjectContext.open(f.rootInvitation, alice, projectId);
    root = await LocalCore.open(await store(device), alice, context);
    assert.equal((await root.getProjectInfo()).currentKeyId, before);
    assert.deepEqual((await root.getProjectInfo()).pendingEpochs, []);
    assert.equal((await root.snapshot()).items[0].fields.intact, true);
    await root.dispatch({ type: "ITEM_ADDED", itemId: "post-crash", fields: {} });
    const retry = await root.revokeMember(bob.actorId, { paged: true });
    assert.equal(retry.event.schemaVersion, 4); assert.notEqual((await root.getProjectInfo()).currentKeyId, before);
    assert.equal((await root.snapshot()).items.find(i => i.id === "preparation-row").fields.intact, true);
  } finally { await root?.close(); await f.close(); }
});

test("duplicate slots with distinct signed IDs and complete plans without a root recipient fail closed", async () => {
  const f = await epochFixture();
  try {
    const result = await f.a.revokeMember(bob.actorId, { paged: true });
    const original = (await f.a.readEvents()).find(e => e.type === "KEY_EPOCH_PAGE");
    const { signature, ...unsigned } = original;
    const page = original;
    await f.c.ingestEvents([page]);
    const duplicate = await signEvent({ ...unsigned, sequence: 4, lamport: page.lamport + 1, id: `${alice.actorId}:4`,
      epochPage: page.epochPage }, alice);
    await assert.rejects(f.c.ingestEvents([duplicate]), /Duplicate epoch page slot/);
    const readerKey = original.epochPage.entries.find(k => k.recipient === f.readerIdentity.actorId);
    const plan = await buildEpochPages(projectId, readerKey.keyId, bob.actorId, `epoch_${toBase64Url(new Uint8Array(32).fill(2))}`, [readerKey], []);
    const orphan = await signEvent({ ...unsigned, sequence: 6, lamport: 6, id: `${alice.actorId}:6`, epochPage: plan.pages[0] }, alice);
    await f.c.ingestEvents([orphan]);
    const { signature: sig, ...rev } = result.event;
    const manifest = await signEvent({ ...rev, sequence: 7, lamport: 7, id: `${alice.actorId}:7`,
      revocation: { ...rev.revocation, epoch: plan.commitment } }, alice);
    await assert.rejects(f.c.ingestEvents([manifest]), /omits root/);
  } finally { await f.close(); }
});

test("even root-signed preparation rejects key envelopes for a target Admin's delegated descendants", async () => {
  const f = await epochFixture({ delegatedReader: true }), key = await generateProjectKey();
  try {
    const envelopes = await Promise.all([alice.actorId, f.readerIdentity.actorId].map(id => wrapProjectKey(key, projectId, id)));
    const plan = await buildEpochPages(projectId, key.id, bob.actorId, `epoch_${toBase64Url(new Uint8Array(32).fill(3))}`, envelopes, []);
    const page = await signEvent({ schemaVersion: 4, projectId, actorId: alice.actorId, certificate: f.project.certificate,
      sequence: 2, lamport: 3, id: `${alice.actorId}:2`, type: "KEY_EPOCH_PAGE", epochPage: plan.pages[0] }, alice);
    assert.ok(await verifySignature(page)); const before = f.devices[2].durable.slice();
    await assert.rejects(f.c.ingestEvents([page]), /leaks key to revoked delegation/);
    assert.deepEqual(f.devices[2].durable, before);
  } finally { key.bytes.fill(0); await f.close(); }
});
