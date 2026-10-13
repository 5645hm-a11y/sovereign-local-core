import { test, expect } from "@playwright/test";
import { startSignalingServer } from "../../scripts/signaling-server.mjs";

test("real Workers/OPFS/DataChannels use bounded cursors for holes, live updates and reload recovery", async ({ browser }) => {
  test.setTimeout(90000);
  const server = await startSignalingServer({ port: 0 });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await Promise.all([a, b].map(p => p.goto(`${test.info().project.use.baseURL}/examples/p2p.html?db=cursor-replica`)));
    await Promise.all([a, b].map(p => p.evaluate(() => window.ready)));
    await a.evaluate(() => window.createDemoProject());
    const actor = await b.evaluate(async () => (await window.ready).actorId);
    const { invitation, event } = await a.evaluate(actor => window.db.inviteMember(actor), actor);
    await b.evaluate(i => window.joinDemoProject(i), invitation); await b.evaluate(e => window.db.ingestEvents([e]), event);
    await a.evaluate(async () => {
      for (let i = 0; i < 120; i++) await window.db.dispatch({ type: "ITEM_ADDED", itemId: `record_${i}`, fields: { i, text: "x".repeat(1024) } });
    });
    const sparse = await a.evaluate(() => window.db.readEvents().then(events => events.find(e => e.sequence === 11)));
    await b.evaluate(e => window.db.ingestEvents([e]), sparse);
    expect(await b.evaluate(actor => window.db.getSyncSummary().then(s => s[actor]), sparse.actorId)).toBe(1);
    const instrument = async page => page.evaluate(() => {
      window.cursorMetrics = { opened: 0, pages: 0, closed: 0, compactIngests: 0, maximumEvents: 0, maximumBytes: 0 };
      const db = window.db, open = db.openSyncCursor.bind(db), read = db.readSyncCursor.bind(db), close = db.closeSyncCursor.bind(db), compact = db.ingestCommitted.bind(db);
      db.ingestCommitted = async events => { window.cursorMetrics.compactIngests++; return compact(events); };
      db.ingestEvents = async () => { throw new Error("Full snapshot ingestion forbidden during sync test"); };
      db.openSyncCursor = async s => { window.cursorMetrics.opened++; return open(s); };
      db.readSyncCursor = async id => {
        const page = await read(id), m = window.cursorMetrics; m.pages++;
        m.maximumEvents = Math.max(m.maximumEvents, page.events.length); m.maximumBytes = Math.max(m.maximumBytes, page.scannedBytes); return page;
      };
      db.closeSyncCursor = async id => { window.cursorMetrics.closed++; return close(id); };
      db.readMissingEvents = db.readMissingEventsPaged = async () => { throw new Error("Bulk catch-up forbidden in browser cursor test"); };
    });
    await Promise.all([instrument(a), instrument(b)]);
    const room = crypto.randomUUID();
    const connect = page => page.evaluate(({ room, url }) => window.connectP2P(room, url), { room, url: server.url });
    const online = async () => Promise.all([a, b].map(page => expect.poll(() => page.evaluate(() => ({ state: window.sync.state, error: window.sync.lastError })), { timeout: 20000 }).toEqual({ state: "online", error: null })));
    await Promise.all([connect(a), connect(b)]); await online();
    expect(await b.evaluate(() => window.db.snapshot().then(s => s.items.length))).toBe(120);
    expect(await b.evaluate(() => window.cursorMetrics.compactIngests)).toBeGreaterThan(0);
    const metrics = await a.evaluate(() => window.cursorMetrics);
    expect(metrics.opened).toBe(1); expect(metrics.closed).toBe(1); expect(metrics.pages).toBeGreaterThan(2);
    expect(metrics.maximumEvents).toBeLessThanOrEqual(64); expect(metrics.maximumBytes).toBeLessThanOrEqual(131072);
    const tail = await a.evaluate(async actorId => {
      const summary = await window.db.getSyncSummary(), handle = await window.db.openSyncCursor({ [actorId]: summary[actorId] - 2 });
      let records = 0, bytes = 0, count = 0, done = false;
      try {
        while (!done) {
          const page = await window.db.readSyncCursor(handle.id);
          records += page.scannedRecords; bytes += page.scannedBytes; count += page.events.length; done = page.done;
        }
      } finally { await window.db.closeSyncCursor(handle.id); }
      return { records, bytes, count };
    }, sparse.actorId);
    expect(tail.records).toBe(2); expect(tail.count).toBe(2); expect(tail.bytes).toBeLessThan(16384);
    await b.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "record_0", fields: { text: "cursor live" } }));
    await expect.poll(() => a.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "record_0")?.fields.text))).toBe("cursor live");
    await b.reload(); await b.evaluate(() => window.ready);
    expect(await b.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "record_0")?.fields.text))).toBe("cursor live");
    await instrument(b); await connect(b); await online();
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "record_1", fields: { text: "cursor after reload" } }));
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "record_1")?.fields.text))).toBe("cursor after reload");
    const leaked = await a.evaluate(async () => {
      const c = await window.db.openSyncCursor({}); await window.db.closeSyncCursor(c.id);
      try { await window.db.readSyncCursor(c.id); return true; } catch { return false; }
    });
    expect(leaked).toBe(false);
  } finally { await Promise.all(contexts.map(c => c.close())); await server.close(); }
});
