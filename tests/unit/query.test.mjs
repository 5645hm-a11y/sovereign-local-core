import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { BinaryProjection } from "../../dist/wasm-loader.js";
import { encodeCommands } from "../../dist/binary-command.js";
import { signEvent } from "../../dist/identity.js";
import { encryptFields, fieldsAAD } from "../../dist/project-crypto.js";
import { QueryCursorInvalidatedError, QueryPageTooLargeError } from "../../dist/query.js";
import { LocalCore } from "../../dist/engine.js";
import { ProjectContext } from "../../dist/project.js";
import { Device, alice, bob, projectId, store } from "../helpers/core-fixtures.mjs";
import { seedCursorCore } from "../helpers/sync-cursor-fixtures.mjs";

const command = (sequence, type, itemId, fields = {}, lamport = sequence, actorId = "actor_root") =>
  encodeCommands([{ id: `${actorId}:${sequence}`, actorId, sequence, lamport, type, itemId, fields }]);
function pages(native, options) {
  const out = []; let position;
  for (let i = 0; i < 1000; i++) { const page = native.queryPage(options, position); out.push(page); if (page.done) return out; position = page.next; }
  throw new Error("Query made no bounded progress");
}
const policy = { version: 1, defaultAllow: true, rules: [{ prefix: "asset_", create: ["Admin"], update: ["Admin"], delete: ["Admin"],
  checkout: ["Admin", "Member"], return: ["Admin", "Member"], ownerField: null, library: true }] };

test("native keyset pages match full views, bound bytes/count/scan and progress across hidden rows", async () => {
  const native = await BinaryProjection.create();
  try {
    const blocks = Array.from({ length: 900 }, (_, i) => command(i + 1, "ITEM_ADDED", `row_${String(i).padStart(4, "0")}`, { text: "x".repeat(100), unicode: "??\ud800", zero: -0 }));
    native.applyAll(blocks);
    native.applyAll(Array.from({ length: 600 }, (_, i) => command(1000 + i, "ITEM_DELETED", `row_${String(i).padStart(4, "0")}`)));
    native.apply(command(2000, "ITEM_UPDATED", "unborn", { hidden: "not visible" }));
    const cp = native.checkpoint(), whole = native.snapshot(2000);
    const out = pages(native, { kind: "items", prefix: "row_", limit: 19, maxBytes: 2048 });
    assert.equal(out[0].items.length, 0); assert.equal(out[0].done, false); assert.equal(out[0].scanned, 256);
    assert.deepEqual(out.flatMap(p => p.items), whole.items);
    for (const p of out) { assert.ok(p.items.length <= 19); assert.ok(p.encodedBytes <= 2048); assert.ok(p.scanned <= 256); }
    assert.deepEqual(pages(native, { kind: "items", prefix: "row_08" }).flatMap(p => p.items), whole.items.filter(i => i.id.startsWith("row_08")));
    assert.deepEqual(pages(native, { kind: "decisions" }).flatMap(p => p.decisions), []);
    assert.deepEqual(native.checkpoint(), cp, "reads must not mutate history");
  } finally { native.close(); }
});

test("paged decisions retain total order and change after late invariant winners, including restore", async () => {
  const native = await BinaryProjection.create(policy), restored = await BinaryProjection.create(policy);
  try {
    const initial = [command(1, "ITEM_ADDED", "asset_one", { title: "Resource" }),
      ...Array.from({ length: 300 }, (_, i) => command(i + 1, "CHECKOUT", "asset_one", { borrowerId: "borrower" }, i + 5, "actor_member"))];
    native.applyAuthorized(initial, initial.map((_, i) => i ? "Member" : "Admin"));
    native.applyAuthorized([command(1, "CHECKOUT", "asset_one", { borrowerId: "early" }, 2, "actor_early")], ["Member"]);
    const whole = native.snapshot(400), out = pages(native, { kind: "decisions", limit: 23, maxBytes: 2048 });
    assert.deepEqual(out.flatMap(p => p.decisions), whole.decisions);
    assert.equal(out[0].decisions[0].eventId, "actor_early:1");
    assert.equal(out[0].decisions[1].status, "REJECTED_CONFLICT");
    restored.restore(native.checkpoint()); assert.deepEqual(pages(restored, { kind: "decisions" }).flatMap(p => p.decisions), whole.decisions);
    assert.deepEqual(pages(native, { kind: "items" }).flatMap(p => p.items), whole.items);
  } finally { native.close(); restored.close(); }
});

test("oversized records fail explicitly without a partial page or native mutation", async () => {
  const native = await BinaryProjection.create();
  try {
    native.apply(command(1, "ITEM_ADDED", "large", { body: "z".repeat(10000) })); const cp = native.checkpoint();
    assert.throws(() => native.queryPage({ kind: "items", maxBytes: 1024 }), QueryPageTooLargeError);
    assert.equal(native.queryPage({ kind: "items", maxBytes: 32768 }).items[0].fields.body.length, 10000);
    assert.deepEqual(native.checkpoint(), cp);
    for (const options of [{ kind: "items", limit: 129 }, { kind: "items", prefix: "a/b" }, { kind: "decisions", prefix: "row_" }, { kind: "items", maxBytes: 1048577 }]) assert.throws(() => native.queryPage(options));
  } finally { native.close(); }
});

test("durable receipt path skips full snapshots, retries preserve revision, and legacy snapshots remain exact", async () => {
  const original = BinaryProjection.prototype.snapshot; let snapshots = 0;
  BinaryProjection.prototype.snapshot = function (...args) { snapshots++; return original.apply(this, args); };
  const f = await seedCursorCore(50, 128); let remote;
  try {
    assert.equal(snapshots, 0, "open core does not decode a whole view");
    const receipt = await f.core.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_1", fields: { text: "delta" } });
    assert.equal(receipt.revision, 51); assert.equal("snapshot" in receipt, false); assert.equal(snapshots, 0);
    const cursor = await f.core.openQueryCursor({ kind: "items", prefix: "record_1", limit: 3, maxBytes: 2048 });
    assert.equal((await f.core.readQueryCursor(cursor.id)).items[0].fields.text, "delta"); assert.equal(snapshots, 0);
    const retry = await f.core.ingestCommitted([receipt.event]); assert.equal(retry.applied, 0); assert.equal(retry.revision, 51);
    const invitation = await f.core.getBootstrapInvitation();
    const context = await ProjectContext.open(invitation, alice, projectId);
    remote = await LocalCore.open(await store(new Device()), alice, context);
    const imported = await remote.ingestCommitted([receipt.event]); assert.equal(imported.applied, 1); assert.equal(snapshots, 0);
    assert.equal((await remote.snapshot()).items.length, 0, "update does not resurrect missing row");
    const legacy = await f.core.dispatch({ type: "ITEM_UPDATED", itemId: "record_2", fields: { text: "legacy" } });
    assert.equal(legacy.snapshot.items.find(i => i.id === "record_1").fields.text, "delta");
    const before = snapshots; assert.equal(await f.core.snapshot(), legacy.snapshot); assert.equal(snapshots, before);
    await f.core.close();
    const reopened = await LocalCore.open(await store(f.device), alice, await ProjectContext.open(invitation, alice, projectId));
    try { assert.equal((await reopened.snapshot()).items.find(i => i.id === "record_1").fields.text, "delta"); } finally { await reopened.close(); }
  } finally { BinaryProjection.prototype.snapshot = original; await f.core.close(); await remote?.close(); }
});

test("query cursor revisions, quotas, expiry and failed writes have explicit cleanup contracts", async () => {
  const f = await seedCursorCore(8, 32, { syncCursorIdleTimeoutMs: 100 });
  try {
    const c = await f.core.openQueryCursor({ kind: "items", limit: 1 });
    await f.core.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_1", fields: { changed: true } });
    await assert.rejects(f.core.readQueryCursor(c.id), QueryCursorInvalidatedError);
    const stable = await f.core.openQueryCursor({ kind: "items", limit: 1 });
    const receipt = await f.core.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_2", fields: { changed: true } });
    const retryCursor = await f.core.openQueryCursor({ kind: "items", limit: 1 });
    await f.core.ingestCommitted([receipt.event]); assert.equal((await f.core.readQueryCursor(retryCursor.id)).items.length, 1);
    await f.core.closeQueryCursor(stable.id); await assert.rejects(f.core.readQueryCursor(stable.id), /Unknown/);
    const handles = [retryCursor]; for (let i = 0; i < 31; i++) handles.push(await f.core.openQueryCursor({ kind: "items" }));
    await assert.rejects(f.core.openQueryCursor({ kind: "items" }), /capacity/);
    for (const h of handles) await f.core.closeQueryCursor(h.id);
    const expiring = await f.core.openQueryCursor({ kind: "items" }); await pause(130); await assert.rejects(f.core.readQueryCursor(expiring.id), /expired/);
    const failed = await f.core.openQueryCursor({ kind: "items" }); f.device.flushFailure = true;
    await assert.rejects(f.core.dispatchCommitted({ type: "ITEM_ADDED", itemId: "bad", fields: {} }), /flush/);
    await assert.rejects(f.core.readQueryCursor(failed.id), /faulted/);
  } finally { await f.core.close(); }
});


test("compact local and remote paths enforce cryptographic roles before append and keep denied cursors valid", async () => {
  const rootContext = await ProjectContext.create(alice, projectId, policy), initial = await rootContext.evaluate([]);
  const invitation = await rootContext.invite(bob.actorId, "Member", 0, initial);
  const rootDevice = new Device(), memberDevice = new Device();
  const root = await LocalCore.open(await store(rootDevice), alice, rootContext);
  const member = await LocalCore.open(await store(memberDevice, bob), bob, await ProjectContext.open(invitation, bob, projectId));
  try {
    const added = await root.dispatchCommitted({ type: "ITEM_ADDED", itemId: "asset_one", fields: { title: "Shared resource" } });
    await member.ingestCommitted([added.event]); const memberBefore = memberDevice.durable.slice();
    await assert.rejects(member.dispatchCommitted({ type: "ITEM_DELETED", itemId: "asset_one" }), /policy/i);
    assert.deepEqual(memberDevice.durable, memberBefore);
    const cursor = await root.openQueryCursor({ kind: "items" }), rootBefore = rootDevice.durable.slice();
    const key = initial.keys.get(initial.currentKeyId), metadata = { schemaVersion: 3, projectId, actorId: bob.actorId,
      id: `${bob.actorId}:1`, sequence: 1, lamport: 3, certificate: invitation.certificate };
    const denied = await signEvent({ ...metadata, type: "ITEM_DELETED", itemId: "asset_one", keyId: key.id,
      encryptedFields: await encryptFields({}, fieldsAAD(metadata, "ITEM_DELETED", "asset_one", key.id), key) }, bob);
    await assert.rejects(root.ingestCommitted([denied]), /policy/i); assert.deepEqual(rootDevice.durable, rootBefore);
    assert.equal((await root.readQueryCursor(cursor.id)).items[0].id, "asset_one");
    const checkout = await member.dispatchCommitted({ type: "CHECKOUT", itemId: "asset_one", fields: { borrowerId: "authorized" } });
    await root.ingestCommitted([checkout.event]);
    const decisions = await root.openQueryCursor({ kind: "decisions" }); assert.equal((await root.readQueryCursor(decisions.id)).decisions[0].status, "ACCEPTED");
  } finally { await root.close(); await member.close(); }
});
