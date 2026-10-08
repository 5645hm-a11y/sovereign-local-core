import { test, expect } from "@playwright/test";

const password = "rbac-test-password-2026";
const projectId = "rbac-project";
async function setup(page, observer = false) {
  await page.goto("/");
  return page.evaluate(async ({ password, projectId, observer }) => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const admin = new LocalCoreClient(), member = new LocalCoreClient();
    const adminOptions = { email: "admin@example.test", password, projectId };
    const memberOptions = { email: "member@example.test", password, projectId };
    const adminOpened = await admin.createProject("rbac-admin", adminOptions);
    const { actorId } = await member.identify(memberOptions);
    const invitation = await admin.inviteMember(actorId);
    await member.open("rbac-member", { ...memberOptions, invitation: invitation.invitation });
    await member.ingestEvents([invitation.event]);
    let reader;
    if (observer) {
      reader = new LocalCoreClient();
      const readerOptions = { email: "reader@example.test", password, projectId };
      const id = await reader.identify(readerOptions);
      const grant = await admin.inviteMember(id.actorId);
      await reader.open("rbac-reader", { ...readerOptions, invitation: grant.invitation });
      await reader.ingestEvents(await admin.readEvents());
      await member.ingestEvents([grant.event]);
    }
    window.rbac = { admin, member, reader, memberOptions, adminOptions, memberInvitation: invitation.invitation, memberActorId: actorId };
    return { adminActorId: adminOpened.actorId, memberActorId: actorId };
  }, { password, projectId, observer });
}

test("a valid self-signed outsider and a Member claiming Admin cannot inject project events", async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async ({ password, projectId }) => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const { verifySignature } = await import("/dist/identity.js");
    const { admin, member } = window.rbac;
    const outsider = new LocalCoreClient();
    await outsider.createProject("outsider", { email: "outsider@example.test", password, projectId });
    const hostile = (await outsider.dispatch({ type: "ITEM_ADDED", itemId: "hostile", fields: { secret: "outside" } })).event;
    const before = JSON.stringify(await admin.readEvents()), view = JSON.stringify(await admin.snapshot());
    const errors = [];
    for (const action of [
      () => admin.ingestEvents([hostile]),
      () => admin.ingestEvents([{ ...hostile, certificate: undefined }]),
      () => member.inviteMember(hostile.actorId),
      () => member.revokeMember(hostile.actorId),
    ]) {
      try { await action(); errors.push(null); } catch (error) { errors.push(error.name); }
    }
    const valid = (await member.dispatch({ type: "ITEM_ADDED", itemId: "legitimate", fields: { title: "member data" } })).event;
    await admin.ingestEvents([valid]);
    await outsider.close();
    return { signedOutsider: await verifySignature(hostile), errors,
      beforeUnchanged: JSON.stringify((await admin.readEvents()).slice(0, -1)) === before,
      initialView: JSON.parse(view), items: (await admin.snapshot()).items };
  }, { password, projectId });
  expect(result.signedOutsider).toBe(true);
  expect(result.errors).toEqual(["AuthorizationError", "TypeError", "AuthorizationError", "AuthorizationError"]);
  expect(result.beforeUnchanged).toBe(true);
  expect(result.initialView.items).toEqual([]);
  expect(result.items.map(item => item.id)).toEqual(["legitimate"]);
});

test("revocation rejects new and backdated events, preserves witnessed offline history, and rotates the key", async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { admin, member, reader, memberActorId, memberOptions, memberInvitation } = window.rbac;
    const { verifySignature, unlockIdentityVault, normalizeEmail, signEvent } = await import("/dist/identity.js");
    const { fromBase64Url, toBase64Url } = await import("/dist/crypto-codec.js");
    const { ProjectContext } = await import("/dist/project.js");
    const { encryptFields, fieldsAAD } = await import("/dist/project-crypto.js");
    const witnessed = (await member.dispatch({ type: "ITEM_ADDED", itemId: "old", fields: { secret: "witnessed old work" } })).event;
    await admin.ingestEvents([witnessed]); // Reader is offline and has not seen this yet.
    const unwitnessed = (await member.dispatch({ type: "ITEM_ADDED", itemId: "unknown-old", fields: { secret: "unwitnessed offline" } })).event;
    const oldKeyId = (await admin.getProjectInfo()).currentKeyId;
    const revoke = (await admin.revokeMember(memberActorId)).event;
    const late = (await member.dispatch({ type: "ITEM_UPDATED", itemId: "old", fields: { secret: "post-revocation" } })).event;
    await reader.ingestEvents([revoke]);
    await reader.ingestEvents([witnessed]); // Explicitly attested old content remains catch-up eligible.
    const before = JSON.stringify(await reader.readEvents());
    const errors = [];
    for (const event of [late, unwitnessed]) {
      try { await reader.ingestEvents([event]); errors.push(null); } catch (error) { errors.push(error.name); }
    }
    // A malicious member uses its own vault/key to fabricate valid encrypted bytes with an old clock.
    const root = await navigator.storage.getDirectory();
    const vaults = await root.getDirectoryHandle("sovereign-identity-vaults");
    const locator = toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeEmail(memberOptions.email))));
    const vaultFile = await vaults.getFileHandle(`account_${locator}.slv`);
    const bytes = await (await vaultFile.getFile()).arrayBuffer(), length = new DataView(bytes).getUint32(4, true);
    const vault = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 16, length)));
    const identity = await unlockIdentityVault(vault, memberOptions.email, memberOptions.password);
    const context = await ProjectContext.open(memberInvitation, identity, memberOptions.projectId);
    const state = await context.evaluate([]), key = state.keys.get(oldKeyId);
    const { signature: _, encryptedFields: __, ...rest } = late;
    const metadata = { ...rest, id: `${memberActorId}:42`, sequence: 42, lamport: witnessed.lamport };
    const encryptedFields = await encryptFields({ secret: "backdated forgery" }, fieldsAAD(metadata, metadata.type, metadata.itemId, oldKeyId), key);
    const backdated = await signEvent({ ...metadata, encryptedFields }, identity);
    try { await reader.ingestEvents([backdated]); errors.push(null); } catch (error) { errors.push(error.name); }
    const after = JSON.stringify(await reader.readEvents());
    const future = (await admin.dispatch({ type: "ITEM_ADDED", itemId: "future", fields: { secret: "new key content" } })).event;
    await reader.ingestEvents([future]);
    let decryptError;
    try {
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(future.encryptedFields.iv, 12),
        additionalData: fieldsAAD(future, future.type, future.itemId, future.keyId) }, key.key, fromBase64Url(future.encryptedFields.ciphertext));
    } catch (error) { decryptError = error.name; }
    await member.ingestEvents([revoke]);
    let localError;
    try { await member.dispatch({ type: "ITEM_UPDATED", itemId: "old", fields: { secret: "blocked locally" } }); }
    catch (error) { localError = error.name; }
    const snapshot = await reader.snapshot();
    await reader.close();
    const { LocalCoreClient } = await import("/dist/client.js");
    const reopened = new LocalCoreClient();
    const recovered = await reopened.open("rbac-reader", { email: "reader@example.test", password: memberOptions.password, projectId: memberOptions.projectId });
    await reopened.close(); context.close();
    return { errors, unchanged: before === after, lateClock: late.lamport > revoke.lamport,
      authenticAttack: await verifySignature(backdated), localError, decryptError,
      rotated: oldKeyId !== future.keyId, excludesRevoked: revoke.revocation.envelopes.every(e => e.recipient !== memberActorId),
      snapshot, recovered: recovered.snapshot };
  });
  expect(result.errors).toEqual(["AuthorizationError", "AuthorizationError", "AuthorizationError"]);
  expect(result.unchanged && result.lateClock && result.authenticAttack && result.rotated && result.excludesRevoked).toBe(true);
  expect(result.localError).toBe("AuthorizationError");
  expect(result.decryptError).toBe("OperationError");
  expect(result.snapshot.items.map(item => item.id)).toEqual(["future", "old"]);
  expect(result.recovered).toEqual(result.snapshot);
});

test("OPFS stores ciphertext and wrapped keys, and valid signatures cannot bypass AES-GCM integrity", async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { admin, member, memberOptions } = window.rbac;
    const sentinel = "CONFIDENTIAL_HEBREW_סוד_473819";
    const event = (await member.dispatch({ type: "ITEM_ADDED", itemId: "private-item", fields: { confidentialFieldName: sentinel } })).event;
    await admin.ingestEvents([event]);
    const root = await navigator.storage.getDirectory(), namespace = await root.getDirectoryHandle("sovereign-local-core");
    const directory = await namespace.getDirectoryHandle("rbac-admin");
    const contents = [];
    for await (const [, handle] of directory.entries()) if (handle.kind === "file") contents.push(new TextDecoder().decode(await (await handle.getFile()).arrayBuffer()));
    const text = contents.join("\n");
    const { unlockIdentityVault, normalizeEmail, signEvent, verifySignature } = await import("/dist/identity.js");
    const { toBase64Url } = await import("/dist/crypto-codec.js");
    const vaults = await root.getDirectoryHandle("sovereign-identity-vaults");
    const locator = toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeEmail(memberOptions.email))));
    const vf = await vaults.getFileHandle(`account_${locator}.slv`), bytes = await (await vf.getFile()).arrayBuffer();
    const vault = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 16, new DataView(bytes).getUint32(4, true))));
    const identity = await unlockIdentityVault(vault, memberOptions.email, memberOptions.password);
    const { signature: _, ...unsigned } = event;
    const forged = await signEvent({ ...unsigned, id: `${event.actorId}:2`, sequence: 2, lamport: event.lamport + 1 }, identity);
    // Signature is genuine, but copied ciphertext authenticates the original event metadata.
    const before = JSON.stringify(await admin.readEvents()); let error;
    try { await admin.ingestEvents([forged]); } catch (failure) { error = failure.name; }
    return { hasCiphertext: text.includes("ciphertext") && text.includes("ephemeralPublicKey"),
      noContent: !text.includes(sentinel) && !text.includes("confidentialFieldName"),
      noPlainFields: !Object.hasOwn(event, "fields"), signed: await verifySignature(forged), error,
      unchanged: JSON.stringify(await admin.readEvents()) === before,
      decrypted: (await admin.snapshot()).items[0].fields.confidentialFieldName };
  });
  expect(result.hasCiphertext && result.noContent && result.noPlainFields && result.signed && result.unchanged).toBe(true);
  expect(result.error).toBe("OperationError");
  expect(result.decrypted).toBe("CONFIDENTIAL_HEBREW_סוד_473819");
});

test("a member invited after rotation writes with the current key before catch-up; invitation tampering fails", async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { admin, memberActorId, memberOptions } = window.rbac;
    const { LocalCoreClient } = await import("/dist/client.js");
    await admin.revokeMember(memberActorId);
    const joiner = new LocalCoreClient();
    const options = { email: "late-joiner@example.test", password: memberOptions.password, projectId: memberOptions.projectId };
    const { actorId } = await joiner.identify(options), grant = await admin.inviteMember(actorId);
    const tampered = structuredClone(grant.invitation);
    tampered.currentKeyId = tampered.descriptor.genesisKeyId;
    let tamperError;
    try { await joiner.open("tampered-join", { ...options, invitation: tampered }); } catch (error) { tamperError = error.message; }
    await joiner.open("late-join", { ...options, invitation: grant.invitation });
    // No readEvents/catch-up before this command: grant clock and latest epoch are bootstrap inputs.
    const write = await joiner.dispatch({ type: "ITEM_ADDED", itemId: "late-join", fields: { secret: "current epoch" } });
    await admin.ingestEvents([write.event]);
    const metadata = await admin.getProjectInfo();
    await joiner.ingestEvents((await admin.readEvents()).filter(e => e.id !== write.event.id));
    let regrantError;
    try { await admin.inviteMember(memberActorId); } catch (error) { regrantError = error.name; }
    return { tamperError, regrantError, epoch: write.event.keyId === metadata.currentKeyId,
      clock: write.event.lamport > grant.invitation.certificate.issuedLamport,
      items: (await joiner.snapshot()).items };
  });
  expect(result.tamperError).toBe("Invalid invitation signature");
  expect(result.regrantError).toBe("AuthorizationError");
  expect(result.epoch && result.clock).toBe(true);
  expect(result.items[0].fields.secret).toBe("current epoch");
});

test("delegated Admin chains grant Members, deny further Admin delegation, and lose descendants on revocation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ password, projectId }) => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const root = new LocalCoreClient(), admin = new LocalCoreClient(), leaf = new LocalCoreClient();
    const rootOptions = { email: "root-chain@example.test", password, projectId };
    const adminOptions = { email: "admin-chain@example.test", password, projectId };
    const leafOptions = { email: "leaf-chain@example.test", password, projectId };
    await root.createProject("chain-root", rootOptions);
    const adminId = (await admin.identify(adminOptions)).actorId;
    const adminGrant = await root.inviteMember(adminId, "Admin");
    await admin.open("chain-admin", { ...adminOptions, invitation: adminGrant.invitation });
    await admin.ingestEvents([adminGrant.event]);
    const leafId = (await leaf.identify(leafOptions)).actorId;
    let escalation;
    try { await admin.inviteMember(leafId, "Admin"); } catch (error) { escalation = error.name; }
    const grant = await admin.inviteMember(leafId);
    await root.ingestEvents([grant.event]);
    await leaf.open("chain-leaf", { ...leafOptions, invitation: grant.invitation });
    const data = (await leaf.dispatch({ type: "ITEM_ADDED", itemId: "chain-data", fields: { secret: "valid chain" } })).event;
    await root.ingestEvents([data]);
    const revocation = (await root.revokeMember(adminId)).event;
    await leaf.ingestEvents([revocation]);
    let revoked;
    try { await leaf.dispatch({ type: "ITEM_UPDATED", itemId: "chain-data", fields: { secret: "denied" } }); }
    catch (error) { revoked = error.name; }
    return { escalation, revoked, chainDepth: grant.invitation.certificate.parent.parent.subject,
      rootActorId: (await root.getProjectInfo()).descriptor.rootActorId,
      excluded: revocation.revocation.envelopes.every(e => e.recipient !== leafId && e.recipient !== adminId),
      oldWork: (await root.snapshot()).items[0].fields.secret };
  }, { password, projectId });
  expect(result.escalation).toBe("AuthorizationError");
  expect(result.revoked).toBe("AuthorizationError");
  expect(result.chainDepth).toBe(result.rootActorId);
  expect(result.excluded).toBe(true);
  expect(result.oldWork).toBe("valid chain");
});

test("a correctly signed unauthorized OPFS record is rejected before tail repair", async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async ({ password, projectId }) => {
    const { LocalCoreClient } = await import("/dist/client.js");
    const { admin, adminOptions } = window.rbac;
    const hostileClient = new LocalCoreClient();
    await hostileClient.createProject("disk-outsider", { email: "disk-outsider@example.test", password, projectId });
    const hostile = (await hostileClient.dispatch({ type: "ITEM_ADDED", itemId: "disk-hostile", fields: { secret: "unauthorized" } })).event;
    await admin.close();
    const source = `import { encodeFrame } from ${JSON.stringify(`${location.origin}/dist/framed-log.js`)};
      onmessage = async event => {
        const root = await navigator.storage.getDirectory();
        const namespace = await root.getDirectoryHandle("sovereign-local-core");
        const directory = await namespace.getDirectoryHandle("rbac-admin");
        const file = await directory.getFileHandle("events.slc");
        const handle = await file.createSyncAccessHandle();
        const frame = encodeFrame({ kind: "event", event: event.data });
        handle.write(frame, { at: handle.getSize() });
        handle.write(new Uint8Array([1,2,3]), { at: handle.getSize() });
        handle.flush(); handle.close(); postMessage("done");
      };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    await new Promise((resolve, reject) => { worker.onmessage = resolve; worker.onerror = reject; worker.postMessage(hostile); });
    worker.terminate(); URL.revokeObjectURL(url);
    const root = await navigator.storage.getDirectory(), namespace = await root.getDirectoryHandle("sovereign-local-core");
    const directory = await namespace.getDirectoryHandle("rbac-admin"), file = await directory.getFileHandle("events.slc");
    const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await (await file.getFile()).arrayBuffer()))).join(",");
    const before = await hash();
    const reopened = new LocalCoreClient(); let error;
    try { await reopened.open("rbac-admin", adminOptions); } catch (failure) { error = failure.name; }
    reopened.terminate();
    return { error, unchanged: before === await hash() };
  }, { password, projectId });
  expect(result.error).toBe("AuthorizationError");
  expect(result.unchanged).toBe(true);
});
