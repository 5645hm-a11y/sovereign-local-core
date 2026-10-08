import { test, expect } from "@playwright/test";

test("flushed events and identity recover after a full page reload", async ({ page }) => {
  await page.goto("/");
  const before = await page.evaluate(async () => {
    await window.ready;
    const { events, snapshot } = await window.example();
    return { events, snapshot, actorId: (await window.ready).actorId };
  });
  await page.reload(); // No close(), beforeunload handler, or final shutdown flush.
  const after = await page.evaluate(async () => {
    const opened = await window.ready;
    return { events: await window.localCore.readEvents(), snapshot: await window.localCore.snapshot(), actorId: opened.actorId };
  });
  expect(after).toEqual(before);
  const next = await page.evaluate(async () => window.localCore.dispatch({
    type: "ITEM_UPDATED", itemId: (await window.localCore.snapshot()).items[0].id, fields: { title: "after reload" },
  }));
  expect(next.event.sequence).toBe(3);
  expect(next.event.lamport).toBe(3);
});

test("a second tab cannot race the exclusive log writer", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => window.ready);
  const second = await context.newPage();
  await second.goto("/");
  const error = await second.evaluate(async () => {
    try { await window.ready; return null; }
    catch (error) { return { name: error.name, message: error.message }; }
  });
  expect(error?.name).toBe("NoModificationAllowedError");
  await page.evaluate(() => window.localCore.close());
  const reopened = await second.evaluate(() => window.localCore.open("example-v3", window.demoCredentials));
  expect(reopened.snapshot.items).toEqual([]);
});

test("abrupt worker termination retains acknowledged writes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    await window.ready;
    const before = (await window.example()).snapshot;
    window.localCore.terminate();
    const { LocalCoreClient } = await import("/dist/client.js");
    const next = new LocalCoreClient();
    window.localCore = next;
    const opened = await next.open("example-v3", window.demoCredentials);
    return { before, after: opened.snapshot };
  });
  expect(result.after).toEqual(result.before);
});

test("real OPFS repairs an incomplete final frame on reopen", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    await window.ready;
    const before = (await window.example()).snapshot;
    await window.localCore.close();
    // Mutate only an isolated test database, with its normal writer already closed.
    const source = `
      onmessage = async () => {
        const root = await navigator.storage.getDirectory();
        const namespace = await root.getDirectoryHandle("sovereign-local-core");
        const directory = await namespace.getDirectoryHandle("example-v3");
        const file = await directory.getFileHandle("events.slc");
        const handle = await file.createSyncAccessHandle();
        handle.write(new Uint8Array([1,2,3,4,5]), { at: handle.getSize() });
        handle.flush(); handle.close(); postMessage("done");
      };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    await new Promise((resolve, reject) => {
      worker.onmessage = resolve; worker.onerror = reject; worker.postMessage(null);
    });
    worker.terminate(); URL.revokeObjectURL(url);
    const { LocalCoreClient } = await import("/dist/client.js");
    const next = new LocalCoreClient(); window.localCore = next;
    const opened = await next.open("example-v3", window.demoCredentials);
    return { before, after: opened.snapshot, discarded: opened.recovery.discardedTailBytes };
  });
  expect(result.after).toEqual(result.before);
  expect(result.discarded).toBe(5);
});
