import { test, expect } from "@playwright/test";
import { startSignalingServer } from "../../scripts/signaling-server.mjs";
import { WebSocket } from "ws";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";
test("installed optional Nostr entry bundles beneath a production base path", async ({ page }) => {
  const relay = await startMockNostrRelay();
  try {
    await page.goto("http://127.0.0.1:4181/demo/");
    await expect(page.getByTestId("project-status")).toContainText("Ready");
    const result = await page.evaluate(url => window.probeNostr(url), relay.url);
    expect(result).toMatchObject({ equal: true, published: 1, received: 1, rejected: 0 });
    expect(relay.events).toHaveLength(1); expect(relay.errors).toEqual([]);
  } finally { await relay.close(); }
});
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

test("installed package creates generic read domains with embedded Workers/WASM and enforces private access", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.Worker; window.domainWorkerCounts = { created: 0, terminated: 0 };
    window.Worker = class extends Native {
      constructor(...args) { super(...args); window.domainWorkerCounts.created++; }
      terminate() { window.domainWorkerCounts.terminated++; return super.terminate(); }
    };
  });
  await page.goto("http://127.0.0.1:4180/demo/"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  const result = await page.evaluate(async () => {
    const { ReadDomainsClient, LocalCoreClient } = await import("/demo/node_modules/sovereign-local-core/package-dist/index.js");
    const before = window.domainWorkerCounts.created - window.domainWorkerCounts.terminated;
    const credentials = id => ({ mode: "wallet", walletId: id, passphrase: "synthetic-installed-domain-passphrase" });
    const rule = (prefix, roles) => ({ prefix, create: roles, update: roles, delete: ["Admin"], checkout: [], return: [], ownerField: null, library: false });
    const definitions = [
      { id: "shared", prefixes: ["record_"], readRoles: ["Admin", "Member"], policies: { version: 1, defaultAllow: false, rules: [rule("record_", ["Admin", "Member"])] } },
      { id: "private", prefixes: ["private_"], readRoles: ["Admin"], policies: { version: 1, defaultAllow: false, rules: [rule("private_", ["Admin"])] } },
    ];
    const identityClient = new LocalCoreClient(); let actor;
    try { actor = (await identityClient.identify(credentials("installed_reader"))).actorId; } finally { identityClient.terminate(); }
    const root = await ReadDomainsClient.create("installed_root_domains", credentials("installed_owner"), definitions); let reader;
    try {
      const bundle = await root.inviteMember(actor, "Member", ["shared"]);
      reader = await ReadDomainsClient.open("installed_reader_domains", credentials("installed_reader"), bundle,
        { rootActorId: root.rootActorId, spaceId: root.space.spaceId, requiredDomainIds: ["shared"] });
      await root.dispatch({ type: "ITEM_ADDED", itemId: "record_1", fields: { text: "General application data" } });
      await root.dispatch({ type: "ITEM_ADDED", itemId: "private_1", fields: { text: "PRIVATE_INSTALLED_VALUE" } });
      await reader.domain("shared").ingestEvents(await root.domain("shared").readEvents());
      let denied = false;
      try { await reader.domain("shared").dispatch({ type: "ITEM_ADDED", itemId: "private_2", fields: { text: "Bypass" } }); }
      catch { denied = true; }
      const snapshot = await reader.snapshot();
      await reader.close(); reader = undefined; await root.close();
      return { denied, snapshot, before, after: window.domainWorkerCounts.created - window.domainWorkerCounts.terminated };
    } finally { await reader?.close(); await root.close(); }
  });
  expect(result.denied).toBe(true); expect(result.snapshot.items.map(i => i.id)).toEqual(["record_1"]);
  expect(result.snapshot.unavailableDomains).toEqual(["private"]); expect(result.after).toBe(result.before);
});

for (const routed of [false, true]) test(`installed package ${routed ? "routed" : "broadcast"} recovery through Member Workers works with the root closed`, async ({ page }) => {
  await page.goto("http://127.0.0.1:4180/demo/"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  const result = await page.evaluate(async routed => {
    const { LocalCoreClient, DiscoveryRecovery } = await import("/demo/node_modules/sovereign-local-core/package-dist/index.js");
    const projectId = crypto.randomUUID(), clients = [], providers = new Set(), sessions = [];
    const credentials = name => ({ mode: "wallet", walletId: `installed-recovery-${name}`, passphrase: "synthetic-installed-recovery-passphrase", projectId });
    let broadcastCalls = 0;
    const provider = () => ({ supportsRouting: routed, receiver: null, topic: null, instanceId: null,
      async start(topic, receiver) { this.topic = topic; this.receiver = receiver; providers.add(this); },
      async startRouted(topic, instanceId, receiver) { this.instanceId = instanceId; await this.start(topic, receiver); },
      async publish(packet) { broadcastCalls++; if (routed) throw new Error("Routed recovery cannot broadcast"); for (const p of providers) if (p.topic === this.topic) p.receiver(packet.slice()); },
      async publishRouted(packet, recipient) { for (const p of providers) if (p.topic === this.topic && (recipient === null || p.instanceId === recipient)) p.receiver(packet.slice()); },
      stop() { providers.delete(this); this.receiver = null; } });
    try {
      const root = new LocalCoreClient(); clients.push(root); await root.createProject("installed-recovery-root", credentials("root"));
      for (const name of ["target", "hub", "cold"]) {
        const client = new LocalCoreClient(); clients.push(client);
        const actorId = (await client.identify(credentials(name))).actorId, grant = await root.inviteMember(actorId);
        await client.open(`installed-recovery-${name}`, { ...credentials(name), invitation: grant.invitation });
      }
      const [owner, target, hub, cold] = clients, oldKey = (await cold.getDiscoveryInfo()).keyId;
      await owner.revokeMember((await target.getProjectInfo()).certificate.subject, { paged: true });
      await hub.ingestEvents(await owner.readEvents()); await owner.close();
      const server = new DiscoveryRecovery(hub, { discovery: provider(), intervalMs: 1000, responseTimeoutMs: 3000 });
      const requester = new DiscoveryRecovery(cold, { discovery: provider(), intervalMs: 1000, responseTimeoutMs: 3000 });
      sessions.push(server, requester); await server.start(); await requester.start();
      for (let i = 0; i < 1000 && !requester.stats.completed; i++) await new Promise(r => setTimeout(r, 10));
      const info = await cold.getDiscoveryInfo(), expected = await hub.getDiscoveryInfo();
      const pending = (await cold.getProjectInfo()).pendingEpochs;
      for (const session of sessions) session.stop();
      return { completed: requester.stats.completed, changed: info.keyId !== oldKey, same: info.keyId === expected.keyId, pending, subscriptions: providers.size, broadcastCalls };
    } finally { for (const session of sessions) session.stop(); for (const client of clients) await client.close().catch(() => {}); }
  }, routed);
  expect(result.completed).toBeGreaterThan(0); expect(result.changed).toBe(true); expect(result.same).toBe(true);
  expect(result.pending).toEqual([]); expect(result.subscriptions).toBe(0);
  if (routed) expect(result.broadcastCalls).toBe(0);
});


test("installed embedded WASM serves bounded queries and typed revision errors after compact writes", async ({ page }) => {
  await page.goto("http://127.0.0.1:4180/demo/"); await expect(page.getByTestId("project-status")).toContainText("Ready");
  const result = await page.evaluate(async () => {
    const { LocalCoreClient, QueryCursorInvalidatedError } = await import("/demo/node_modules/sovereign-local-core/package-dist/index.js");
    const db = new LocalCoreClient();
    try {
      await db.createProject("installed_query", { mode: "wallet", walletId: "installed_query", passphrase: "synthetic-query-passphrase", projectId: "installed_query" });
      for (let i = 0; i < 12; i++) await db.dispatchCommitted({ type: "ITEM_ADDED", itemId: `record_${i}`, fields: { text: "row" } });
      const cursor = await db.openQueryCursor({ kind: "items", prefix: "record_", limit: 3, maxBytes: 2048 });
      const first = await db.readQueryCursor(cursor.id);
      const receipt = await db.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_0", fields: { text: "delta" } });
      let typed = false; try { await db.readQueryCursor(cursor.id); } catch (error) { typed = error instanceof QueryCursorInvalidatedError; }
      return { count: first.items.length, done: first.done, bytes: first.encodedBytes, typed, revision: receipt.revision, full: "snapshot" in receipt };
    } finally { await db.close(); }
  });
  expect(result.count).toBe(3); expect(result.done).toBe(false); expect(result.bytes).toBeLessThanOrEqual(2048);
  expect(result.typed).toBe(true); expect(result.revision).toBe(13); expect(result.full).toBe(false);
});


for (const production of [false, true]) test(`installed paged React query owns one page, skips Snapshot RPCs, refreshes selectively and cleans Strict Mode lifecycle (${production ? "production" : "dev"})`, async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.pagedRPC = { snapshot: 0, compactOpens: 0, fullOpens: 0, open: 0, read: 0, close: 0, writes: 0, created: 0, terminated: 0, active: new Set() };
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args); window.pagedRPC.created++; const methods = new Map(); this.pendingMethods = methods;
        this.addEventListener("message", ({ data }) => {
          if (data.kind || !methods.has(data.id)) return;
          const pending = methods.get(data.id); methods.delete(data.id);
          if (data.ok && pending.method === "openQueryCursor") window.pagedRPC.active.add(data.result.id);
          if (pending.method === "closeQueryCursor" || (pending.method === "readQueryCursor" && (data.result?.done || !data.ok))) window.pagedRPC.active.delete(pending.cursorId);
          if (pending.method === "dispatchCommitted" && data.ok) window.pagedRPC.writes++;
        });
      }
      postMessage(data, ...rest) {
        const m = window.pagedRPC;
        if (data.method === "snapshot") m.snapshot++;
        if (["openCompact", "createProjectCompact"].includes(data.method)) m.compactOpens++;
        if (["open", "createProject"].includes(data.method)) m.fullOpens++;
        if (data.method === "openQueryCursor") m.open++;
        if (data.method === "readQueryCursor") m.read++;
        if (data.method === "closeQueryCursor") m.close++;
        if (data.method) this.pendingMethods.set(data.id, data);
        return super.postMessage(data, ...rest);
      }
      terminate() { window.pagedRPC.terminated++; return super.terminate(); }
    };
  });
  await page.goto(`http://127.0.0.1:${production ? 4181 : 4180}/demo/?paged=1`);
  await expect(page.getByTestId("project-status")).toHaveText("Ready"); await expect(page.getByTestId("paged-status")).toHaveText("ready");
  await page.getByRole("button", { name: "Seed paged rows" }).click();
  await expect.poll(() => page.evaluate(() => window.pagedRPC.writes)).toBe(12);
  await expect(page.getByTestId("paged-rows").locator("li")).toHaveCount(3); await expect(page.getByTestId("paged-status")).toHaveText("ready");
  expect(await page.evaluate(() => window.pagedRPC.snapshot)).toBe(0);
  expect(await page.evaluate(() => window.pagedRPC.compactOpens)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.pagedRPC.fullOpens)).toBe(0);
  const reads = await page.evaluate(() => window.pagedRPC.read);
  await page.getByRole("button", { name: "Add unrelated paged record" }).click();
  await expect.poll(() => page.evaluate(() => window.pagedRPC.writes)).toBe(13); await page.waitForTimeout(75);
  expect(await page.evaluate(() => window.pagedRPC.read)).toBe(reads);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByTestId("paged-index")).toHaveText("0"); // Other-prefix commit invalidates cursor; safe restart.
  await expect.poll(() => page.evaluate(() => window.pagedRPC.read)).toBeGreaterThan(reads);
  await expect(page.getByTestId("paged-status")).toHaveText("ready");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByTestId("paged-index")).toHaveText("1"); await expect(page.getByTestId("paged-rows")).toContainText("Paged row 3");
  await page.getByRole("button", { name: "Edit first paged row" }).click();
  await expect(page.getByTestId("paged-rows")).toContainText("Changed first row"); await expect(page.getByTestId("paged-index")).toHaveText("0");
  await page.getByRole("button", { name: "Toggle full view" }).click(); await expect(page.getByTestId("full-view-count")).toHaveText("13");
  const snapshots = await page.evaluate(() => window.pagedRPC.snapshot); expect(snapshots).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Toggle full view" }).click();
  await page.getByRole("button", { name: "Edit first paged row" }).click();
  await expect.poll(() => page.evaluate(() => window.pagedRPC.writes)).toBe(15); await page.waitForTimeout(75);
  expect(await page.evaluate(() => window.pagedRPC.snapshot)).toBe(snapshots);
  await page.getByRole("button", { name: "Switch paged prefix" }).click(); await expect(page.getByTestId("paged-rows")).toContainText("Unrelated paged record");
  await page.getByRole("button", { name: "Switch paged prefix" }).click(); await expect(page.getByTestId("paged-rows")).toContainText("Changed first row");
  await page.getByRole("button", { name: "Close project" }).click();
  await expect.poll(() => page.evaluate(() => ({ workers: window.pagedRPC.created - window.pagedRPC.terminated, cursors: window.pagedRPC.active.size }))).toEqual({ workers: 0, cursors: 0 });
  await page.getByRole("button", { name: "Reopen project" }).click(); await expect(page.getByTestId("paged-rows")).toContainText("Changed first row");
  expect(await page.evaluate(() => window.pagedRPC.snapshot)).toBe(snapshots);
  expect(errors).toEqual([]);
});

test("Next App Router SSR/hydration can use bounded paged and legacy queries together", async ({ page, request }) => {
  const response = await request.get("http://127.0.0.1:4190/nested"); expect(response.ok()).toBe(true);
  await page.goto("http://127.0.0.1:4190/nested"); await expect(page.getByTestId("status")).toHaveText("ready");
  await expect(page.getByTestId("paged-next-status")).toHaveText("ready");
  await page.getByRole("button", { name: "Create task" }).click(); await expect(page.getByTestId("paged-next-count")).toHaveText("1");
  await page.reload(); await expect(page.getByTestId("paged-next-count")).toHaveText("1");
});


test("installed React field descriptors sort/filter natively, remain stable across renders and restart on predicate changes", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.Worker; window.fieldRPC = { snapshots: 0, queries: 0, writes: 0 };
    window.Worker = class extends Native {
      postMessage(data, ...rest) { if (data.method === "snapshot") window.fieldRPC.snapshots++; if (data.method === "openQueryCursor") window.fieldRPC.queries++; if (data.method === "dispatchCommitted") window.fieldRPC.writes++; return super.postMessage(data, ...rest); }
    };
  });
  await page.goto("http://127.0.0.1:4181/demo/?paged=1"); await expect(page.getByTestId("project-status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Seed paged rows" }).click(); await expect.poll(() => page.evaluate(() => window.fieldRPC.writes)).toBe(12);
  await expect(page.getByTestId("paged-rows").locator("li")).toHaveCount(3);
  await page.getByRole("button", { name: "Toggle field query" }).click();
  await expect(page.getByTestId("paged-rows").locator("li")).toHaveText(["Paged row 9", "Paged row 3", "Paged row 7"]);
  const queries = await page.evaluate(() => window.fieldRPC.queries); await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.fieldRPC.queries)).toBe(queries);
  await page.getByRole("button", { name: "Change field threshold" }).click();
  await expect(page.getByTestId("paged-rows").locator("li")).toHaveText(["Paged row 9"]); await expect(page.getByTestId("paged-index")).toHaveText("0");
  expect(await page.evaluate(() => window.fieldRPC.snapshots)).toBe(0);
});
