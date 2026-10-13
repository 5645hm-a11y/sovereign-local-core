import { test, expect } from "@playwright/test";
import { startMockNostrRelay } from "../helpers/mock-nostr-relay.mjs";

const credentials = i => ({ mode: "wallet", walletId: `generic_domain_actor_${i}`, passphrase: "synthetic-generic-domain-passphrase" });
const definitions = () => {
  const rule = (prefix, roles) => ({ prefix, create: roles, update: roles, delete: ["Admin"], checkout: [], return: [], ownerField: null, library: false });
  return [
    { id: "shared", prefixes: ["record_", "file_"], readRoles: ["Admin", "Member"],
      policies: { version: 1, defaultAllow: false, rules: [rule("record_", ["Admin", "Member"]), rule("file_", ["Admin", "Member"])] } },
    { id: "private", prefixes: ["private_", "file_private_"], readRoles: ["Admin"],
      policies: { version: 1, defaultAllow: false, rules: [rule("private_", ["Admin"]), rule("file_private_", ["Admin"])] } },
  ];
};
async function ready(page) {
  await page.goto("/examples/policy.html"); await page.waitForFunction(() => window.clientReady);
  await page.evaluate(() => window.db.terminate());
}

test("generic read domains isolate ciphertext and swarms, sync shared edits, lazily pull private files only to readers and recover after reload", async ({ browser }) => {
  test.setTimeout(90000);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const relay = await startMockNostrRelay();
  try {
    await Promise.all(pages.map(ready));
    const actors = await Promise.all(pages.map((page, i) => page.evaluate(async credentials => {
      const { LocalCoreClient } = await import("/dist/index.js"); const client = new LocalCoreClient();
      try { return (await client.identify(credentials)).actorId; } finally { client.terminate(); }
    }, credentials(i))));
    const bootstrap = await pages[0].evaluate(async ({ credentials, definitions }) => {
      const { ReadDomainsClient } = await import("/dist/index.js");
      window.domains = await ReadDomainsClient.create("generic_db", credentials, definitions);
      return { root: window.domains.rootActorId, spaceId: window.domains.space.spaceId, invitation: window.domains.bootstrap };
    }, { credentials: credentials(0), definitions: definitions() });
    const invitations = await Promise.all([1, 2].map(i => pages[0].evaluate(({ actorId, role }) => window.domains.inviteMember(actorId, role),
      { actorId: actors[i], role: i === 1 ? "Admin" : "Member" })));
    expect(invitations[0].invitations).toHaveLength(2); expect(invitations[1].invitations).toHaveLength(1);
    const trust = { rootActorId: bootstrap.root, spaceId: bootstrap.spaceId };
    for (const [index, page] of pages.slice(1).entries()) await page.evaluate(async ({ credentials, invitation, trust }) => {
      const { ReadDomainsClient } = await import("/dist/index.js");
      window.domains = await ReadDomainsClient.open("generic_db", credentials, invitation, trust);
    }, { credentials: credentials(index + 1), invitation: invitations[index], trust });

    const secret = await pages[0].evaluate(async () => {
      await window.domains.dispatch({ type: "ITEM_ADDED", itemId: "record_1", fields: { text: "Shared data for any application" } });
      const secret = await window.domains.dispatch({ type: "ITEM_ADDED", itemId: "private_1", fields: { text: "GENERIC_PRIVATE_PAYLOAD" } });
      const file = await window.domains.uploadFile("private", new Blob(["PRIVATE_STREAM_CONTENT"]), { name: "internal.txt" });
      return { event: secret.event, fileId: file.manifest.fileId };
    });
    await Promise.all(pages.map(page => page.evaluate(async url => {
      const { NostrDiscovery } = await import("/dist/nostr-discovery.bundle.js");
      window.domainErrors = [];
      await window.domains.connect(() => ({ discovery: new NostrDiscovery({ relays: [url], timeoutMs: 3000 }), iceServers: [],
        helloIntervalMs: 200, reconnectBaseMs: 100, onError: e => window.domainErrors.push(e.message) }));
    }, relay.url)));
    for (const page of pages) await expect.poll(() => page.evaluate(() => window.domains.snapshot().then(s => s.items.some(i => i.id === "record_1"))), { timeout: 20000 }).toBe(true);
    await expect.poll(() => pages[1].evaluate(() => window.domains.snapshot().then(s => s.items.some(i => i.id === "private_1")))).toBe(true);
    for (const page of pages) await expect.poll(() => page.evaluate(() => window.domains.network.find(n => n.domainId === "shared").peers.filter(p => p.state === "online").length)).toBe(2);
    for (const page of pages.slice(0, 2)) await expect.poll(() => page.evaluate(() => window.domains.network.find(n => n.domainId === "private").peers.filter(p => p.state === "online").length)).toBe(1);
    const memberView = await pages[2].evaluate(() => window.domains.snapshot());
    expect(memberView.unavailableDomains).toEqual(["private"]);
    expect(memberView.items.map(i => i.id)).toEqual(["record_1"]);
    const denied = await pages[2].evaluate(async ({ secret }) => {
      const attempt = async fn => { try { await fn(); return "accepted"; } catch (e) { return e.message; } };
      const shared = window.domains.domain("shared"), before = (await shared.readEvents()).length;
      const results = await Promise.all([
        attempt(() => window.domains.dispatch({ type: "ITEM_ADDED", itemId: "private_2", fields: { text: "Denied" } })),
        attempt(() => shared.dispatch({ type: "ITEM_ADDED", itemId: "private_2", fields: { text: "Bypass attempt" } })),
        attempt(() => shared.ingestEvents([secret.event])),
        attempt(() => window.domains.readFileBlob(secret.fileId)),
      ]);
      return { results, before, after: (await shared.readEvents()).length, events: await shared.readEvents() };
    }, { secret });
    expect(denied.results.every(s => s !== "accepted")).toBe(true); expect(denied.after).toBe(denied.before);
    expect(JSON.stringify(denied.events)).not.toContain("GENERIC_PRIVATE_PAYLOAD");
    const fileText = await pages[1].evaluate(id => window.domains.readFileBlob(id).then(blob => blob.text()), secret.fileId);
    expect(fileText).toBe("PRIVATE_STREAM_CONTENT");
    await pages[2].evaluate(() => window.domains.dispatch({ type: "ITEM_UPDATED", itemId: "record_1", fields: { text: "Live generic edit" } }));
    for (const page of pages.slice(0, 2)) await expect.poll(() => page.evaluate(() => window.domains.snapshot().then(s => s.items.find(i => i.id === "record_1").fields.text))).toBe("Live generic edit");
    const expected = await Promise.all(pages.map(p => p.evaluate(() => window.domains.snapshot())));
    await Promise.all(pages.map(p => p.evaluate(() => window.domains.close())));
    await Promise.all(pages.map(ready));
    const reopenBundles = [bootstrap.invitation, ...invitations];
    for (const [i, page] of pages.entries()) {
      const recovered = await page.evaluate(async ({ credentials, invitation, trust }) => {
        const { ReadDomainsClient } = await import("/dist/index.js"); window.domains = await ReadDomainsClient.open("generic_db", credentials, invitation, trust);
        return window.domains.snapshot();
      }, { credentials: credentials(i), invitation: reopenBundles[i], trust });
      expect(recovered).toEqual(expected[i]);
    }
    expect(await pages[1].evaluate(id => window.domains.readFileBlob(id).then(b => b.text()), secret.fileId)).toBe("PRIVATE_STREAM_CONTENT");
    const memberDirectories = await pages[2].evaluate(async () => {
      const namespace = await (await navigator.storage.getDirectory()).getDirectoryHandle("sovereign-local-core");
      const names = []; for await (const [name] of namespace.entries()) names.push(name); return names;
    });
    expect(memberDirectories.filter(n => n.startsWith("generic_db_domain_"))).toEqual(["generic_db_domain_1"]);
    const revocations = await pages[0].evaluate(actor => window.domains.revokeMember(actor), actors[2]);
    expect(revocations.map(r => r.domainId)).toEqual(["shared"]);
    const rejected = await pages[2].evaluate(async event => {
      await window.domains.domain("shared").ingestEvents([event]);
      try { await window.domains.dispatch({ type: "ITEM_UPDATED", itemId: "record_1", fields: { text: "Revoked attempt" } }); return "accepted"; }
      catch (e) { return e.name; }
    }, revocations[0].event);
    expect(rejected).toBe("AuthorizationError");
  } finally { await Promise.all(contexts.map(c => c.close())); await relay.close(); }
});

test("bundle tampering and wrong pinned root fail before OPFS initialization; trusted retry remains usable", async ({ browser }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext())), pages = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await Promise.all(pages.map(ready));
    const actor = await pages[1].evaluate(async credentials => {
      const { LocalCoreClient } = await import("/dist/index.js"); const client = new LocalCoreClient();
      try { return (await client.identify(credentials)).actorId; } finally { client.terminate(); }
    }, credentials(1));
    const seed = await pages[0].evaluate(async ({ credentials, definitions, actor }) => {
      const { ReadDomainsClient } = await import("/dist/index.js"); window.domains = await ReadDomainsClient.create("generic_db", credentials, definitions);
      return { invitation: await window.domains.inviteMember(actor, "Member"), trust: { rootActorId: window.domains.rootActorId, spaceId: window.domains.space.spaceId } };
    }, { credentials: credentials(0), definitions: definitions(), actor });
    const results = await pages[1].evaluate(async ({ credentials, seed, actor }) => {
      const { ReadDomainsClient } = await import("/dist/index.js"); const failures = [];
      const changed = structuredClone(seed.invitation); changed.invitations[0].descriptor.readDomain.space.domains.find(d => d.id === "private").prefixes = ["hidden_"];
      for (const [invitation, trust] of [[changed, seed.trust], [seed.invitation, { ...seed.trust, rootActorId: actor }]]) {
        try { await ReadDomainsClient.open("untrusted_retry", credentials, invitation, trust); failures.push("accepted"); }
        catch (e) { failures.push(e.name); }
      }
      const root = await navigator.storage.getDirectory(); let created = false;
      try { await (await root.getDirectoryHandle("sovereign-local-core")).getDirectoryHandle("untrusted_retry_domain_1"); created = true; } catch { /* Absent as expected. */ }
      const db = await ReadDomainsClient.open("untrusted_retry", credentials, seed.invitation, seed.trust);
      try { await db.dispatch({ type: "ITEM_ADDED", itemId: "record_retry", fields: { ok: true } }); return { failures, created, count: (await db.snapshot()).items.length }; }
      finally { await db.close(); }
    }, { credentials: credentials(1), seed, actor });
    expect(results.failures).toEqual(["AuthorizationError", "AuthorizationError"]); expect(results.created).toBe(false); expect(results.count).toBe(1);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
