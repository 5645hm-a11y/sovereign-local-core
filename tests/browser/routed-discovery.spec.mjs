import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

async function connect(page, url) {
  await page.evaluate(async url => {
    const { P2PWebRTC } = await import("/dist/index.js");
    const { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
    window.discovery = new NostrDiscovery({ relays: [url], timeoutMs: 1500,
      routing: { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 300 } });
    window.sync = new P2PWebRTC(window.db, { discovery: window.discovery, iceServers: [], maxPeers: 2,
      helloIntervalMs: 150, connectionTimeoutMs: 8000, reconnectBaseMs: 100 });
    window.db.storage.addPeer(window.sync); await window.sync.start();
  }, url);
}

test("routed discovery establishes real RTC, survives sample rotation, pulls files and reconnects a fresh OPFS instance", async ({ browser }) => {
  test.setTimeout(60000);
  const relay = await startMockNostrRelay(), contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage())), [a, b] = pages;
  try {
    await Promise.all(pages.map(p => p.goto(`${test.info().project.use.baseURL}/examples/p2p.html?db=routed-replica`)));
    await Promise.all(pages.map(p => p.evaluate(() => window.ready)));
    await a.evaluate(() => window.createDemoProject());
    const actor = await b.evaluate(async () => (await window.ready).actorId);
    const { invitation, event } = await a.evaluate(actor => window.db.inviteMember(actor), actor);
    await b.evaluate(i => window.joinDemoProject(i), invitation); await b.evaluate(e => window.db.ingestEvents([e]), event);
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_ADDED", itemId: "routed", fields: { text: "before discovery" } }));
    const topic = await a.evaluate(() => window.db.getDiscoveryInfo().then(i => i.topic));
    await Promise.all([connect(a, `${relay.url}/a`), connect(b, `${relay.url}/b`)]);
    const online = () => Promise.all(pages.map(p => expect.poll(() => p.evaluate(() => window.sync.state), { timeout: 15000 }).toBe("online")));
    await online();
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("before discovery");
    await expect.poll(() => relay.requests.filter(r => r.address === "/b").length).toBeGreaterThan(3);
    expect(relay.activeSubscriptions).toBe(4);
    expect(relay.events.every(e => !e.tags.some(t => t[1] === topic) && !JSON.stringify(e).includes("a=fingerprint"))).toBe(true);
    expect(relay.requests.every(r => r.topics.length === 2 && !r.topics.includes(topic))).toBe(true);
    const receivedEvent = relay.events.find(e => relay.deliveries.some(d => d.id === e.id && d.address === "/b"));
    const rejected = await b.evaluate(() => window.sync.discoveryStats.rejected);
    // Even bypassing the outer routing adapter cannot bypass the Worker's replay gate.
    await b.evaluate(content => {
      const raw = atob(content.replace(/-/g, "+").replace(/_/g, "/"));
      window.discovery.receiver(Uint8Array.from(raw, c => c.charCodeAt(0)));
    }, receivedEvent.content);
    await expect.poll(() => b.evaluate(() => window.sync.discoveryStats.rejected)).toBeGreaterThan(rejected);
    const file = await a.evaluate(async () => {
      const bytes = Uint8Array.from({ length: 1048576 + 19 }, (_, i) => i % 251);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(",");
      const { manifest } = await window.db.storage.upload(new File([bytes], "routed.bin")); return { id: manifest.fileId, digest };
    });
    await expect.poll(() => b.evaluate(id => window.db.snapshot().then(s => s.items.some(i => i.id === id)), file.id)).toBe(true);
    expect(await b.evaluate(() => window.sync.stats.chunksRequested)).toBe(0);
    const digest = await b.evaluate(async id => {
      const blob = await window.db.storage.readBlob(id);
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].join(",");
    }, file.id);
    expect(digest).toBe(file.digest);
    const oldInbox = relay.requests.find(r => r.address === "/b").topics[0];
    await b.reload(); await b.evaluate(() => window.ready); await connect(b, `${relay.url}/b`); await online();
    const newInbox = await b.evaluate(() => window.discovery.directory.inbox);
    expect(newInbox).not.toBe(oldInbox);
    expect(relay.requests.some(r => r.address === "/b" && r.topics.includes(newInbox))).toBe(true);
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "routed", fields: { text: "after new inbox" } }));
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "routed")?.fields.text))).toBe("after new inbox");
    relay.disconnect();
    await b.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "routed", fields: { text: "RTC during relay outage" } }));
    await expect.poll(() => a.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "routed")?.fields.text))).toBe("RTC during relay outage");
    await Promise.all(pages.map(p => p.evaluate(() => window.sync.stop())));
    await expect.poll(() => relay.activeSubscriptions).toBe(0);
    expect(relay.errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); await relay.close(); }
});
