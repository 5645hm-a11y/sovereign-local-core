import { test, expect } from "@playwright/test";

const password = "identity-test-password-2026";
const projectId = "identity-test-project";

test("random vault identities differ, unlock stably, and use non-extractable private handles", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async password => {
    const { createIdentityVault, unlockIdentityVault } = await import("/dist/identity.js");
    const a = await createIdentityVault("alice@example.test", password);
    const b = await createIdentityVault("bob@example.test", password);
    const again = await createIdentityVault("alice@example.test", password);
    const restored = await unlockIdentityVault(a.vault, " ALICE@example.test ", password);
    let exportError;
    try { await crypto.subtle.exportKey("pkcs8", restored.privateKey); }
    catch (error) { exportError = error.name; }
    return { actorA: a.identity.actorId, actorB: b.identity.actorId, actorAgain: again.identity.actorId,
      restored: restored.actorId, extractable: restored.privateKey.extractable, exportError,
      iterations: a.vault.iterations, distinctSalt: a.vault.salt !== b.vault.salt,
      distinctIv: a.vault.iv !== b.vault.iv, noCredentialBytes: !JSON.stringify(a.vault).includes(password) };
  }, password);
  expect(result.actorA).not.toBe(result.actorB);
  expect(result.actorA).not.toBe(result.actorAgain); // Email/password protect random identity; they do not determine it.
  expect(result.restored).toBe(result.actorA);
  expect(result.actorA).toMatch(/^p256_[A-Za-z0-9_-]{87}$/);
  expect(result.extractable).toBe(false);
  expect(result.exportError).toBe("InvalidAccessError");
  expect(result.iterations).toBe(600000);
  expect(result.distinctSalt && result.distinctIv && result.noCredentialBytes).toBe(true);
});

test("wrong credentials and tampered AES-GCM ciphertext cannot unlock or replace the identity", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async password => {
    const { createIdentityVault, unlockIdentityVault } = await import("/dist/identity.js");
    const { fromBase64Url, toBase64Url } = await import("/dist/crypto-codec.js");
    const created = await createIdentityVault("alice@example.test", password);
    const original = JSON.stringify(created.vault), errors = [];
    const ciphertext = fromBase64Url(created.vault.ciphertext); ciphertext[0] ^= 1;
    for (const [vault, email, secret] of [
      [created.vault, "alice@example.test", "wrong-password-2026"],
      [created.vault, "bob@example.test", password],
      [{ ...created.vault, ciphertext: toBase64Url(ciphertext) }, "alice@example.test", password],
    ]) {
      try { await unlockIdentityVault(vault, email, secret); errors.push(null); }
      catch (error) { errors.push(error.name); }
    }
    return { errors, unchanged: JSON.stringify(created.vault) === original,
      restored: (await unlockIdentityVault(created.vault, "alice@example.test", password)).actorId,
      actorId: created.identity.actorId };
  }, password);
  expect(result.errors).toEqual(["IdentityUnlockError", "IdentityUnlockError", "IdentityUnlockError"]);
  expect(result.unchanged).toBe(true); expect(result.restored).toBe(result.actorId);
});

test("Bob's private key cannot forge Alice's actor ID through Bob's LocalCoreClient", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ password, projectId }) => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const { unlockIdentityVault, verifySignature, normalizeEmail } = await import("/dist/identity.js");
    const { canonicalEventText } = await import("/dist/validation.js");
    const { toBase64Url } = await import("/dist/crypto-codec.js");
    const alice = new LocalCoreClient(), bob = new LocalCoreClient();
    const a = await alice.createProject("alice-auth", { email: "alice@example.test", password, projectId });
    const recipient = await bob.identify({ email: "bob@example.test", password });
    const invite = await alice.inviteMember(recipient.actorId);
    const b = await bob.open("bob-auth", { email: "bob@example.test", password, projectId, invitation: invite.invitation });
    await bob.ingestEvents([invite.event]);
    const genuine = (await alice.dispatch({ type: "ITEM_ADDED", itemId: "auth-item", fields: { title: "genuine Alice" } })).event;
    await bob.ingestEvents([genuine]); // Genuine remote Alice signatures must work first.
    const before = await bob.snapshot(), beforeEvents = await bob.readEvents();
    // A malicious Bob can use his OWN key to sign arbitrary bytes, bypassing the signEvent helper's guard.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeEmail("bob@example.test")));
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("sovereign-identity-vaults");
    const file = await directory.getFileHandle(`account_${toBase64Url(digest)}.slv`);
    const bytes = await (await file.getFile()).arrayBuffer();
    const length = new DataView(bytes).getUint32(4, true);
    const encryptedVault = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 16, length)));
    const bobIdentity = await unlockIdentityVault(encryptedVault, "bob@example.test", password);
    const { signature: _, ...unsigned } = genuine;
    const payload = { ...unsigned, id: `${a.actorId}:3`, sequence: 3, lamport: 3 };
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobIdentity.privateKey,
      new TextEncoder().encode(canonicalEventText(payload)));
    const forged = { ...payload, signature: toBase64Url(signature) };
    let error;
    try { await bob.ingestEvents([forged]); } catch (failure) { error = failure.name; }
    const result = { actorsDiffer: a.actorId !== b.actorId, bobKeyMatches: bobIdentity.actorId === b.actorId,
      genuineValid: await verifySignature(genuine), forgedValid: await verifySignature(forged), error,
      snapshotUnchanged: JSON.stringify(await bob.snapshot()) === JSON.stringify(before),
      logUnchanged: JSON.stringify(await bob.readEvents()) === JSON.stringify(beforeEvents),
      watermark: (await bob.getSyncSummary())[a.actorId],
      publicOpenFields: Object.keys(a).sort() };
    await alice.close(); await bob.close(); return result;
  }, { password, projectId });
  expect(result.actorsDiffer && result.bobKeyMatches && result.genuineValid).toBe(true);
  expect(result.forgedValid).toBe(false);
  expect(result.error).toBe("InvalidEventSignatureError");
  expect(result.snapshotUnchanged && result.logUnchanged).toBe(true);
  expect(result.watermark).toBe(2);
  expect(result.publicOpenFields).toEqual(["actorId", "projectId", "recovery", "snapshot"]);
});

test("signatures bind payload, clock, sequence, actor and project; bad duplicates are verified too", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    await window.ready;
    const genuine = (await window.localCore.dispatch({ type: "ITEM_ADDED", itemId: "signed", fields: { title: "original" } })).event;
    const before = await window.localCore.readEvents(), errors = [];
    for (const forged of [
      { ...genuine, encryptedFields: { ...genuine.encryptedFields, iv: "A".repeat(16) } },
      { ...genuine, lamport: genuine.lamport + 1 },
      { ...genuine, id: `${genuine.actorId}:2`, sequence: 2 },
      { ...genuine, type: "ITEM_UPDATED" },
      { ...genuine, signature: "A".repeat(86) },
      { ...genuine, projectId: "another-project" },
    ]) {
      try { await window.localCore.ingestEvents([forged]); errors.push(null); }
      catch (error) { errors.push(error.name); }
    }
    const reordered = Object.fromEntries(Object.entries(genuine).reverse());
    const { verifySignature } = await import("/dist/identity.js");
    return { errors, unchanged: JSON.stringify(await window.localCore.readEvents()) === JSON.stringify(before),
      reorderedValid: await verifySignature(reordered) };
  });
  expect(result.errors).toEqual([...Array(5).fill("InvalidEventSignatureError"), "EventProjectMismatchError"]);
  expect(result.unchanged && result.reorderedValid).toBe(true);
});

test("a forged OPFS record with a correct CRC stops reopen without repairing or deleting bytes", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    await window.ready;
    const genuine = (await window.localCore.dispatch({ type: "ITEM_ADDED", itemId: "disk", fields: { title: "original" } })).event;
    await window.localCore.close();
    const forged = { ...genuine, id: `${genuine.actorId}:2`, sequence: 2, lamport: 2 };
    const moduleUrl = `${location.origin}/dist/framed-log.js`;
    const source = `import { encodeFrame } from ${JSON.stringify(moduleUrl)};
      onmessage = async event => {
        const root = await navigator.storage.getDirectory();
        const namespace = await root.getDirectoryHandle("sovereign-local-core");
        const directory = await namespace.getDirectoryHandle("example-v3");
        const file = await directory.getFileHandle("events.slc");
        const handle = await file.createSyncAccessHandle();
        const frame = encodeFrame({ kind: "event", event: event.data });
        handle.write(frame, { at: handle.getSize() });
        handle.write(new Uint8Array([1, 2, 3]), { at: handle.getSize() });
        handle.flush(); handle.close(); postMessage("done");
      };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    await new Promise((resolve, reject) => { worker.onmessage = resolve; worker.onerror = reject; worker.postMessage(forged); });
    worker.terminate(); URL.revokeObjectURL(url);
    const root = await navigator.storage.getDirectory();
    const namespace = await root.getDirectoryHandle("sovereign-local-core");
    const directory = await namespace.getDirectoryHandle("example-v3");
    const file = await directory.getFileHandle("events.slc");
    const before = await (await file.getFile()).arrayBuffer();
    const { LocalCoreClient } = await import("/dist/client.js");
    const next = new LocalCoreClient(); let error;
    try { await next.open("example-v3", window.demoCredentials); } catch (failure) { error = failure.name; }
    next.terminate();
    const after = await (await file.getFile()).arrayBuffer();
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
    return { error, unchanged: await hash(before) === await hash(after), sameSize: before.byteLength === after.byteLength };
  });
  expect(result.error).toBe("InvalidEventSignatureError");
  expect(result.unchanged && result.sameSize).toBe(true);
});

test("persisted vault reopens the same signed actor and wrong-password login leaves it intact", async ({ page }) => {
  await page.goto("/");
  const before = await page.evaluate(async () => {
    const opened = await window.ready;
    await window.localCore.dispatch({ type: "ITEM_ADDED", itemId: "persistent", fields: { title: "stable" } });
    return { actorId: opened.actorId, snapshot: await window.localCore.snapshot() };
  });
  await page.reload();
  const after = await page.evaluate(async () => {
    const opened = await window.ready;
    const { LocalCoreClient } = await import("/dist/client.js");
    const invalid = new LocalCoreClient(); let error;
    try { await invalid.open("example-v3", { ...window.demoCredentials, password: "incorrect-long-password" }); }
    catch (failure) { error = failure.name; }
    invalid.terminate();
    return { error, actorId: opened.actorId, snapshot: await window.localCore.snapshot() };
  });
  expect(after.error).toBe("IdentityUnlockError");
  expect({ actorId: after.actorId, snapshot: after.snapshot }).toEqual(before);
});
