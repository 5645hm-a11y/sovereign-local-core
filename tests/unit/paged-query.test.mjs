import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { PagedQueryStore } from "../../dist/paged-query.js";
import { QueryCursorInvalidatedError, QueryPageTooLargeError } from "../../dist/query.js";

async function wait(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(5); } throw new Error("Query state timed out"); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
class Client {
  active = new Map(); opened = 0; read = 0; closed = 0; revision = 1; beforeRead = null; beforeOpen = null; fail = null;
  rows = Array.from({ length: 9 }, (_, i) => ({ id: `row_${i}`, fields: { title: `Row ${i}` } }));
  async openQueryCursor(options) {
    const id = `cursor_${++this.opened}`; this.active.set(id, { options, offset: 0, revision: this.revision });
    await this.beforeOpen?.(); return { id, revision: this.revision };
  }
  async readQueryCursor(id) {
    this.read++; await this.beforeRead?.(); if (this.fail) throw this.fail;
    const c = this.active.get(id); if (!c) throw new Error("Unknown, completed or expired query cursor");
    if (c.revision !== this.revision) throw new QueryCursorInvalidatedError();
    const rows = this.rows.filter(i => i.id.startsWith(c.options.prefix)), items = rows.slice(c.offset, c.offset + c.options.limit);
    c.offset += items.length; const done = c.offset >= rows.length;
    if (done) this.active.delete(id);
    return { kind: c.options.kind, revision: this.revision, lamport: this.revision, items, decisions: [], done, scanned: items.length, encodedBytes: 128 };
  }
  async closeQueryCursor(id) { this.closed++; this.active.delete(id); }
}
class Source {
  constructor(client) { this.state = { status: client ? "ready" : "loading", client, error: null }; }
  listeners = new Set(); commits = new Set();
  getState = () => this.state;
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  subscribeCommits = fn => { this.commits.add(fn); return () => this.commits.delete(fn); };
  set(client, status = client ? "ready" : "closed", error = null) { this.state = { status, client, error }; for (const fn of this.listeners) fn(); }
  commit(itemId = "row_0", type = "ITEM_UPDATED") {
    this.state.client.revision++;
    for (const fn of this.commits) fn({ source: "remote", event: { type, itemId } });
  }
}
const options = { kind: "items", prefix: "row_", limit: 2, maxBytes: 2048 };

test("paged store is render-pure, owns one replaceable bounded page, and closes its cursor on unmount", async () => {
  const client = new Client(), source = new Source(client), store = new PagedQueryStore(source, options, 0);
  assert.equal(client.opened, 0); assert.equal(store.getSnapshot(), store.getServerSnapshot());
  const stop = store.subscribe(() => {});
  try {
    await wait(() => store.getSnapshot().page);
    assert.deepEqual(store.getSnapshot().page.items.map(i => i.id), ["row_0", "row_1"]);
    assert.equal(client.active.size, 1); const previous = store.getSnapshot().page;
    store.next(); await wait(() => store.getSnapshot().pageIndex === 1 && !store.getSnapshot().loading);
    assert.deepEqual(store.getSnapshot().page.items.map(i => i.id), ["row_2", "row_3"]);
    assert.equal(store.getSnapshot().page.items.length, 2); assert.equal(previous.items[0].id, "row_0");
    assert.ok(Object.isFrozen(store.getSnapshot().page.items[0].fields));
    store.next(); store.next(); await wait(() => store.getSnapshot().pageIndex === 2 && !store.getSnapshot().loading);
    assert.equal(client.opened, 1, "rapid next calls must not run overlapping reads");
  } finally { stop(); }
  await wait(() => client.active.size === 0); assert.equal(source.commits.size, 0); assert.equal(source.listeners.size, 0);
});

test("unrelated edits trigger no query or render; next restarts a stale revision, while relevant bursts coalesce", async () => {
  const client = new Client(), source = new Source(client), store = new PagedQueryStore(source, options, 10); let renders = 0;
  const stop = store.subscribe(() => { renders++; });
  try {
    await wait(() => store.getSnapshot().page); const before = client.read, count = renders;
    source.commit("other_1"); await pause(25); assert.equal(client.read, before); assert.equal(renders, count);
    store.next(); await wait(() => client.read > before && !store.getSnapshot().loading);
    assert.equal(store.getSnapshot().pageIndex, 0); assert.equal(store.getSnapshot().page.revision, 2);
    const opened = client.opened; client.rows[0] = { id: "row_0", fields: { title: "Changed" } };
    for (let i = 0; i < 15; i++) source.commit("row_0");
    await wait(() => store.getSnapshot().page.items[0].fields.title === "Changed");
    assert.equal(client.opened, opened + 1); assert.equal(client.active.size, 1);
    const records = client.read; source.commit("", "MEMBER_REVOKED"); await wait(() => client.read > records && !store.getSnapshot().loading);
  } finally { stop(); }
});

test("late open/read completions after unmount, Strict Mode replay and project switches are discarded and cleaned", async () => {
  const a = new Client(), b = new Client(), source = new Source(a), store = new PagedQueryStore(source, options, 0), gate = deferred();
  a.beforeOpen = () => gate.promise;
  const first = store.subscribe(() => {}); await wait(() => a.opened === 1); first();
  const second = store.subscribe(() => {}); source.set(b); gate.resolve();
  try {
    b.rows[0] = { id: "row_0", fields: { title: "New project" } };
    await wait(() => store.getSnapshot().page?.items[0].fields.title === "New project");
    assert.equal(a.active.size, 0); assert.equal(b.active.size, 1);
    const reading = deferred(); b.beforeRead = () => reading.promise; store.next(); await wait(() => b.read === 2);
    source.set(null); assert.equal(store.getSnapshot().page, null); assert.equal(store.getSnapshot().loading, false);
    reading.resolve(); await pause(10); assert.equal(store.getSnapshot().page, null); assert.equal(b.active.size, 0);
  } finally { gate.resolve(); second(); }
});

test("expired/invalidation restart is finite; persistent and oversized failures can be manually retried", async () => {
  const client = new Client(), source = new Source(client), store = new PagedQueryStore(source, options, 0), stop = store.subscribe(() => {});
  try {
    await wait(() => store.getSnapshot().page); client.active.clear(); store.next();
    await wait(() => client.opened === 2 && !store.getSnapshot().loading); assert.equal(store.getSnapshot().pageIndex, 0);
    client.fail = new QueryCursorInvalidatedError(); store.refresh();
    await wait(() => store.getSnapshot().error); const attempts = client.opened;
    await pause(30); assert.equal(client.opened, attempts); assert.equal(client.active.size, 0); assert.equal(store.getSnapshot().canNext, false);
    client.fail = new QueryPageTooLargeError(); store.refresh(); await wait(() => store.getSnapshot().error?.name === "QueryPageTooLargeError");
    client.fail = null; store.refresh(); await wait(() => store.getSnapshot().page && !store.getSnapshot().error && !store.getSnapshot().loading);
  } finally { stop(); }
});

test("empty non-final pages do not end pagination and project-open errors retain no old rows", async () => {
  const client = new Client(), source = new Source(null), store = new PagedQueryStore(source, options, 0), stop = store.subscribe(() => {});
  const read = client.readQueryCursor.bind(client); let empty = true;
  client.readQueryCursor = async id => empty ? (empty = false, { kind: "items", revision: 1, lamport: 1, items: [], decisions: [], done: false, scanned: 256, encodedBytes: 40 }) : read(id);
  try {
    source.set(client); await wait(() => store.getSnapshot().page); assert.equal(store.getSnapshot().page.items.length, 0); assert.equal(store.getSnapshot().canNext, true);
    store.next(); await wait(() => store.getSnapshot().pageIndex === 1 && !store.getSnapshot().loading); assert.equal(store.getSnapshot().page.items.length, 2);
    const error = new Error("Vault unavailable"); source.set(null, "error", error);
    assert.equal(store.getSnapshot().page, null); assert.equal(store.getSnapshot().error, error); assert.equal(client.active.size, 0);
    assert.throws(() => new PagedQueryStore(source, options, -1), RangeError);
  } finally { stop(); }
});


test("ProjectSession paged-only observers do not fetch or retain full views; late legacy consumers refresh then release", async () => {
  const { ProjectSession } = await import("../../dist/react-session.js");
  const { event, alice, projectId } = await import("../helpers/core-fixtures.mjs");
  const snapshot = { schemaVersion: 1, lamport: 0, items: [] };
  class Worker {
    snapshots = 0; terminated = 0;
    postMessage(request) {
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: true,
        result: request.method === "openCompact" ? { actorId: alice.actorId, projectId, recovery: { eventCount: 0, discardedTailBytes: 0 }, snapshot } :
          request.method === "snapshot" ? (this.snapshots++, { ...snapshot, lamport: this.snapshots }) : null } }));
    }
    terminate() { this.terminated++; }
    emit(e) { this.onmessage?.({ data: { kind: "commit", source: "remote", event: e } }); }
  }
  const worker = new Worker(), session = new ProjectSession(projectId, { mode: "wallet", walletId: "session_test", passphrase: "public-session-test-passphrase", clientOptions: { workerFactory: () => worker } });
  const release = session.retain(); let offView; let commits = 0;
  const offCommit = session.subscribeCommits(() => { commits++; });
  try {
    await wait(() => session.getState().status === "ready");
    assert.equal(session.getView(), null); assert.equal(worker.snapshots, 0);
    worker.emit(await event(1, "ITEM_ADDED", { name: "Published" })); await pause(15);
    assert.equal(commits, 1); assert.equal(worker.snapshots, 0); assert.equal(session.getView(), null);
    offView = session.subscribeView(() => {}); await wait(() => worker.snapshots === 1 && session.getView());
    worker.emit(await event(2, "ITEM_UPDATED", { name: "Updated" })); await wait(() => worker.snapshots === 2);
    offView(); offView = null; await pause(5); assert.equal(session.getView(), null);
    worker.emit(await event(3, "ITEM_UPDATED", { name: "Later" })); await pause(15); assert.equal(worker.snapshots, 2);
  } finally { offView?.(); offCommit(); release(); }
  await wait(() => session.getState().status === "closed"); assert.equal(worker.terminated, 1);
});
