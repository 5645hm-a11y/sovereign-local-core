import { alice, bob, Device, projectId, store } from "./core-fixtures.mjs";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { toBase64Url } from "../../dist/crypto-codec.js";

export async function newIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const bytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return { publicKey: pair.publicKey, privateKey: await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    agreementKey: await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    actorId: `p256_${toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey))}` };
}
export async function epochFixture({ delegatedReader = false } = {}) {
  const readerIdentity = await newIdentity(), devices = [new Device(), new Device(), new Device()];
  const project = await ProjectContext.create(alice, projectId);
  const rootInvitation = project.invitation;
  const a = await LocalCore.open(await store(devices[0]), alice, project);
  const bGrant = await a.inviteMember(bob.actorId, delegatedReader ? "Admin" : "Member"), bProject = await ProjectContext.open(bGrant.invitation, bob, projectId);
  const b = await LocalCore.open(await store(devices[1], bob), bob, bProject);
  const cGrant = await (delegatedReader ? b : a).inviteMember(readerIdentity.actorId), readerInvitation = cGrant.invitation;
  if (delegatedReader) await a.ingestEvents([cGrant.event]);
  const cProject = await ProjectContext.open(readerInvitation, readerIdentity, projectId);
  let c = await LocalCore.open(await store(devices[2], readerIdentity), readerIdentity, cProject);
  await b.ingestEvents(await a.readEvents()); await c.ingestEvents(await a.readEvents());
  return { a, b, get c() { return c; }, devices, project, readerIdentity, rootInvitation, readerInvitation,
    async reopenReader() {
      await c.close(); const context = await ProjectContext.open(readerInvitation, readerIdentity, projectId);
      c = await LocalCore.open(await store(devices[2], readerIdentity), readerIdentity, context); return c;
    },
    async close() { await Promise.all([a.close(), b.close(), c.close()]); },
  };
}
