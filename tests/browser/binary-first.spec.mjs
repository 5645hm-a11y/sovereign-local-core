import { test, expect } from "@playwright/test";

test("binary OPFS and default 1000-event checkpoint recover delta after abrupt Worker termination", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  const before = await page.evaluate(async () => {
    await window.ready;
    for (let i = 0; i < 1000; i++) await window.localCore.dispatch({
      type: i === 0 ? "ITEM_ADDED" : i === 999 ? "ITEM_DELETED" : "ITEM_UPDATED",
      itemId: "checkpoint-item", ...(i === 999 ? {} : { fields: { n: i, secret: "OPFS_CHECKPOINT_SECRET_778" } }),
    });
    const final = await window.localCore.dispatch({ type: "ITEM_UPDATED", itemId: "checkpoint-item", fields: { hidden: "survives" } });
    window.localCore.terminate();
    return final;
  });
  const after = await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const core = new LocalCoreClient(); window.localCore = core;
    const opened = await core.open("example-v3", window.demoCredentials);
    const summary = await core.getSyncSummary();
    const restored = await core.dispatch({ type: "ITEM_ADDED", itemId: "checkpoint-item", fields: {} });
    await core.close();
    const root = await navigator.storage.getDirectory(), ns = await root.getDirectoryHandle("sovereign-local-core"), dir = await ns.getDirectoryHandle("example-v3");
    const file = await dir.getFileHandle("events.slc"), bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    const view = new DataView(bytes.buffer), frames = []; let at = 0;
    while (at < bytes.length) { const length = view.getUint32(at + 4, true); frames.push(view.getUint32(at, true)); at += 16 + length; }
    const cp = await dir.getFileHandle("checkpoint-0.slc"), cpBytes = new Uint8Array(await (await cp.getFile()).arrayBuffer());
    return { opened, summary, restored, binary: frames.every(m => m === 0x32434c53), checkpointBytes: cpBytes.length,
      private: ["utf-8", "utf-16le"].every(encoding => !new TextDecoder(encoding).decode(cpBytes).includes("OPFS_CHECKPOINT_SECRET_778")) };
  });
  expect(after.opened.recovery.checkpointEvents).toBe(1000);
  expect(after.opened.recovery.replayedEvents).toBe(1);
  expect(after.opened.snapshot).toEqual(before.snapshot);
  expect(after.summary[before.event.actorId]).toBe(1001);
  expect(after.restored.event.sequence).toBe(1002);
  expect(after.restored.snapshot.items[0].fields).toEqual({ hidden: "survives", n: 998, secret: "OPFS_CHECKPOINT_SECRET_778" });
  expect(after.binary && after.private && after.checkpointBytes > 0).toBe(true);
});
