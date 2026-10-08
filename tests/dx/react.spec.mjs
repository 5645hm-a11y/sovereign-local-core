import { test, expect } from "@playwright/test";
import { startSignalingServer } from "../../scripts/signaling-server.mjs";
import { WebSocket } from "ws";
test("project unmount closes real signaling, PeerConnection and DataChannel", async ({ page }) => {
  const server = await startSignalingServer({ port: 0 }), roomId = crypto.randomUUID();
  let remote;
  try {
    await page.addInitScript(signaling => {
      window.networkResources = { sockets: [], peers: [], channels: [] };
      const NativeSocket = window.WebSocket, NativePeer = window.RTCPeerConnection;
      window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); if (args[0] === signaling) window.networkResources.sockets.push(this); } };
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); window.networkResources.peers.push(this); }
        createDataChannel(...args) { const channel = super.createDataChannel(...args); window.networkResources.channels.push(channel); return channel; }
      };
    }, server.url);
    await page.goto(`http://127.0.0.1:4180/demo/?signaling=${encodeURIComponent(server.url)}&room=${roomId}`);
    await expect(page.getByTestId("project-status")).toContainText("Ready");
    await expect.poll(() => page.evaluate(() => window.networkResources.sockets.some(socket => socket.readyState === 1))).toBe(true);
    remote = new WebSocket(server.url);
    await new Promise((resolve, reject) => { remote.once("open", resolve); remote.once("error", reject); });
    remote.send(JSON.stringify({ kind: "join", roomId }));
    await expect.poll(() => page.evaluate(() => window.networkResources.channels.length)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close project" }).click();
    await expect.poll(() => page.evaluate(() => {
      const r = window.networkResources;
      return { sockets: r.sockets.map(s => s.readyState), peers: r.peers.map(p => p.connectionState), channels: r.channels.map(c => c.readyState) };
    })).toEqual({ sockets: [3], peers: ["closed"], channels: ["closed"] });
  } finally { remote?.terminate(); await server.close(); }
});
test("installed package runs in Vite dev Strict Mode: live selection, progress and worker cleanup", async ({ page }) => {
  const failures = []; page.on("pageerror", e => failures.push(e.message));
  await page.addInitScript(() => {
    const Native = window.Worker; window.workerCounts = { created: 0, terminated: 0 };
    window.Worker = class extends Native {
      constructor(...args) { super(...args); window.workerCounts.created++; }
      terminate() { window.workerCounts.terminated++; return super.terminate(); }
    };
  });
  await page.goto("http://127.0.0.1:4180/demo/");
  await expect(page.getByTestId("project-status")).toContainText("Ready");
  expect(await page.evaluate(() => window.workerCounts.created - window.workerCounts.terminated)).toBe(1);
  await page.getByLabel("Task title").fill("React durable task"); await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByTestId("tasks")).toContainText("React durable task");
  const renders = await page.getByTestId("task-renders").textContent();
  await page.getByRole("button", { name: "Add unrelated record" }).click();
  // Wait for a commit-backed later action (upload), then check selector suppression.
  await page.getByLabel("Upload file").setInputFiles({ name: "react-file.txt", mimeType: "text/plain", buffer: Buffer.alloc(2 * 1024 * 1024 + 71, 75) });
  await expect(page.getByTestId("storage-status")).toContainText("success · 3/3 chunks");
  await expect(page.getByTestId("files").locator("li")).toHaveCount(1);
  expect(await page.getByTestId("task-renders").textContent()).toBe(renders);
  await page.getByRole("button", { name: "Close project" }).click();
  await expect.poll(() => page.evaluate(() => window.workerCounts.created - window.workerCounts.terminated)).toBe(0);
  await page.getByRole("button", { name: "Reopen project" }).click();
  await expect(page.getByTestId("project-status")).toContainText("Ready");
  await expect(page.getByTestId("tasks")).toContainText("React durable task");
  await expect(page.getByTestId("files").locator("li")).toHaveCount(1);
  await page.reload(); await expect(page.getByTestId("project-status")).toContainText("Ready");
  await expect(page.getByTestId("tasks")).toContainText("React durable task");
  expect(failures).toEqual([]);
});
test("Vite production bundle loads embedded worker/WASM beneath a non-root base URL", async ({ page }) => {
  const failed = []; page.on("pageerror", e => failed.push(e.message));
  await page.goto("http://127.0.0.1:4181/demo/");
  await expect(page.getByTestId("project-status")).toContainText("Ready");
  await page.getByLabel("Task title").fill("Production task"); await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByTestId("tasks")).toContainText("Production task"); expect(failed).toEqual([]);
});
test("Next.js production App Router SSR and hydration open the installed package beneath basePath", async ({ page, request }) => {
  const response = await request.get("http://127.0.0.1:4190/nested");
  expect(response.ok()).toBe(true); expect(await response.text()).toContain("Next.js installed package");
  const failed = []; page.on("pageerror", e => failed.push(e.message));
  await page.goto("http://127.0.0.1:4190/nested"); await expect(page.getByTestId("status")).toHaveText("ready");
  await page.getByRole("button", { name: "Create task" }).click(); await expect(page.getByRole("listitem")).toHaveText("Next task");
  await page.reload(); await expect(page.getByTestId("status")).toHaveText("ready"); await expect(page.getByRole("listitem")).toHaveText("Next task");
  expect(failed).toEqual([]);
});
test("hosted self-contained Worker works when CSP disallows blob Workers", async ({ page }) => {
  const failed = []; page.on("pageerror", e => failed.push(e.message));
  await page.route("http://127.0.0.1:4181/demo/?hosted=1", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "worker-src 'self'" } });
  });
  await page.goto("http://127.0.0.1:4181/demo/?hosted=1"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  await page.getByLabel("Task title").fill("Hosted worker task"); await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByTestId("tasks")).toContainText("Hosted worker task"); expect(failed).toEqual([]);
});
test("upload progress crosses Worker RPC and AbortSignal stops before manifest publication", async ({ page }) => {
  await page.goto("http://127.0.0.1:4180/demo/"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  const result = await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/demo/node_modules/sovereign-local-core/package-dist/index.js");
    const client = new LocalCoreClient(), controller = new AbortController(), progress = [];
    await client.createProject("rpc_cancel_test", { projectId: "rpc_cancel_test", email: "cancel@example.test", password: "cancel-test-password-2026" });
    try {
      let name;
      try { await client.storage.upload(new Blob([new Uint8Array(8 * 1024 * 1024)]), { chunkSize: 65536, signal: controller.signal,
        onProgress: p => { progress.push(p.completedChunks); if (p.completedChunks >= 1) controller.abort(); } }); }
      catch (error) { name = error.name; }
      return { name, progress, items: (await client.snapshot()).items.length };
    } finally { await client.close(); }
  });
  expect(result.name).toBe("AbortError"); expect(result.items).toBe(0);
  expect(result.progress[0]).toBe(0); expect(result.progress.at(-1)).toBeLessThan(128);
});
