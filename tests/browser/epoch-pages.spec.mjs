import { test, expect } from "@playwright/test";

async function setup(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const projectId = "paged-epoch-browser", passphrase = "synthetic-epoch-passphrase";
    const admin = new LocalCoreClient(), member = new LocalCoreClient(), reader = new LocalCoreClient();
    const adminOptions = { mode: "wallet", walletId: "epoch-admin", passphrase, projectId };
    const memberOptions = { mode: "wallet", walletId: "epoch-member", passphrase, projectId };
    const readerOptions = { mode: "wallet", walletId: "epoch-reader", passphrase, projectId };
    await admin.createProject("epoch-admin", adminOptions);
    const memberId = (await member.identify(memberOptions)).actorId, readerId = (await reader.identify(readerOptions)).actorId;
    const memberGrant = await admin.inviteMember(memberId), readerGrant = await admin.inviteMember(readerId);
    await member.open("epoch-member", { ...memberOptions, invitation: memberGrant.invitation });
    await reader.open("epoch-reader", { ...readerOptions, invitation: readerGrant.invitation });
    await member.ingestEvents(await admin.readEvents()); await reader.ingestEvents(await admin.readEvents());
    const old = (await member.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { text: "witnessed before rotation" } })).event;
    await admin.ingestEvents([old]);
    const result = await admin.revokeMember(memberId, { paged: true });
    const pages = (await admin.readEvents()).filter(e => e.type === "KEY_EPOCH_PAGE");
    const future = (await admin.dispatch({ type: "ITEM_ADDED", itemId: "new", fields: { text: "new epoch" } })).event;
    window.epoch = { admin, member, reader, adminOptions, readerOptions, old, result, pages, future, memberId };
  });
}

test("Worker RPC and OPFS recover manifest-first pages after abrupt termination and never use the old key for new writes", async ({ page }) => {
  await setup(page);
  const partial = await page.evaluate(async () => {
    const { reader, result, pages, future } = window.epoch;
    const { EpochIncompleteError } = await import("/dist/certificates.js");
    await reader.ingestEvents([result.event]); await reader.ingestEvents(pages.filter(e => e.epochPage.kind === "keys"));
    const errors = [], typed = [];
    for (const action of [() => reader.dispatch({ type: "ITEM_ADDED", itemId: "unsafe", fields: {} }), () => reader.ingestEvents([future]), () => reader.getDiscoveryInfo()]) {
      try { await action(); errors.push(null); } catch (error) { errors.push(error.name); typed.push(error instanceof EpochIncompleteError); }
    }
    const info = await reader.getProjectInfo(); reader.terminate(); return { errors, typed, pending: info.pendingEpochs, keyId: info.currentKeyId };
  });
  expect(partial.errors).toEqual(Array(3).fill("EpochIncompleteError"));
  expect(partial.typed).toEqual(Array(3).fill(true));
  expect(partial.pending[0].missingHistoryPages).toBe(1);
  const restored = await page.evaluate(async () => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const e = window.epoch, reader = new LocalCoreClient();
    // Browser releases the exclusive file lock asynchronously after Worker death.
    for (let i = 0; i < 50; i++) {
      try { await reader.open("epoch-reader", e.readerOptions); break; }
      catch (error) { if (i === 49) throw error; await new Promise(r => setTimeout(r, 20)); }
    }
    const pending = (await reader.getProjectInfo()).pendingEpochs;
    await reader.ingestEvents(e.pages.filter(p => p.epochPage.kind === "history"));
    await reader.ingestEvents([e.old, e.future]);
    const snapshot = await reader.snapshot();
    await e.member.ingestEvents([...e.pages, e.result.event]);
    let revoked;
    try { await e.member.dispatch({ type: "ITEM_ADDED", itemId: "forbidden", fields: {} }); } catch (error) { revoked = error.name; }
    const root = await navigator.storage.getDirectory(), namespace = await root.getDirectoryHandle("sovereign-local-core");
    const dir = await namespace.getDirectoryHandle("epoch-reader"), log = new Uint8Array(await (await (await dir.getFileHandle("events.slc")).getFile()).arrayBuffer());
    const plaintext = new TextDecoder().decode(log);
    await reader.close(); const recovered = new LocalCoreClient(); const opened = await recovered.open("epoch-reader", e.readerOptions);
    await recovered.close(); await e.admin.close(); await e.member.close();
    return { pending, snapshot, recovered: opened.snapshot, revoked,
      plaintextAbsent: !plaintext.includes("witnessed before rotation") && !plaintext.includes("new epoch") };
  });
  expect(restored.pending).toEqual(partial.pending);
  expect(restored.snapshot.items.map(i => i.id)).toEqual(["new", "old"]);
  expect(restored.snapshot).toEqual(restored.recovered);
  expect(restored.revoked).toBe("AuthorizationError"); expect(restored.plaintextAbsent).toBe(true);
});

test("SyncSession carries paged governance over actual DataChannels before new-key data and supports bidirectional live writes", async ({ page }) => {
  test.setTimeout(45000); await setup(page);
  await page.evaluate(async () => {
    const { SyncSession } = await import("/dist/sync-session.js"), { rtcByteLink } = await import("/dist/rtc-byte-link.js");
    const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] });
    const received = new Promise(resolve => { b.ondatachannel = e => resolve(e.channel); });
    const local = a.createDataChannel("epoch-proof"), remotePromise = received;
    a.onicecandidate = e => { if (e.candidate) void b.addIceCandidate(e.candidate); };
    b.onicecandidate = e => { if (e.candidate) void a.addIceCandidate(e.candidate); };
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
    const remote = await remotePromise;
    await Promise.all([local, remote].map(c => c.readyState === "open" ? Promise.resolve() : new Promise(resolve => { c.onopen = resolve; })));
    const left = new SyncSession(window.epoch.admin), right = new SyncSession(window.epoch.reader);
    left.connect(rtcByteLink(local)); right.connect(rtcByteLink(remote));
    window.epoch.network = { a, b, left, right };
  });
  await expect.poll(() => page.evaluate(() => window.epoch.reader.snapshot().then(s => s.items.map(i => i.id))), { timeout: 15000 }).toEqual(["new", "old"]);
  expect(await page.evaluate(() => window.epoch.reader.getProjectInfo().then(i => i.pendingEpochs))).toEqual([]);
  const result = await page.evaluate(async () => {
    const e = window.epoch; await e.reader.dispatch({ type: "ITEM_ADDED", itemId: "live", fields: { text: "authorized new epoch" } });
    return { pages: e.pages.length, stats: e.network.right.stats };
  });
  expect(result.pages).toBe(2); expect(result.stats.eventsReceived).toBeGreaterThanOrEqual(5);
  await expect.poll(() => page.evaluate(() => window.epoch.admin.snapshot().then(s => s.items.map(i => i.id)))).toEqual(["live", "new", "old"]);
  await page.evaluate(async () => {
    const e = window.epoch; e.network.left.stop(); e.network.right.stop(); e.network.a.close(); e.network.b.close();
    await Promise.all([e.admin.close(), e.member.close(), e.reader.close()]);
  });
});
