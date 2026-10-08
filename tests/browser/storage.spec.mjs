import { test, expect } from "@playwright/test";
import { startSignalingServer } from "../../scripts/signaling-server.mjs";
import { readFile } from "node:fs/promises";

test("real WebRTC pulls encrypted OPFS chunks only on demand, returns exact Blob, and reopens cached data offline", async ({ browser }) => {
  test.setTimeout(60000);
  const signaling = await startSignalingServer({ port: 0 });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await Promise.all([a, b].map(p => p.goto(`${test.info().project.use.baseURL}/examples/p2p.html?db=storage-replica`)));
    await Promise.all([a, b].map(p => p.evaluate(() => window.ready)));
    await a.evaluate(() => window.createDemoProject());
    const actor = await b.evaluate(async () => (await window.ready).actorId);
    const { invitation, event } = await a.evaluate(actor => window.db.inviteMember(actor), actor);
    await b.evaluate(i => window.joinDemoProject(i), invitation); await b.evaluate(e => window.db.ingestEvents([e]), event);
    const room = crypto.randomUUID();
    await Promise.all([a, b].map(p => p.evaluate(({ room, url }) => window.connectP2P(room, url), { room, url: signaling.url })));
    await Promise.all([a, b].map(p => expect.poll(() => p.evaluate(() => ({ state: window.sync.state, error: window.sync.lastError })), { timeout: 15000 }).toEqual({ state: "online", error: null })));
    const uploaded = await a.evaluate(async () => {
      const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 733 }, (_, i) => i % 251);
      bytes.set(new TextEncoder().encode("STORAGE_SECRET_NEVER_ON_DISK_918"));
      const hex = b => [...new Uint8Array(b)].map(n => n.toString(16).padStart(2, "0")).join("");
      const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
      const result = await window.db.storage.upload(new File([bytes], "קובץ.bin", { type: "application/octet-stream" }));
      window.uploadedManifest = result.manifest;
      const { projectId } = (await window.db.getProjectInfo()).descriptor;
      const ns = await (await navigator.storage.getDirectory()).getDirectoryHandle("sovereign-local-core");
      const db = await ns.getDirectoryHandle("storage-replica-v3"), blobs = await (await db.getDirectoryHandle(projectId)).getDirectoryHandle("blobs");
      const lengths = []; let privateBytes = true;
      for (const hash of result.manifest.chunks) {
        const file = await (await blobs.getFileHandle(hash)).getFile(), raw = new Uint8Array(await file.arrayBuffer()); lengths.push(raw.length);
        privateBytes &&= !new TextDecoder().decode(raw).includes("STORAGE_SECRET_NEVER_ON_DISK_918");
      }
      const log = await (await db.getFileHandle("events.slc")).getFile();
      return { manifest: result.manifest, digest, privateBytes, lengths, logBytes: log.size, eventType: result.event.type };
    });
    await expect.poll(() => b.evaluate(id => window.db.snapshot().then(s => s.items.some(i => i.id === id)), uploaded.manifest.fileId)).toBe(true);
    expect(uploaded.manifest.chunks).toHaveLength(3); expect(uploaded.lengths).toEqual([1048616, 1048616, 773]);
    expect(uploaded.privateBytes).toBe(true); expect(uploaded.logBytes).toBeLessThan(50000); expect(uploaded.eventType).toBe("FILE_ADDED");
    const before = await b.evaluate(async () => {
      const { projectId } = (await window.db.getProjectInfo()).descriptor;
      const db = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("sovereign-local-core")).getDirectoryHandle("storage-replica-v3");
      const blobs = await (await db.getDirectoryHandle(projectId)).getDirectoryHandle("blobs"); let count = 0;
      for await (const _ of blobs.keys()) count++;
      return { count, requested: window.sync.stats.chunksRequested };
    });
    expect(before).toEqual({ count: 0, requested: 0 });
    const received = await b.evaluate(async id => {
      window.db.storage.addPeer(window.sync);
      const blob = await window.db.storage.readBlob(id);
      const bytes = await blob.arrayBuffer(), digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
      return { digest, size: blob.size, type: blob.type, chunks: window.sync.stats.chunksRequested };
    }, uploaded.manifest.fileId);
    expect(received).toEqual({ digest: uploaded.digest, size: uploaded.manifest.size, type: uploaded.manifest.mime, chunks: 3 });
    await b.evaluate(async () => { window.sync.stop(); await window.db.close(); });
    const offline = await b.evaluate(async id => {
      const { LocalCoreClient } = await import("/dist/client.js");
      const reopened = new LocalCoreClient();
      await reopened.open("storage-replica-v3", window.demoCredentials);
      try {
        const blob = await reopened.storage.readBlob(id);
        return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, "0")).join("");
      } finally { await reopened.close(); }
    }, uploaded.manifest.fileId);
    expect(offline).toBe(uploaded.digest);
  } finally { await Promise.all(contexts.map(c => c.close())); await signaling.close(); }
});

test("mock DataChannel plus real Workers/OPFS preserves streaming chunk order and rejects corrupt ciphertext", async ({ page }) => {
  await page.goto("/"); await page.evaluate(() => window.ready);
  const mockSource = await readFile(new URL("../helpers/mock-data-channel.mjs", import.meta.url), "utf8");
  const result = await page.evaluate(async mockSource => {
    const { LocalCoreClient, P2PSync } = await import("/dist/index.js");
    const moduleUrl = URL.createObjectURL(new Blob([mockSource], { type: "text/javascript" }));
    const { mockChannelPair } = await import(moduleUrl); URL.revokeObjectURL(moduleUrl);
    const projectId = "storage-mock-project", a = new LocalCoreClient(), b = new LocalCoreClient();
    const options = email => ({ email, password: "storage-mock-password-2026", projectId });
    const [channelA, channelB] = mockChannelPair(); let syncA, syncB;
    try {
      await a.createProject("storage-mock-a", options("storage-mock-a@example.test"));
      const { actorId } = await b.identify(options("storage-mock-b@example.test")), { invitation, event } = await a.inviteMember(actorId);
      await b.open("storage-mock-b", { ...options("storage-mock-b@example.test"), invitation }); await b.ingestEvents([event]);
      const config = { roomId: crypto.randomUUID(), signalingUrl: "ws://unused.invalid" };
      syncA = new P2PSync(a, config); syncB = new P2PSync(b, config);
      syncA.connectDataChannel(channelA); syncB.connectDataChannel(channelB);
      const end = Date.now() + 5000; while (syncA.state !== "online" || syncB.state !== "online") { if (Date.now() > end) throw new Error("Mock handshake timeout"); await new Promise(r => setTimeout(r, 5)); }
      const text = "מסמך מוצפן 🚀 ".repeat(10000), { manifest, event: added } = await a.storage.upload(new Blob([text], { type: "text/plain" }), { name: "doc.txt", chunkSize: 65536 });
      await b.ingestEvents([added]);
      const request = await b.createChunkRequest(manifest.fileId, 0), corrupt = await a.serveChunk(request); corrupt[corrupt.length - 1] ^= 1;
      let rejected = false; try { await b.acceptFileChunk(manifest.fileId, 0, corrupt); } catch { rejected = true; }
      b.storage.addPeer(syncB); const blob = await b.storage.readBlob(manifest.fileId);
      return { rejected, equal: await blob.text() === text, chunks: manifest.chunks.length, requested: syncB.stats.chunksRequested, maximumFrame: channelA.maximumFrame };
    } finally { syncA?.stop(); syncB?.stop(); await Promise.all([a.close(), b.close()]); }
  }, mockSource);
  expect(result.rejected && result.equal).toBe(true); expect(result.requested).toBe(result.chunks); expect(result.maximumFrame).toBeLessThanOrEqual(16384);
});

test("256 MiB virtual file streams through encrypted OPFS and mocked P2P without whole-file reads or assembly", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/"); await page.evaluate(() => window.ready);
  const mockSource = await readFile(new URL("../helpers/mock-data-channel.mjs", import.meta.url), "utf8");
  const result = await page.evaluate(async mockSource => {
    const { LocalCoreClient, P2PSync } = await import("/dist/index.js");
    const mockUrl = URL.createObjectURL(new Blob([mockSource], { type: "text/javascript" }));
    const { mockChannelPair } = await import(mockUrl); URL.revokeObjectURL(mockUrl);
    // Virtual File lives in the producing Worker: cloning a Blob subclass would discard its overrides.
    const origin = location.origin, workerSource = `
      import { LocalCore } from ${JSON.stringify(`${origin}/dist/engine.js`)};
      import { openOPFSStore } from ${JSON.stringify(`${origin}/dist/opfs.js`)};
      import { ProjectContext } from ${JSON.stringify(`${origin}/dist/project.js`)};
      import { openIdentityVault } from ${JSON.stringify(`${origin}/dist/identity-storage.js`)};
      import { StorageEngine, CHUNK_BYTES } from ${JSON.stringify(`${origin}/dist/storage.js`)};
      import { OPFSBlobStore } from ${JSON.stringify(`${origin}/dist/blob-store.js`)};
      let core, files, queue = Promise.resolve(), largestSlice = 0;
      class VirtualFile extends Blob {
        get size() { return 256 * CHUNK_BYTES + 137; }
        arrayBuffer() { throw new Error("Whole virtual file read forbidden"); }
        stream() { throw new Error("Only bounded slice streams allowed"); }
        slice(start, end) {
          largestSlice = Math.max(largestSlice, end - start);
          if (end - start > CHUNK_BYTES) throw new Error("Unbounded producer allocation");
          return new Blob([new Uint8Array(end - start).fill(Math.floor(start / CHUNK_BYTES) % 251)]);
        }
      }
      onmessage = ({ data: r }) => {
        queue = queue.then(async () => {
          try {
            let result;
            if (r.method === "init") {
              const identity = await openIdentityVault({ email: "storage-virtual-source@example.test", password: "virtual-storage-password-2026" });
              const project = await ProjectContext.create(identity, r.projectId);
              core = await LocalCore.open(await openOPFSStore("storage-virtual-source", identity.actorId, r.projectId, project), identity, project);
              files = new StorageEngine(core, await OPFSBlobStore.open("storage-virtual-source", r.projectId));
              core.onCommit(n => postMessage({ kind: "commit", ...n })); result = null;
            } else if (r.method === "upload") {
              const uploaded = await files.upload(new VirtualFile(), { name: "virtual-256mib.bin" });
              result = { manifest: uploaded.manifest, event: uploaded.event, largestSlice };
            } else if (r.method === "serveChunk") result = await files.serveChunk(r.request);
            else if (r.method === "inviteMember") result = await core.inviteMember(r.actorId);
            else if (r.method === "getSyncSummary") result = await core.getSyncSummary();
            else if (r.method === "readMissingEvents") result = await core.readMissingEvents(r.summary);
            else if (r.method === "ingestEvents") result = await core.ingestEvents(r.events);
            else if (r.method === "close") { await core.close(); result = null; }
            else throw new Error("Unknown test worker method");
            postMessage({ id: r.id, result }, result instanceof Uint8Array ? [result.buffer] : []);
          } catch (e) { postMessage({ id: r.id, error: String(e.stack) }); }
        });
      };`;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const source = new Worker(workerUrl, { type: "module" }); URL.revokeObjectURL(workerUrl);
    const pending = new Map(), listeners = new Set(); let id = 0;
    source.onmessage = ({ data }) => {
      if (data.kind === "commit") { for (const listener of listeners) listener(data); return; }
      const waiter = pending.get(data.id); pending.delete(data.id);
      if (data.error) waiter?.reject(new Error(data.error)); else waiter?.resolve(data.result);
    };
    source.onerror = e => { for (const waiter of pending.values()) waiter.reject(new Error(e.message)); pending.clear(); };
    const call = (method, args = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); source.postMessage({ id: requestId, method, ...args }); });
    const sourceCore = {
      getSyncSummary: () => call("getSyncSummary"), readMissingEvents: summary => call("readMissingEvents", { summary }),
      ingestEvents: events => call("ingestEvents", { events }), serveChunk: request => call("serveChunk", { request }),
      onCommit: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const recipient = new LocalCoreClient(); let syncA, syncB;
    const projectId = "storage-virtual-project", chunkBytes = 1024 * 1024;
    try {
      await call("init", { projectId });
      const credentials = { email: "storage-virtual-recipient@example.test", password: "virtual-storage-password-2026", projectId };
      const { actorId } = await recipient.identify(credentials), { invitation, event } = await call("inviteMember", { actorId });
      await recipient.open("storage-virtual-recipient", { ...credentials, invitation }); await recipient.ingestEvents([event]);
      const channels = mockChannelPair(), config = { roomId: crypto.randomUUID(), signalingUrl: "ws://unused.invalid" };
      syncA = new P2PSync(sourceCore, config); syncB = new P2PSync(recipient, config);
      syncA.connectDataChannel(channels[0]); syncB.connectDataChannel(channels[1]);
      const waitUntil = async predicate => { const end = Date.now() + 15000; while (!await predicate()) { if (Date.now() > end) throw new Error(`Condition timeout: ${syncA.lastError} / ${syncB.lastError}`); await new Promise(r => setTimeout(r, 10)); } };
      await waitUntil(() => syncA.state === "online" && syncB.state === "online");
      const published = await call("upload");
      await waitUntil(async () => (await recipient.snapshot()).items.some(i => i.id === published.manifest.fileId));
      const root = await navigator.storage.getDirectory(), ns = await root.getDirectoryHandle("sovereign-local-core");
      const recipientDir = await ns.getDirectoryHandle("storage-virtual-recipient");
      const chunks = await (await recipientDir.getDirectoryHandle(projectId)).getDirectoryHandle("blobs");
      let beforeFiles = 0; for await (const _ of chunks.keys()) beforeFiles++;
      const beforeRequests = syncB.stats.chunksRequested;
      recipient.storage.addPeer(syncB);
      const stream = await recipient.storage.readStream(published.manifest.fileId);
      if (syncB.stats.chunksRequested !== beforeRequests) throw new Error("Opening stream eagerly downloaded data");
      let received = 0, count = 0, largestPlaintext = 0;
      await stream.pipeTo(new WritableStream({ async write(chunk) {
        const expectedLength = Math.min(chunkBytes, published.manifest.size - received), pattern = count % 251;
        if (chunk.length !== expectedLength || !chunk.every(byte => byte === pattern)) throw new Error("Stream chunk order/content mismatch");
        received += chunk.length; count++; largestPlaintext = Math.max(largestPlaintext, chunk.length);
        if (count % 32 === 0) await new Promise(resolve => setTimeout(resolve, 1)); // Consumer backpressure.
      } }, { highWaterMark: 1 }));
      let encryptedBytes = 0, stored = 0;
      for await (const hash of chunks.keys()) { stored++; encryptedBytes += (await (await chunks.getFileHandle(hash)).getFile()).size; }
      const sourceDir = await ns.getDirectoryHandle("storage-virtual-source");
      return { bytes: received, chunks: count, largestPlaintext, largestSlice: published.largestSlice,
        beforeFiles, beforeRequests, requested: syncB.stats.chunksRequested, stored, encryptedBytes,
        sourceLogBytes: (await (await sourceDir.getFileHandle("events.slc")).getFile()).size,
        recipientLogBytes: (await (await recipientDir.getFileHandle("events.slc")).getFile()).size,
        maximumFrame: channels[0].maximumFrame, maximumBuffered: channels[0].maximumBuffered,
        eventType: published.event.type };
    } finally { syncA?.stop(); syncB?.stop(); await Promise.all([call("close"), recipient.close()]); source.terminate(); }
  }, mockSource);
  expect(result.bytes).toBe(256 * 1024 * 1024 + 137); expect(result.chunks).toBe(257);
  expect(result.beforeFiles).toBe(0); expect(result.beforeRequests).toBe(0);
  expect(result.requested).toBe(257); expect(result.stored).toBe(257);
  expect(result.largestSlice).toBe(1048576); expect(result.largestPlaintext).toBe(1048576);
  expect(result.encryptedBytes).toBe(result.bytes + 257 * 40);
  expect(result.sourceLogBytes).toBeLessThan(100000); expect(result.recipientLogBytes).toBeLessThan(100000);
  expect(result.maximumFrame).toBeLessThanOrEqual(16384); expect(result.maximumBuffered).toBeLessThanOrEqual(256 * 1024 + 16384);
  expect(result.eventType).toBe("FILE_ADDED");
});
