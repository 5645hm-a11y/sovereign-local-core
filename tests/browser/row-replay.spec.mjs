import { test, expect } from "@playwright/test";

test("Dedicated Worker/WASM reduces only affected rows, restores legacy history and retains denied-batch state", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker("/tests/fixtures/row-replay-worker.mjs", { type: "module" });
    worker.onmessage = e => { worker.terminate(); resolve(e.data); };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(null);
  }));
  expect(result.error).toBeUndefined();
  expect(result.suffix).toEqual({ rows: 1, commands: 1, suffixRows: 1, replayedRows: 0 });
  expect(result.late).toEqual({ rows: 1, commands: 3, suffixRows: 0, replayedRows: 1 });
  expect(result.restore).toEqual({ rows: 1000, commands: 1002, suffixRows: 0, replayedRows: 1000 });
  expect(result.rows).toBe(1000); expect(result.viewEqual).toBe(true); expect(result.checkpointIntact).toBe(true);
  expect(result.denied).toBe(3); expect(result.winner).toBe("actor_first:1"); expect(result.loser).toBe("REJECTED_CONFLICT");
  expect(result.unchanged).toBe("Asset 999");
});
