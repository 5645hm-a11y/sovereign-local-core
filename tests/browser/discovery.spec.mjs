import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

async function projects(browser) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  await Promise.all(pages.map(p => p.goto(`${test.info().project.use.baseURL}/examples/p2p.html?db=discovery-replica`)));
  await Promise.all(pages.map(p => p.evaluate(() => window.ready)));
  const [a, b] = pages;
  await a.evaluate(() => window.createDemoProject());
  const actor = await b.evaluate(async () => (await window.ready).actorId);
  const { invitation, event } = await a.evaluate(actor => window.db.inviteMember(actor), actor);
  await b.evaluate(i => window.joinDemoProject(i), invitation); await b.evaluate(e => window.db.ingestEvents([e]), event);
  await a.evaluate(() => window.db.dispatch({ type: "ITEM_ADDED", itemId: "initial", fields: { text: "before connection" } }));
  return { contexts, a, b };
}
async function online(...pages) {
  await Promise.all(pages.map(p => expect.poll(() => p.evaluate(() => ({ state: window.sync.state, error: window.sync.lastError })), { timeout: 15000 }).toEqual({ state: "online", error: null })));
}
async function blindProvider(page, syntheticActors = 0) {
  await page.evaluate(async syntheticActors => {
    const { P2PWebRTC } = await import("/dist/index.js");
    const provider = {
      async start(topic, receive) { window.receivePacket = receive; await window.registerTopic(topic); },
      async publish(packet) { await window.blindPublish([...packet]); },
      stop() { window.receivePacket = null; },
    };
    let core = window.db;
    if (syntheticActors) {
      const { toBase64Url } = await import("/dist/crypto-codec.js");
      // Synthetic frontier hints are NOT project members or signing identities.
      // Real Workers still verify every transferred event and persist to OPFS.
      const hints = {};
      for (let i = 1; i <= syntheticActors; i++) {
        const bytes = new Uint8Array(65); bytes[0] = 4; new DataView(bytes.buffer).setUint32(61, i);
        hints[`p256_${toBase64Url(bytes)}`] = 0;
      }
      core = {
        getSyncSummary: async () => ({ ...await window.db.getSyncSummary(), ...hints }),
        readMissingEvents: s => window.db.readMissingEvents(s), readMissingEventsPaged: s => window.db.readMissingEventsPaged(s),
        openSyncCursor: s => window.db.openSyncCursor(s), readSyncCursor: id => window.db.readSyncCursor(id), closeSyncCursor: id => window.db.closeSyncCursor(id),
        ingestEvents: e => window.db.ingestEvents(e), onCommit: fn => window.db.onCommit(fn),
        getDiscoveryInfo: () => window.db.getDiscoveryInfo(), sealDiscovery: s => window.db.sealDiscovery(s), openDiscovery: p => window.db.openDiscovery(p),
      };
    }
    window.sync = new P2PWebRTC(core, { discovery: provider, iceServers: [], helloIntervalMs: 150, reconnectBaseMs: 100, connectionTimeoutMs: 6000 });
    window.db.storage.addPeer(window.sync); await window.sync.start();
  }, syntheticActors);
}

test("10k synthetic frontier hints cross real DataChannels; Workers validate events, flush OPFS and recover", async ({ browser }) => {
  test.setTimeout(60000);
  const { contexts, a, b } = await projects(browser), topics = new Map();
  try {
    for (const page of [a, b]) {
      await page.exposeFunction("registerTopic", topic => topics.set(page, topic));
      await page.exposeFunction("blindPublish", async bytes => {
        const other = page === a ? b : a;
        if (topics.get(page) === topics.get(other)) await other.evaluate(bytes => window.receivePacket?.(new Uint8Array(bytes)), bytes);
      });
    }
    await Promise.all([blindProvider(a, 10000), blindProvider(b)]); await online(a, b);
    expect(await b.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("before connection");
    expect(await a.evaluate(() => window.sync.stats.eventsSent)).toBe(1);
    await b.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "initial", fields: { text: "paged live edit" } }));
    await expect.poll(() => a.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("paged live edit");
    await b.reload(); await b.evaluate(() => window.ready);
    expect(await b.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("paged live edit");
    await blindProvider(b); await online(a, b);
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "initial", fields: { text: "paged after reload" } }));
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("paged after reload");
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test("two real Workers and DataChannels discover via a blind provider, reject replay/tamper and recover after reload", async ({ browser }) => {
  test.setTimeout(60000);
  const { contexts, a, b } = await projects(browser), captures = [], topics = new Map();
  try {
    for (const page of [a, b]) {
      await page.exposeFunction("registerTopic", topic => { topics.set(page, topic); });
      await page.exposeFunction("blindPublish", async bytes => {
        captures.push({ page, bytes });
        const other = page === a ? b : a;
        if (topics.get(page) === topics.get(other)) await other.evaluate(bytes => window.receivePacket?.(new Uint8Array(bytes)), bytes);
      });
    }
    await Promise.all([blindProvider(a), blindProvider(b)]); await online(a, b);
    expect(topics.get(a)).toBe(topics.get(b)); expect(topics.get(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(captures.every(c => !new TextDecoder().decode(new Uint8Array(c.bytes)).includes("a=fingerprint"))).toBe(true);
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("before connection");
    await b.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "initial", fields: { text: "live from the other peer" } }));
    await expect.poll(() => a.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("live from the other peer");
    const before = await b.evaluate(() => window.sync.discoveryStats.rejected);
    const packet = captures.find(c => c.page === a).bytes;
    await b.evaluate(bytes => window.receivePacket(new Uint8Array(bytes)), packet);
    const tampered = [...packet]; tampered[tampered.length - 1] ^= 1;
    await b.evaluate(bytes => window.receivePacket(new Uint8Array(bytes)), tampered);
    await expect.poll(() => b.evaluate(() => window.sync.discoveryStats.rejected)).toBeGreaterThanOrEqual(before + 2);
    await online(a, b);
    const file = await a.evaluate(async () => {
      const bytes = Uint8Array.from({ length: 1048576 + 733 }, (_, i) => i % 251);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(",");
      const { manifest } = await window.db.storage.upload(new File([bytes], "pulled.bin")); return { id: manifest.fileId, digest };
    });
    await expect.poll(() => b.evaluate(id => window.db.snapshot().then(s => s.items.some(i => i.id === id)), file.id)).toBe(true);
    expect(await b.evaluate(() => window.sync.stats.chunksRequested)).toBe(0);
    const digest = await b.evaluate(async id => {
      const blob = await window.db.storage.readBlob(id); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].join(",");
    }, file.id);
    expect(digest).toBe(file.digest);
    await b.reload(); await b.evaluate(() => window.ready); await blindProvider(b); await online(a, b);
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "initial", fields: { text: "after reconnect" } }));
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "initial")?.fields.text))).toBe("after reconnect");
    await Promise.all([a, b].map(p => p.evaluate(() => { window.sync.stop(); })));
    expect(await a.evaluate(() => window.sync.state)).toBe("stopped");
    // A fresh Worker has an empty nonce cache. Old directed SDP still cannot
    // satisfy its new instance ID and fresh mutual challenge.
    const history = captures.filter(c => c.page === a).map(c => c.bytes);
    await b.reload(); await b.evaluate(() => window.ready); await blindProvider(b);
    for (const bytes of history) await b.evaluate(bytes => window.receivePacket?.(new Uint8Array(bytes)), bytes);
    await b.waitForTimeout(300);
    expect(await b.evaluate(() => window.sync.pair?.pc == null)).toBe(true);
    expect(await b.evaluate(() => window.sync.state)).not.toBe("online");
    await b.evaluate(() => window.sync.stop());
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test("Nostr adapter routes only encrypted SDP/ICE through a blind WebSocket relay and keeps RTC alive during relay loss", async ({ browser }) => {
  test.setTimeout(60000);
  const relay = await startMockNostrRelay(), { contexts, a, b } = await projects(browser);
  try {
    await Promise.all([a, b].map((p, index) => p.evaluate(async ({ url, fixed }) => {
      const { P2PWebRTC } = await import("/dist/index.js");
      const { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
      window.discovery = new NostrDiscovery({ relays: [url], timeoutMs: 1500 });
      window.sync = new P2PWebRTC(window.db, { discovery: window.discovery, iceServers: [], helloIntervalMs: 150,
        ...(fixed ? { topology: "fixed" } : {}) });
      await window.sync.start();
    }, { url: relay.url, fixed: index === 1 })));
    await online(a, b);
    expect(relay.events.length).toBeGreaterThan(5);
    expect(relay.events.every(e => e.kind === 20000 && /^[0-9a-f]{128}$/.test(e.sig))).toBe(true);
    expect(relay.events.every(e => !JSON.stringify(e).includes("a=fingerprint") && !JSON.stringify(e).includes("p256_"))).toBe(true);
    relay.broadcast(relay.events[0]);
    await a.waitForTimeout(100); await online(a, b);
    relay.disconnect();
    await b.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "initial", fields: { text: "DataChannel survives relay outage" } }));
    await expect.poll(() => a.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("DataChannel survives relay outage");
    await Promise.all([a, b].map(p => p.evaluate(() => window.sync.stop())));
    expect(relay.errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); await relay.close(); }
});
