import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

const projectId = "wallet-library-test";
function credentials(index) { return { mode: "wallet", walletId: `kiosk_${index}`, passphrase: "synthetic-wallet-passphrase", projectId }; }
async function ready(page) {
  await page.goto(`${test.info().project.use.baseURL}/examples/policy.html`);
  await page.waitForFunction(() => window.clientReady);
}
async function clients(browser, roles, files = false) {
  const contexts = await Promise.all(roles.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  await Promise.all(pages.map(ready));
  const actors = await Promise.all(pages.map((p, i) => p.evaluate(c => window.db.identify(c), credentials(i))));
  await pages[0].evaluate(async ({ credentials, files }) => {
    const { libraryPolicies } = await import("/dist/index.js");
    await window.db.createProject("wallet-library", { ...credentials, policies: { ...libraryPolicies(), defaultAllow: files } });
  }, { credentials: credentials(0), files });
  const invitations = [];
  for (let i = 1; i < pages.length; i++) {
    const { invitation } = await pages[0].evaluate(({ actorId, role }) => window.db.inviteMember(actorId, role), { actorId: actors[i].actorId, role: roles[i] });
    invitations[i] = invitation;
    await pages[i].evaluate(({ identity, invitation }) => window.db.open("wallet-library", { ...identity, invitation }), { identity: credentials(i), invitation });
  }
  await pages[0].evaluate(() => window.db.dispatch({ type: "ITEM_ADDED", itemId: "book_1", fields: { title: "One copy" } }));
  const initial = await pages[0].evaluate(() => window.db.readEvents());
  await Promise.all(pages.slice(1).map(p => p.evaluate(events => window.db.ingestEvents(events), initial)));
  return { contexts, pages, actors, invitations };
}
async function connect(page, url, maxPeers = 8) {
  await page.evaluate(async ({ url, maxPeers }) => {
    const { P2PWebRTC } = await import("/dist/index.js"), { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
    window.syncErrors = []; window.sync = new P2PWebRTC(window.db, {
      discovery: new NostrDiscovery({ relays: [url], timeoutMs: 2000 }), iceServers: [], maxPeers,
      helloIntervalMs: 200, reconnectBaseMs: 100, onError: e => window.syncErrors.push(e.message),
    });
    window.removeStoragePeer = window.db.storage.addPeer(window.sync); await window.sync.start();
  }, { url, maxPeers });
}
async function mesh(pages, count) {
  await Promise.all(pages.map(p => expect.poll(() => p.evaluate(() => window.sync.peers.filter(p => p.state === "online").length), { timeout: 20000 }).toBe(count)));
}

test("Worker/OPFS wallets persist without email; Member DELETE is rejected and policy tampering fails", async ({ browser }) => {
  const { contexts, pages: [a, b], invitations } = await clients(browser, ["Admin", "Member"]);
  try {
    const joinMismatch = await b.evaluate(async ({ identity, invitation }) => {
      const { LocalCoreClient, libraryPolicies } = await import("/dist/index.js");
      await window.db.close(); // One writer per ActorID/project, even across replica names.
      const client = new LocalCoreClient();
      try {
        let error = "";
        try { await client.open("wallet_initial_policy_check", { ...identity, invitation,
          policies: { ...libraryPolicies(), defaultAllow: true } }); }
        catch (e) { error = e.message; }
        // Rejection must leave this database uninitialized, so a trusted retry can succeed.
        await client.open("wallet_initial_policy_check", { ...identity, invitation });
        return error;
      } finally {
        await client.close().catch(() => {});
        window.db = new LocalCoreClient(); await window.db.open("wallet-library", identity);
      }
    }, { identity: credentials(1), invitation: invitations[1] });
    expect(joinMismatch).toContain("Policies conflict");
    const before = await b.evaluate(() => window.db.readEvents().then(e => e.length));
    const result = await b.evaluate(async () => {
      try { await window.db.dispatch({ type: "ITEM_DELETED", itemId: "book_1" }); return "accepted"; }
      catch (e) { return e.name; }
    });
    expect(result).toBe("NativeMergeError"); expect(await b.evaluate(() => window.db.readEvents().then(e => e.length))).toBe(before);
    const actor = await b.evaluate(() => window.db.getProjectInfo().then(i => i.certificate.subject));
    await b.reload(); await b.waitForFunction(() => window.clientReady);
    const opened = await b.evaluate(c => window.db.open("wallet-library", c), credentials(1));
    expect(opened.actorId).toBe(actor); expect(opened.snapshot.items[0].fields.title).toBe("One copy");
    const mismatch = await b.evaluate(async c => {
      await window.db.close(); const { LocalCoreClient, libraryPolicies } = await import("/dist/index.js"); window.db = new LocalCoreClient();
      try { await window.db.open("wallet-library", { ...c, policies: { ...libraryPolicies(), defaultAllow: true } }); return "accepted"; }
      catch (e) { return e.message; }
    }, credentials(1));
    expect(mismatch).toContain("Policies conflict");
    await a.evaluate(() => window.db.dispatch({ type: "ITEM_DELETED", itemId: "book_1" }));
    expect(await a.evaluate(() => window.db.snapshot().then(s => s.items.length))).toBe(0);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});

test("three-peer Nostr/WebRTC mesh reconciles offline checkout, isolates disconnects and serves cached files", async ({ browser }) => {
  test.setTimeout(90000);
  const relay = await startMockNostrRelay(), { contexts, pages, actors } = await clients(browser, ["Admin", "Kiosk", "Kiosk"], true);
  const [a, b, c] = pages;
  try {
    const requests = await Promise.all([b, c].map((p, i) => p.evaluate(borrowerId => window.db.dispatch({ type: "CHECKOUT", itemId: "book_1", fields: { borrowerId } }), `reader_${i}`)));
    expect(requests[0].snapshot.items[0].fields.loanId).toBe(requests[0].event.id);
    expect(requests[1].snapshot.items[0].fields.loanId).toBe(requests[1].event.id);
    // A/B first connect; C joins a mesh whose existing peers are already online.
    await Promise.all([connect(a, relay.url), connect(b, relay.url)]); await mesh([a, b], 1);
    await connect(c, relay.url); await mesh(pages, 2);
    const winner = actors[1].actorId < actors[2].actorId ? requests[0].event.id : requests[1].event.id;
    await Promise.all(pages.map(p => expect.poll(() => p.evaluate(() => window.db.snapshot().then(s => s.items[0].fields.loanId))).toBe(winner)));
    const snapshots = await Promise.all(pages.map(p => p.evaluate(() => window.db.snapshot())));
    expect(snapshots[0]).toEqual(snapshots[1]); expect(snapshots[1]).toEqual(snapshots[2]);
    expect(snapshots[0].decisions.filter(d => d.type === "CHECKOUT" && d.status === "REJECTED_CONFLICT")).toHaveLength(1);
    const file = await a.evaluate(async () => {
      const bytes = Uint8Array.from({ length: 1048576 + 51 }, (_, i) => i % 251);
      const { manifest } = await window.db.storage.upload(new File([bytes], "mesh.bin"));
      return { id: manifest.fileId, digest: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(",") };
    });
    await Promise.all([b, c].map(p => expect.poll(() => p.evaluate(id => window.db.snapshot().then(s => s.items.some(i => i.id === id)), file.id)).toBe(true)));
    await b.evaluate(id => window.db.storage.readBlob(id).then(() => {}), file.id);
    expect(await c.evaluate(() => window.sync.stats.chunksRequested)).toBe(0);
    await a.evaluate(() => window.sync.stop()); await mesh([b, c], 1);
    expect(await b.evaluate(() => window.sync.state)).toBe("online");
    const downloaded = await c.evaluate(async id => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await (await window.db.storage.readBlob(id)).arrayBuffer()))].join(","), file.id);
    expect(downloaded).toBe(file.digest);
    await c.reload(); await c.waitForFunction(() => window.clientReady);
    await c.evaluate(identity => window.db.open("wallet-library", identity), credentials(2)); await connect(c, relay.url); await mesh([b, c], 1);
    expect(await c.evaluate(() => window.db.snapshot().then(s => s.items.find(i => i.id === "book_1").fields.loanId))).toBe(winner);
    const snapshot = await c.evaluate(() => window.db.snapshot());
    expect(snapshot.decisions.filter(d => d.status === "REJECTED_CONFLICT")).toHaveLength(1);
    await Promise.all([b, c].map(p => p.evaluate(() => { window.removeStoragePeer(); window.sync.stop(); })));
    expect(await b.evaluate(() => window.sync.peers.length)).toBe(0);
  } catch (error) {
    console.log("Mesh diagnostics:", await Promise.all(pages.map(p => p.evaluate(() => ({ state: window.sync?.state, peers: window.sync?.peers, error: window.sync?.lastError, discovery: window.sync?.discoveryStats, errors: window.syncErrors })))));
    throw error;
  } finally { await Promise.all(contexts.map(c => c.close())); await relay.close(); }
});
