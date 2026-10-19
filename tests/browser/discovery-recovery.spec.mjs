import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

async function setup(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const actors = {};
    for (const name of ["root", "revoked", "hub", "cold"]) {
      const db = new LocalCoreClient(), options = { mode: "wallet", walletId: `recovery-${name}`,
        passphrase: "synthetic-recovery-passphrase", projectId: "browser-discovery-recovery" };
      actors[name] = { db, options };
      if (name === "root") await db.createProject(`recovery-${name}`, options);
      else {
        const id = (await db.identify(options)).actorId;
        const grant = await actors.root.db.inviteMember(id);
        await db.open(`recovery-${name}`, { ...options, invitation: grant.invitation });
      }
    }
    const events = await actors.root.db.readEvents();
    for (const name of ["revoked", "hub", "cold"]) await actors[name].db.ingestEvents(events);
    window.recoveryLab = actors;
  });
}
async function connect(page, url, names, { recovery = true, routed = true, recoveryRouted = false } = {}) {
  await page.evaluate(async ({ url, names, recovery, routed, recoveryRouted }) => {
    const { P2PWebRTC } = await import("/dist/p2p-webrtc.js");
    const { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
    for (const name of names) {
      const actor = window.recoveryLab[name];
      actor.discovery = new NostrDiscovery({ relays: [`${url}/${name}`], timeoutMs: 2000,
        ...(routed ? { routing: { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 150 } } : {}) });
      actor.recovery = recovery ? new NostrDiscovery({ relays: [`${url}/${name}-recovery`], timeoutMs: 2000,
        ...(recoveryRouted ? { routing: { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 150 } } : {}) }) : null;
      actor.errors = [];
      actor.network = new P2PWebRTC(actor.db, { discovery: actor.discovery, iceServers: [], maxPeers: 3,
        helloIntervalMs: 150, reconnectBaseMs: 100, connectionTimeoutMs: 10000,
        // The live-only relay stores no missed probes. Match the accelerated 150ms
        // directory rotation with enough probe opportunities in the 30s assertion;
        // a 3s response budget allowed unlucky sampled buckets to miss the window.
        ...(recovery ? { recovery: { discovery: actor.recovery, intervalMs: 1000, responseTimeoutMs: 1000, transferTimeoutMs: 30000 } } : {}),
        onError: error => actor.errors.push(error.name) });
      actor.db.storage.addPeer(actor.network); await actor.network.start();
    }
  }, { url, names, recovery, routed, recoveryRouted });
}
async function cleanup(page) {
  await page.evaluate(async () => {
    for (const actor of Object.values(window.recoveryLab ?? {})) { actor.network?.stop(); await actor.db.close().catch(() => {}); }
  }).catch(() => {});
}

for (const recoveryRouted of [false, true]) for (const pending of [false, true]) test(`Root-offline ${pending ? "partial-manifest" : "cold-old-epoch"} ${recoveryRouted ? "routed" : "broadcast"} recovery through a Member restores Nostr/RTC sync, files and OPFS restart`, async ({ page }) => {
  test.setTimeout(60000); const relay = await startMockNostrRelay();
  try {
    await setup(page);
    const before = await page.evaluate(() => window.recoveryLab.cold.db.getDiscoveryInfo());
    const data = await page.evaluate(async pending => {
      const a = window.recoveryLab, revokedId = (await a.revoked.db.getProjectInfo()).certificate.subject;
      const result = await a.root.db.revokeMember(revokedId, { paged: true });
      const controls = await a.root.db.readEvents(); await a.hub.db.ingestEvents(controls);
      if (pending) await a.cold.db.ingestEvents([result.event]);
      await a.root.db.close();
      await a.hub.db.dispatch({ type: "ITEM_ADDED", itemId: "after-rotation", fields: { text: "Root is offline" } });
      const { manifest } = await a.hub.db.storage.upload(new File(["recovered lazy file"], "recovered.txt"));
      return { fileId: manifest.fileId, keyId: (await a.hub.db.getDiscoveryInfo()).keyId };
    }, pending);
    await connect(page, relay.url, ["hub", "cold"], { recoveryRouted });
    await expect.poll(() => page.evaluate(() => window.recoveryLab.cold.network.recoveryStats.completed), { timeout: 30000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.recoveryLab.cold.network.state), { timeout: 20000 }).toBe("online");
    expect(await page.evaluate(() => window.recoveryLab.cold.db.getDiscoveryInfo().then(i => i.keyId))).toBe(data.keyId);
    expect(data.keyId).not.toBe(before.keyId);
    await expect.poll(() => page.evaluate(() => window.recoveryLab.cold.db.snapshot().then(s => s.items.find(i => i.id === "after-rotation")?.fields.text))).toBe("Root is offline");
    expect(await page.evaluate(async fileId => (await window.recoveryLab.cold.db.storage.readBlob(fileId)).text(), data.fileId)).toBe("recovered lazy file");
    if (recoveryRouted) {
      const addresses = await page.evaluate(async () => {
        const { DiscoveryRouting } = await import("/dist/discovery-routing.js");
        return Promise.all(["hub", "cold"].map(async name => {
          const info = await window.recoveryLab[name].db.getDiscoveryRecoveryInfo();
          const d = await DiscoveryRouting.create(info.topic, info.instanceId, { bucketCount: 8, sampleBuckets: 2, rotationIntervalMs: 150 });
          return { inbox: d.inbox, topic: info.topic };
        }));
      });
      const recoveryRequests = relay.requests.filter(r => r.address.endsWith("-recovery"));
      expect(recoveryRequests.every(r => r.topics.length === 2 && !r.topics.includes(addresses[0].topic))).toBe(true);
      for (const address of addresses) expect(relay.events.some(e => e.tags.some(t => t[0] === "t" && t[1] === address.inbox))).toBe(true);
    }
    // A stale revoked wallet knows the recovery topic but receives no new-key grant.
    const denials = await page.evaluate(() => ["hub", "cold"].map(name => window.recoveryLab[name].errors.filter(e => e === "AuthorizationError").length));
    await connect(page, relay.url, ["revoked"], { recoveryRouted });
    // Routed sampling can reach either current Member; require a fresh denial, not a fixed responder.
    await expect.poll(() => page.evaluate(before => ["hub", "cold"].some((name, i) =>
      window.recoveryLab[name].errors.filter(e => e === "AuthorizationError").length > before[i]), denials), { timeout: 10000 }).toBe(true);
    expect(await page.evaluate(() => window.recoveryLab.revoked.network.recoveryStats.completed)).toBe(0);
    expect(await page.evaluate(() => window.recoveryLab.revoked.db.getDiscoveryInfo().then(i => i.keyId))).toBe(before.keyId);
    expect(await page.evaluate(() => window.recoveryLab.revoked.db.snapshot().then(s => s.items.some(i => i.id === "after-rotation")))).toBe(false);
    const reopened = await page.evaluate(async () => {
      const { LocalCoreClient } = await import("/dist/client.js"); const a = window.recoveryLab.cold;
      a.network.stop(); await a.db.close(); a.db = new LocalCoreClient(); await a.db.open("recovery-cold", a.options);
      return { key: (await a.db.getDiscoveryInfo()).keyId, pending: (await a.db.getProjectInfo()).pendingEpochs };
    });
    expect(reopened).toEqual({ key: data.keyId, pending: [] });
    const recoveryEvents = relay.events.filter(e => relay.deliveries.some(d => d.id === e.id && d.address.endsWith("-recovery")));
    expect(recoveryEvents.length).toBeGreaterThan(0);
    expect(recoveryEvents.every(e => e.content.length < 45000 && !JSON.stringify(e).includes("a=fingerprint"))).toBe(true);
    await cleanup(page); await expect.poll(() => relay.activeSubscriptions).toBe(0);
  } finally { await cleanup(page); await relay.close(); }
});

test("live rekeying rebinds the relay, closes a revoked edge and preserves the authorized RTC edge without recovery enabled", async ({ page }) => {
  test.setTimeout(60000); const relay = await startMockNostrRelay();
  try {
    await setup(page); await connect(page, relay.url, ["root", "hub", "revoked"], { recovery: false, routed: false });
    await expect.poll(() => page.evaluate(() => window.recoveryLab.root.network.peers.filter(p => p.state === "online").length), { timeout: 20000 }).toBe(2);
    const before = await page.evaluate(() => {
      const a = window.recoveryLab;
      // Find exact actor through project info instead of relying on any public client property.
      return a.hub.db.getProjectInfo().then(info => {
        const actual = [...a.root.network.pairs.values()].find(p => p.actor === info.certificate.subject);
        window.keptChannel = actual.channel; return { actorId: info.certificate.subject, topic: a.root.discovery.topic };
      });
    });
    const target = await page.evaluate(() => window.recoveryLab.revoked.db.getProjectInfo().then(i => i.certificate.subject));
    await page.evaluate(async target => { const a = window.recoveryLab; await a.root.db.revokeMember(target, { paged: true });
      await a.root.db.dispatch({ type: "ITEM_ADDED", itemId: "live-new-key", fields: { text: "kept edge" } }); }, target);
    await expect.poll(() => page.evaluate(target => window.recoveryLab.root.network.peers.some(p => p.actorId === target), target)).toBe(false);
    await expect.poll(() => page.evaluate(() => window.recoveryLab.hub.db.snapshot().then(s => s.items.find(i => i.id === "live-new-key")?.fields.text)), { timeout: 15000 }).toBe("kept edge");
    const after = await page.evaluate(async actorId => {
      const a = window.recoveryLab, edge = [...a.root.network.pairs.values()].find(p => p.actor === actorId);
      return { channelSame: edge?.channel === window.keptChannel, topic: a.root.discovery.topic,
        key: (await a.root.db.getDiscoveryInfo()).keyId, peerKey: (await a.hub.db.getDiscoveryInfo()).keyId };
    }, before.actorId);
    expect(after.channelSame).toBe(true); expect(after.topic).not.toBe(before.topic); expect(after.key).toBe(after.peerKey);
    expect(relay.requests.some(r => r.address === "/root" && r.topics.includes(after.topic))).toBe(true);
    expect(relay.requests.some(r => r.address === "/hub" && r.topics.includes(after.topic))).toBe(true);
  } finally { await cleanup(page); await relay.close(); }
});
