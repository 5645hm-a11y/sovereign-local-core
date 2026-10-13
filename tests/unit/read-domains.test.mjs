import test from "node:test";
import assert from "node:assert/strict";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { StorageEngine } from "../../dist/storage.js";
import { issueCertificate } from "../../dist/certificates.js";
import { decryptFields, fieldsAAD, signInvitation, wrapProjectKey } from "../../dist/project-crypto.js";
import { normalizeReadDomainSpace, resolveReadDomain } from "../../dist/read-domains.js";
import { verifyReadDomainsInvitation } from "../../dist/read-domains-client.js";
import { Device, alice, bob } from "../helpers/core-fixtures.mjs";

const rule = (prefix, roles = ["Admin"]) => ({ prefix, create: roles, update: roles, delete: ["Admin"],
  checkout: [], return: [], ownerField: null, library: false });
export function definitions() { return [
  { id: "shared", prefixes: ["record_", "file_"], readRoles: ["Admin", "Member"],
    policies: { version: 1, defaultAllow: false, rules: [rule("record_", ["Admin", "Member"]), rule("file_", ["Admin", "Member"])] } },
  { id: "private", prefixes: ["private_", "file_private_"], readRoles: ["Admin"],
    policies: { version: 1, defaultAllow: false, rules: [rule("private_"), rule("file_private_")] } },
]; }
async function setup() {
  const space = normalizeReadDomainSpace({ version: 1, spaceId: "generic_space", domains: definitions().map(d => ({ ...d, projectId: `generic_${d.id}` })) });
  const projects = new Map();
  for (const domain of space.domains) projects.set(domain.id, await ProjectContext.create(alice, domain.projectId, domain.policies, { domainId: domain.id, space }));
  const publicProject = projects.get("shared"), secretProject = projects.get("private");
  const invitation = await publicProject.invite(bob.actorId, "Member", 0, await publicProject.evaluate([]));
  const member = await ProjectContext.open(invitation, bob, publicProject.descriptor.projectId);
  return { space, projects, publicProject, secretProject, invitation, member };
}
async function open(project, device = new Device()) {
  const store = await LocalEventStore.open(device.open(), { actorId: project.identity.actorId, projectId: project.descriptor.projectId });
  return LocalCore.open(store, project.identity, project);
}

test("signed read spaces normalize routing and reject ambiguous, missing or overlarge definitions", () => {
  const s = normalizeReadDomainSpace({ version: 1, spaceId: "space", domains: definitions().map(d => ({ ...d, projectId: d.id })) });
  assert.equal(resolveReadDomain(s, "record_1").id, "shared");
  assert.equal(resolveReadDomain(s, "file_private_1").id, "private");
  assert.throws(() => resolveReadDomain(s, "unclassified_1"));
  const mutate = fn => { const copy = structuredClone(s); fn(copy); assert.throws(() => normalizeReadDomainSpace(copy)); };
  mutate(s => s.domains[0].readRoles = ["Member"]);
  mutate(s => s.domains[0].readRoles = ["Admin", "Admin"]);
  mutate(s => s.domains[0].readRoles = ["Admin", "unknown"]);
  mutate(s => s.domains[1].projectId = s.domains[0].projectId);
  mutate(s => s.domains[1].prefixes = s.domains[0].prefixes);
  mutate(s => s.domains = Array.from({ length: 17 }, () => s.domains[0]));
});

test("independent domain keys prevent a shared Member reading private disk ciphertext or injecting it into shared state", async () => {
  const f = await setup(), secretDevice = new Device(), publicDevice = new Device();
  const privateCore = await open(f.secretProject, secretDevice), sharedCore = await open(f.publicProject, publicDevice), memberCore = await open(f.member);
  try {
    const pub = await sharedCore.dispatch({ type: "ITEM_ADDED", itemId: "record_1", fields: { text: "Shared application data" } });
    const secret = await privateCore.dispatch({ type: "ITEM_ADDED", itemId: "private_1", fields: { text: "CONFIDENTIAL_GENERIC_VALUE" } });
    assert.notEqual(pub.event.keyId, secret.event.keyId);
    const memberState = await f.member.evaluate([]), publicKey = memberState.keys.get(memberState.currentKeyId);
    await assert.rejects(decryptFields(secret.event.encryptedFields, fieldsAAD(secret.event, secret.event.type, secret.event.itemId, secret.event.keyId), publicKey));
    await memberCore.ingestEvents([pub.event]);
    const before = await memberCore.readEvents();
    await assert.rejects(memberCore.ingestEvents([secret.event]));
    assert.deepEqual(await memberCore.readEvents(), before);
    assert.equal((await memberCore.snapshot()).items[0].fields.text, "Shared application data");
    assert.ok(secretDevice.durable.length > 0);
    assert.equal(new TextDecoder().decode(secretDevice.durable).includes("CONFIDENTIAL_GENERIC_VALUE"), false);
    const utf16 = Buffer.from("CONFIDENTIAL_GENERIC_VALUE", "utf16le");
    assert.equal(Buffer.from(secretDevice.durable).includes(utf16), false);
    // Namespace enforcement is in the core, even when the facade is bypassed.
    await assert.rejects(sharedCore.dispatch({ type: "ITEM_ADDED", itemId: "private_2", fields: { text: "Misrouted secret" } }));
    assert.equal((await sharedCore.readEvents()).length, 1);
  } finally { await Promise.all([privateCore.close(), sharedCore.close(), memberCore.close()]); }
});

test("read-role admission denies private invitations and signed certificates; root/map substitution and omission fail preflight", async () => {
  const f = await setup(), state = await f.secretProject.evaluate([]);
  await assert.rejects(f.secretProject.invite(bob.actorId, "Member", 1, state));
  const certificate = await issueCertificate(alice, f.secretProject.descriptor.projectId, bob.actorId, "Member", 1, f.secretProject.certificate);
  const key = state.keys.get(state.currentKeyId);
  const forbidden = await signInvitation({ version: 1, descriptor: f.secretProject.descriptor, certificate,
    keys: [await wrapProjectKey(key, f.secretProject.descriptor.projectId, bob.actorId)], currentKeyId: key.id, signature: "A".repeat(86) }, alice);
  await assert.rejects(ProjectContext.open(forbidden, bob, f.secretProject.descriptor.projectId));
  const trust = { rootActorId: alice.actorId, spaceId: f.space.spaceId };
  const publicBundle = { version: 1, invitations: [f.invitation] };
  assert.equal((await verifyReadDomainsInvitation(publicBundle, trust)).invitations.length, 1);
  await assert.rejects(verifyReadDomainsInvitation(publicBundle, { ...trust, rootActorId: bob.actorId }));
  const tampered = structuredClone(publicBundle); tampered.invitations[0].descriptor.readDomain.space.domains.find(d => d.id === "private").readRoles.push("Member");
  await assert.rejects(verifyReadDomainsInvitation(tampered, trust));
  const downgrade = structuredClone(publicBundle); downgrade.invitations[0].descriptor.version = 2; delete downgrade.invitations[0].descriptor.readDomain;
  await assert.rejects(verifyReadDomainsInvitation(downgrade, trust));
  const rootBundle = { version: 1, invitations: [...f.projects.values()].map(p => p.invitation) };
  assert.equal((await verifyReadDomainsInvitation(rootBundle, trust)).invitations.length, 2);
  await assert.rejects(verifyReadDomainsInvitation({ ...rootBundle, invitations: rootBundle.invitations.slice(0, 1) }, { ...trust, requiredDomainIds: ["shared", "private"] }));
  const restricted = await verifyReadDomainsInvitation({ ...rootBundle, invitations: rootBundle.invitations.slice(0, 1) }, trust);
  assert.equal(restricted.invitations.length, 1); // An explicit partial grant never changes routing.
});

test("private files use private keys and namespaces; forbidden requests fail and wrong-domain upload writes nothing", async () => {
  const f = await setup(), privateCore = await open(f.secretProject), sharedCore = await open(f.publicProject), memberCore = await open(f.member);
  const map = new Map(), blobs = { get: async hash => map.get(hash) ?? null, put: async (hash, bytes) => map.set(hash, bytes.slice()) };
  const service = new StorageEngine(privateCore, blobs);
  try {
    await assert.rejects(service.upload(new Blob(["Wrong domain"])), /different read domain/);
    assert.equal(map.size, 0); assert.equal((await privateCore.readEvents()).length, 0);
    const file = await service.upload(new Blob(["Private generic file contents"]), { filePrefix: "file_private_", name: "internal.txt" });
    assert.ok(file.manifest.fileId.startsWith("file_private_"));
    assert.equal(new TextDecoder().decode(await service.readChunk(file.manifest.fileId, 0)), "Private generic file contents");
    const request = await memberCore.createChunkRequest(file.manifest.fileId, 0, file.manifest.chunks[0]);
    await assert.rejects(service.serveChunk(request));
    const publicKey = await sharedCore.storageKey();
    assert.notEqual(publicKey.keyId, file.manifest.keyId);
  } finally { await Promise.all([privateCore.close(), sharedCore.close(), memberCore.close()]); }
});

test("private domain checkpoint/recovery and key rotation retain authorized history without admitting shared roles", async () => {
  const f = await setup(), devices = [new Device(), new Device(), new Device()], projectId = f.secretProject.descriptor.projectId;
  const peerInvitation = await f.secretProject.invite(bob.actorId, "Admin", 0, await f.secretProject.evaluate([]));
  const reopen = async () => {
    const context = await ProjectContext.open(f.secretProject.invitation, alice, projectId);
    const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], context);
    const log = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
    return LocalCore.open(log, alice, context, { checkpointInterval: 2 });
  };
  let core = await reopen();
  try {
    const initial = await core.dispatch({ type: "ITEM_ADDED", itemId: "private_1", fields: { text: "Before rotation" } });
    const oldKey = initial.event.keyId;
    // A signed invitation event makes the peer known to root's revocation machinery.
    await core.inviteMember(bob.actorId, "Admin");
    await core.revokeMember(bob.actorId);
    const after = await core.dispatch({ type: "ITEM_UPDATED", itemId: "private_1", fields: { text: "After rotation" } });
    assert.notEqual(after.event.keyId, oldKey);
    const expected = await core.snapshot(); await core.close(); core = await reopen();
    assert.deepEqual(await core.snapshot(), expected); assert.equal(core.recovery.checkpointEvents, 4);
    const revokedContext = await ProjectContext.open(peerInvitation, bob, projectId), revokedCore = await open(revokedContext);
    try {
      await assert.rejects(revokedCore.ingestEvents(await core.readEvents()));
    } finally { await revokedCore.close(); }
  } finally { await core.close(); }
});
