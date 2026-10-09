import { test, expect } from "@playwright/test";

/** Explicitly invoked only; uses synthetic projects and public relay/STUN services. */
test("encrypted public Nostr discovery establishes real WebRTC and live sync", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await Promise.all([a, b].map(p => p.goto(`${test.info().project.use.baseURL}/examples/p2p.html?db=public-discovery`)));
    await Promise.all([a, b].map(p => p.evaluate(() => window.ready)));
    await a.evaluate(() => window.createDemoProject());
    const actor = await b.evaluate(async () => (await window.ready).actorId);
    const { invitation, event } = await a.evaluate(actor => window.db.inviteMember(actor), actor);
    await b.evaluate(i => window.joinDemoProject(i), invitation); await b.evaluate(e => window.db.ingestEvents([e]), event);
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_ADDED", itemId: "public-probe", fields: { text: "synthetic encrypted probe" } }));
    await Promise.all([a, b].map(p => p.evaluate(async () => {
      const { P2PWebRTC } = await import("/dist/index.js"), { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
      window.discovery = new NostrDiscovery(); window.errors = [];
      window.sync = new P2PWebRTC(window.db, { discovery: window.discovery, onError: error => window.errors.push(error.message) });
      await window.sync.start();
    })));
    await Promise.all([a, b].map(p => expect.poll(() => p.evaluate(() => ({ state: window.sync.state, error: window.sync.lastError })), { timeout: 40000 }).toEqual({ state: "online", error: null })));
    await expect.poll(() => b.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("synthetic encrypted probe");
    await b.evaluate(() => window.db.dispatch({ type: "ITEM_UPDATED", itemId: "public-probe", fields: { text: "live through public rendezvous" } }));
    await expect.poll(() => a.evaluate(() => window.db.snapshot().then(s => s.items[0]?.fields.text))).toBe("live through public rendezvous");
    const proof = await a.evaluate(() => ({ stats: window.sync.stats, relay: window.discovery.stats, ice: window.sync.pair.pc.getConfiguration().iceServers, errors: window.errors }));
    expect(proof.relay.published).toBeGreaterThan(0); expect(proof.errors).toEqual([]);
    expect(proof.ice[0].urls).toContain("stun:stun.l.google.com:19302");
    console.log("Public discovery smoke:", JSON.stringify(proof));
    await Promise.all([a, b].map(p => p.evaluate(() => window.sync.stop())));
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
