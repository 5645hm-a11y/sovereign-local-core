import test from "node:test";
import assert from "node:assert/strict";
import { ProjectContext } from "../../dist/project.js";
import { LocalCore } from "../../dist/engine.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { fromBase64Url, toBase64Url } from "../../dist/crypto-codec.js";
import { legacyEventText } from "../../dist/validation.js";
import { verifySignature } from "../../dist/identity.js";
import { normalizeEnvelope } from "../../dist/project-crypto.js";
import { generateProjectKey, wrapProjectKey } from "../../dist/project-crypto.js";
import { signEvent } from "../../dist/identity.js";
import { alice, bob, project, projectId, Device, concat, event } from "../helpers/core-fixtures.mjs";

const utf8 = value => new TextEncoder().encode(JSON.stringify(value));
const sign = async bytes => toBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, alice.privateKey, bytes));
function tuple(c) { return ["sovereign-local-core/certificate/v1", c.version, c.projectId, c.subject, c.issuer, c.role, c.issuedLamport, c.parent === null ? null : [...tuple(c.parent), c.parent.signature]]; }
function frame(record) {
  const payload = utf8(record), frame = new Uint8Array(16 + payload.length), v = new DataView(frame.buffer);
  let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  v.setUint32(0, 0x31434c53, true); v.setUint32(4, payload.length, true); v.setUint32(8, ~payload.length >>> 0, true); v.setUint32(12, (crc ^ 0xffffffff) >>> 0, true); frame.set(payload, 16); return frame;
}

test("existing signed JSON v3 project/envelope/event opens, appends binary events and preserves old bytes", async () => {
  const initial = await project.evaluate([]), key = initial.keys.get(initial.currentKeyId);
  const root = { ...project.certificate }; root.signature = await sign(utf8(tuple(root)));
  const descriptor = { ...project.descriptor, rootCertificate: root };
  descriptor.signature = await sign(utf8(["sovereign-local-core/project/v1", descriptor.version, projectId, alice.actorId, key.id, tuple(root), root.signature]));
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(alice.actorId.slice(5)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const envelope = { keyId: key.id, recipient: alice.actorId, ephemeralPublicKey: toBase64Url(await crypto.subtle.exportKey("raw", ephemeral.publicKey)), salt: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
  const aad = utf8(["sovereign-local-core/project-key/v1", projectId, key.id, alice.actorId, envelope.ephemeralPublicKey, envelope.salt]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, ephemeral.privateKey, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const wrapping = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: fromBase64Url(envelope.salt), info: aad }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = { ...envelope, iv: toBase64Url(iv), ciphertext: toBase64Url(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, wrapping, key.bytes)) };
  const invitation = { version: 1, descriptor, certificate: root, keys: [normalizeEnvelope(wrapped)], currentKeyId: key.id };
  invitation.signature = await sign(utf8(["sovereign-local-core/invitation/v1", 1, descriptor, root, invitation.keys, key.id]));
  const context = await ProjectContext.open(invitation, alice, projectId);
  const metadata = { schemaVersion: 3, projectId, id: `${alice.actorId}:1`, actorId: alice.actorId, sequence: 1, lamport: 1, certificate: root };
  const eventIV = crypto.getRandomValues(new Uint8Array(12));
  const oldAAD = utf8(["sovereign-local-core/fields/v1", 3, projectId, metadata.id, alice.actorId, 1, 1, "ITEM_ADDED", "old", key.id]);
  const unsigned = { ...metadata, type: "ITEM_ADDED", itemId: "old", keyId: key.id, encryptedFields: { iv: toBase64Url(eventIV),
    ciphertext: toBase64Url(await crypto.subtle.encrypt({ name: "AES-GCM", iv: eventIV, additionalData: oldAAD }, key.key, utf8([["title", "ישן שלום"]]))) } };
  const oldEvent = { ...unsigned, signature: await sign(new TextEncoder().encode(legacyEventText(unsigned))) };
  assert.equal(await verifySignature(oldEvent), true);
  const device = new Device(); device.durable = concat(frame({ kind: "identity", version: 3, actorId: alice.actorId, projectId }), frame({ kind: "event", event: oldEvent }));
  const prefix = device.durable.slice();
  const core = await LocalCore.open(await LocalEventStore.open(device.open(), { actorId: alice.actorId, projectId }), alice, context);
  assert.equal((await core.snapshot()).items[0].fields.title, "ישן שלום");
  const next = await core.dispatch({ type: "ITEM_UPDATED", itemId: "old", fields: { title: "binary now" } });
  assert.equal(next.event.sequence, 2); assert.equal(await verifySignature(next.event), true);
  assert.deepEqual(device.durable.subarray(0, prefix.length), prefix);
  assert.equal(new DataView(device.durable.buffer).getUint32(prefix.length, true), 0x32434c53);
  const expected = await core.snapshot(); await core.close();
  const reopenedContext = await ProjectContext.open(invitation, alice, projectId);
  const reopened = await LocalCore.open(await LocalEventStore.open(device.open(), { actorId: alice.actorId, projectId }), alice, reopenedContext);
  assert.deepEqual(await reopened.snapshot(), expected); await reopened.close();
});

test("a root's legacy JSON witness digest still authorizes the exact historical payload after revocation", async () => {
  const context = await ProjectContext.open(project.invitation, alice, projectId);
  const historical = await event(1, "ITEM_ADDED", { witnessed: true }, bob, 1);
  const { signature: _, ...unsigned } = historical;
  const digest = toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacyEventText(unsigned))));
  const key = await generateProjectKey();
  try {
    const revoke = await signEvent({ schemaVersion: 3, projectId, id: `${alice.actorId}:1`, actorId: alice.actorId,
      sequence: 1, lamport: 2, certificate: context.certificate, type: "MEMBER_REVOKED",
      revocation: { targetActorId: bob.actorId, allowedHistory: [{ id: historical.id, digest }], keyId: key.id,
        envelopes: [await wrapProjectKey(key, projectId, alice.actorId)] } }, alice);
    const state = await context.evaluateBinary([revoke, historical]);
    assert.equal(state.eligible.has(historical.id), true); state.blocks.forEach(b => b.fill(0));
  } finally { key.bytes.fill(0); context.close(); }
});
