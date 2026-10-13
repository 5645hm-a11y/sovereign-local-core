import { test, expect } from "@playwright/test";

test("real OPFS Worker receipt writes and bounded query pages survive abrupt close and invalidate on changes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalCoreClient, QueryCursorInvalidatedError } = await import("/dist/index.js");
    const credentials = { mode: "wallet", walletId: "query-browser-wallet", passphrase: "public-query-test-passphrase", projectId: "query-browser-project", vaultName: "query-browser-vault" };
    let db = new LocalCoreClient(); await db.createProject("query-browser-db", credentials);
    const pages = [], receipts = [];
    try {
      for (let i = 0; i < 80; i++) receipts.push(await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: `record_${String(i).padStart(3, "0")}`, fields: { text: "x".repeat(256), i } }));
      let cursor = await db.openQueryCursor({ kind: "items", limit: 5, maxBytes: 4096 });
      while (true) { const p = await db.readQueryCursor(cursor.id); pages.push(p); if (p.done) break; }
      cursor = await db.openQueryCursor({ kind: "items", limit: 1 }); await db.readQueryCursor(cursor.id);
      const last = await db.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_000", fields: { text: "durable delta" } });
      let invalidated = false;
      try { await db.readQueryCursor(cursor.id); } catch (error) { invalidated = error instanceof QueryCursorInvalidatedError; }
      const retryCursor = await db.openQueryCursor({ kind: "items", prefix: "record_000" });
      const retry = await db.ingestCommitted([last.event]); const retryPage = await db.readQueryCursor(retryCursor.id);
      db.terminate(); db = new LocalCoreClient(); const opened = await db.open("query-browser-db", credentials);
      cursor = await db.openQueryCursor({ kind: "items", prefix: "record_000" }); const recovered = await db.readQueryCursor(cursor.id);
      return { items: pages.flatMap(p => p.items).length, maxBytes: Math.max(...pages.map(p => p.encodedBytes)), maxItems: Math.max(...pages.map(p => p.items.length)),
        revisions: [...new Set(pages.map(p => p.revision))], receiptsHaveSnapshots: receipts.some(r => "snapshot" in r), invalidated,
        retry: retry.applied, retryText: retryPage.items[0].fields.text, recovered: recovered.items[0].fields.text, openedCount: opened.snapshot.items.length };
    } finally { await db.close(); }
  });
  expect(result.items).toBe(80); expect(result.maxBytes).toBeLessThanOrEqual(4096); expect(result.maxItems).toBeLessThanOrEqual(5);
  expect(result.revisions).toEqual([80]); expect(result.receiptsHaveSnapshots).toBe(false); expect(result.invalidated).toBe(true);
  expect(result.retry).toBe(0); expect(result.retryText).toBe("durable delta"); expect(result.recovered).toBe("durable delta"); expect(result.openedCount).toBe(80);
});


test("failed lazy first-view creation releases OPFS ownership and permits retry in the same Worker", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/index.js");
    const source = `import { BinaryProjection } from "${location.origin}/dist/wasm-loader.js";
      const original = BinaryProjection.prototype.snapshot; let fail = true;
      BinaryProjection.prototype.snapshot = function (...args) { if (fail) { fail = false; throw new Error("injected first-view failure"); } return original.apply(this, args); };
      await import("${location.origin}/dist/worker.js"); postMessage({ ready: true });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" })), worker = new Worker(url, { type: "module" });
    await new Promise((resolve, reject) => { worker.onmessage = ({ data }) => data.ready && resolve(); worker.onerror = reject; });
    const db = new LocalCoreClient({ workerFactory: () => worker });
    const credentials = { mode: "wallet", walletId: "query-retry-wallet", passphrase: "public-query-retry-passphrase", projectId: "query-retry-project", vaultName: "query-retry-vault" };
    try {
      let error; try { await db.createProject("query-retry-db", credentials); } catch (e) { error = e.message; }
      const reopened = await db.open("query-retry-db", credentials);
      await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: "record_1", fields: { recovered: true } });
      const cursor = await db.openQueryCursor({ kind: "items" }); const page = await db.readQueryCursor(cursor.id);
      return { error, initialRows: reopened.snapshot.items.length, recovered: page.items[0].fields.recovered };
    } finally { await db.close(); URL.revokeObjectURL(url); }
  });
  expect(result.error).toBe("injected first-view failure"); expect(result.initialRows).toBe(0); expect(result.recovered).toBe(true);
});


test("compact create/open never materializes a full Snapshot and preserves signed OPFS recovery", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/index.js");
    const source = `import { BinaryProjection } from "${location.origin}/dist/wasm-loader.js";
      BinaryProjection.prototype.snapshot = () => { throw new Error("Full view forbidden in compact test"); };
      await import("${location.origin}/dist/worker.js"); postMessage({ ready: true });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const make = async () => {
      const worker = new Worker(url, { type: "module" });
      await new Promise((resolve, reject) => { worker.onmessage = ({ data }) => data.ready && resolve(); worker.onerror = reject; });
      return new LocalCoreClient({ workerFactory: () => worker });
    };
    const credentials = { mode: "wallet", walletId: "compact-open-wallet", passphrase: "public-compact-test-passphrase", projectId: "compact-open-project", vaultName: "compact-open-vault" };
    let db = await make();
    try {
      const created = await db.createProjectCompact("compact-open-db", credentials);
      for (let i = 0; i < 20; i++) await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: `row_${i}`, fields: { i } });
      db.terminate(); db = await make(); const recovered = await db.openCompact("compact-open-db", credentials);
      const cursor = await db.openQueryCursor({ kind: "items", limit: 4, maxBytes: 2048 }); const first = await db.readQueryCursor(cursor.id);
      await db.closeQueryCursor(cursor.id);
      return { createdFull: "snapshot" in created, recoveredFull: "snapshot" in recovered, actorEqual: created.actorId === recovered.actorId,
        recoveredEvents: recovered.recovery.eventCount, firstCount: first.items.length, done: first.done };
    } finally { await db.close(); URL.revokeObjectURL(url); }
  });
  expect(result).toEqual({ createdFull: false, recoveredFull: false, actorEqual: true, recoveredEvents: 20, firstCount: 4, done: false });
});


test("real Worker/OPFS field queries filter/order without full snapshots, invalidate after edits and recover", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { LocalCoreClient, QueryCursorInvalidatedError, QueryIndexLimitError } = await import("/dist/index.js");
    const credentials = { mode: "wallet", walletId: "field-query-wallet", passphrase: "public-field-query-passphrase", projectId: "field-query-project", vaultName: "field-query-vault" };
    let db = new LocalCoreClient(); await db.createProjectCompact("field-query-db", credentials);
    const query = { kind: "items", prefix: "record_", where: [{ field: "status", op: "eq", value: "open" }, { field: "priority", op: "gte", value: 2 }], orderBy: { field: "priority", direction: "desc" }, limit: 3, maxBytes: 4096 };
    try {
      for (let i = 0; i < 20; i++) await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: `record_${String(i).padStart(3, "0")}`, fields: { status: i % 2 ? "open" : "closed", priority: i % 5 } });
      let cursor = await db.openQueryCursor(query), first = await db.readQueryCursor(cursor.id);
      await db.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_019", fields: { status: "closed" } });
      let invalid = false; try { await db.readQueryCursor(cursor.id); } catch (error) { invalid = error instanceof QueryCursorInvalidatedError; }
      const maintainedCursor = await db.openQueryCursor(query), maintained = await db.readQueryCursor(maintainedCursor.id);
      await db.closeQueryCursor(maintainedCursor.id);
      await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: "other_large", fields: { text: "x".repeat(1025) } });
      cursor = await db.openQueryCursor({ kind: "items", prefix: "other_", orderBy: { field: "text" } });
      let limit = false; try { await db.readQueryCursor(cursor.id); } catch (error) { limit = error instanceof QueryIndexLimitError; }
      await db.close(); db = new LocalCoreClient(); await db.openCompact("field-query-db", credentials);
      cursor = await db.openQueryCursor(query); const after = [];
      while (true) { const p = await db.readQueryCursor(cursor.id); after.push(...p.items); if (p.done) break; }
      return { first: first.items.map(i => i.id), cold: first.indexBuildScanned, maintainedBuild: maintained.indexBuildScanned, maintainedFirst: maintained.items[0].id, invalid, limit, after: after.map(i => ({ id: i.id, priority: i.fields.priority, status: i.fields.status })) };
    } finally { await db.close(); }
  });
  expect(result.first).toEqual(["record_019", "record_009", "record_013"]); expect(result.cold).toBe(20); expect(result.invalid).toBe(true); expect(result.limit).toBe(true);
  expect(result.maintainedBuild).toBe(0); expect(result.maintainedFirst).toBe("record_009");
  expect(result.after.map(i => i.id)).toEqual(["record_009", "record_013", "record_003", "record_017", "record_007"]);
  expect(result.after.every(i => i.status === "open" && i.priority >= 2)).toBe(true);
});
