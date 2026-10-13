import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

for (const routed of [false, true]) test(`six real wallets bridge saturated components and repair a stopped peer (${routed ? "routed" : "legacy"} discovery)`, async ({ browser }) => {
  test.setTimeout(90000);
  const contexts = await Promise.all(Array.from({ length: 6 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  let partitioned = true;
  const relay = await startMockNostrRelay({ route: (source, target) => !partitioned || source === target });
  try {
    await Promise.all(pages.map(p => p.goto(`${test.info().project.use.baseURL}/examples/p2p.html?db=sparse-overlay`)));
    await Promise.all(pages.map(p => p.evaluate(() => window.ready)));
    const actors = await Promise.all(pages.map(p => p.evaluate(async () => (await window.ready).actorId)));
    await pages[0].evaluate(() => window.createDemoProject());
    for (let i = 1; i < pages.length; i++) {
      const { invitation, event } = await pages[0].evaluate(actor => window.db.inviteMember(actor), actors[i]);
      await pages[i].evaluate(i => window.joinDemoProject(i), invitation);
      await pages[i].evaluate(e => window.db.ingestEvents([e]), event);
    }
    await Promise.all(pages.map((p, index) => p.evaluate(async ({ url, routed }) => {
      const { P2PWebRTC } = await import("/dist/index.js");
      const { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
      const provider = new NostrDiscovery({ relays: [url], timeoutMs: 1500,
        ...(routed ? { routing: { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 600 } } : {}) });
      window.sync = new P2PWebRTC(window.db, { discovery: provider, iceServers: [], maxPeers: 2, maxCandidates: 16,
        helloIntervalMs: 500, rotationIntervalMs: 2000, minPeerLifetimeMs: 2000, rotationIdleMs: 200,
        connectionTimeoutMs: 8000, reconnectBaseMs: 100, onError: e => window.syncErrors.push(e.message) });
      window.maxDegree = 0;
      window.degreeTimer = setInterval(() => { window.maxDegree = Math.max(window.maxDegree, window.sync.peers.length); }, 10);
      await window.sync.start();
    }, { url: `${relay.url}?group=${Math.floor(index / 3)}`, routed })));
    const degrees = () => Promise.all(pages.map(p => p.evaluate(() => window.sync.peers.filter(p => p.state === "online").length)));
    await expect.poll(degrees, { timeout: 25000 }).toEqual([2, 2, 2, 2, 2, 2]);
    await pages[0].evaluate(() => window.db.dispatch({ type: "ITEM_ADDED", itemId: "west", fields: { text: "first component" } }));
    await pages[3].evaluate(() => window.db.dispatch({ type: "ITEM_ADDED", itemId: "east", fields: { text: "second component" } }));
    const ids = p => p.evaluate(() => window.db.snapshot().then(s => s.items.map(i => i.id).sort()));
    await expect.poll(() => ids(pages[2])).toEqual(["west"]);
    await expect.poll(() => ids(pages[5])).toEqual(["east"]);
    partitioned = false;
    await expect.poll(async () => Promise.all(pages.map(ids)), { timeout: 30000 }).toEqual(Array.from({ length: 6 }, () => ["east", "west"]));
    const rotations = await Promise.all(pages.map(p => p.evaluate(() => window.sync.topologyStats.rotations)));
    expect(rotations.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    await pages[0].evaluate(() => window.sync.stop());
    await pages[4].evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "west", fields: { text: "after peer failure" } }));
    await expect.poll(async () => Promise.all(pages.slice(1).map(p => p.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "west")?.fields.text)))), { timeout: 30000 })
      .toEqual(Array(5).fill("after peer failure"));
    for (const page of pages) {
      expect(await page.evaluate(() => window.maxDegree)).toBeLessThanOrEqual(2);
      expect(await page.evaluate(() => window.sync.candidateCount)).toBeLessThanOrEqual(16);
      await page.evaluate(() => { clearInterval(window.degreeTimer); window.sync.stop(); });
      expect(await page.evaluate(() => [window.sync.peers.length, window.sync.candidateCount, window.sync.state])).toEqual([0, 0, "stopped"]);
    }
  } finally {
    const diagnostics = await Promise.all(pages.map(p => p.evaluate(() => window.sync ? ({
      state: window.sync.state, error: window.sync.lastError, candidates: window.sync.candidateCount,
      id: window.sync.peerId, discovery: window.sync.discoveryStats, errors: window.syncErrors.slice(-10),
      stats: window.sync.topologyStats, peers: [...window.sync.pairs.values()].map(p => ({
        remote: p.remote, state: p.sync?.state, rtc: p.pc?.connectionState, idle: p.sync?.idleForMs,
        onlineAt: p.onlineAt, offerer: p.offerer, proof: !!p.response,
      })),
    }) : null).catch(() => null)));
    await test.info().attach("topology-diagnostics", { body: JSON.stringify(diagnostics, null, 2), contentType: "application/json" });
    if (diagnostics.some(d => d?.state !== "stopped")) console.error(JSON.stringify(diagnostics));
    await Promise.all(contexts.map(c => c.close())); await relay.close();
  }
});
