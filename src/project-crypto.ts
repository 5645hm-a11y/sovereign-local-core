import { encodeBinary, decodeBinary } from "./binary-codec.js";
import { encodeCommands, requireCommandBinding, decodeCommandFields } from "./binary-command.js";
import { normalizeCommand } from "./validation.js";
import { fromBase64Url, normalizeActorId, toBase64Url } from "./crypto-codec.js";
import { exactObject, normalizeCertificate, normalizeDescriptor } from "./certificates.js";
import type { Ciphertext, EventMetadata, Fields, KeyEnvelope, ProjectInvitation } from "./types.js";
import type { UnlockedIdentity } from "./identity.js";

export interface ProjectKey { readonly id: string; readonly key: CryptoKey; readonly bytes: Uint8Array<ArrayBuffer> }
export function normalizeCiphertext(value: unknown): Ciphertext {
  const c = exactObject(value, ["iv", "ciphertext"]);
  fromBase64Url(c.iv, 12);
  const bytes = fromBase64Url(c.ciphertext);
  if (bytes.length < 16 || bytes.length > 1048576) throw new TypeError("Invalid ciphertext size");
  return Object.freeze({ iv: c.iv as string, ciphertext: c.ciphertext as string });
}
export function normalizeKeyId(value: unknown): string {
  if (typeof value !== "string" || !/^key_[A-Za-z0-9_-]{43}$/.test(value)) throw new TypeError("Invalid project key ID");
  return value;
}
export function normalizeEnvelope(value: unknown): KeyEnvelope {
  const e = exactObject(value, ["keyId", "recipient", "ephemeralPublicKey", "salt", "iv", "ciphertext"]);
  const c = normalizeCiphertext({ iv: e.iv, ciphertext: e.ciphertext });
  if (fromBase64Url(c.ciphertext).length !== 48) throw new TypeError("Invalid wrapped key length");
  fromBase64Url(e.ephemeralPublicKey, 65); fromBase64Url(e.salt, 32);
  return Object.freeze({ ...c, keyId: normalizeKeyId(e.keyId), recipient: normalizeActorId(e.recipient),
    ephemeralPublicKey: e.ephemeralPublicKey as string, salt: e.salt as string });
}
export function normalizeInvitation(value: unknown): ProjectInvitation {
  const i = exactObject(value, ["version", "descriptor", "certificate", "keys", "currentKeyId", "signature"]);
  if (i.version !== 1 || !Array.isArray(i.keys) || i.keys.length < 1 || i.keys.length > 128) throw new TypeError("Invalid project invitation");
  fromBase64Url(i.signature, 64);
  const envelopes = i.keys.map(normalizeEnvelope), currentKeyId = normalizeKeyId(i.currentKeyId);
  if (new Set(envelopes.map(k => k.keyId)).size !== envelopes.length || !envelopes.some(k => k.keyId === currentKeyId)) throw new TypeError("Duplicate or missing current invitation key");
  return Object.freeze({ version: 1, descriptor: normalizeDescriptor(i.descriptor), certificate: normalizeCertificate(i.certificate),
    keys: Object.freeze(envelopes), currentKeyId, signature: i.signature as string });
}
function invitationText(i: ProjectInvitation): Uint8Array<ArrayBuffer> {
  return encodeBinary(["sovereign-local-core/invitation/v1", i.version, i.descriptor, i.certificate, i.keys, i.currentKeyId]);
}
export async function signInvitation(value: ProjectInvitation, identity: UnlockedIdentity): Promise<ProjectInvitation> {
  if (value.certificate.issuer !== identity.actorId) throw new Error("Invitation signer is not the certificate issuer");
  const i = normalizeInvitation(value);
  const signature = toBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, invitationText(i)));
  return normalizeInvitation({ ...i, signature });
}
export async function verifyInvitationSignature(value: ProjectInvitation): Promise<void> {
  const i = normalizeInvitation(value);
  const key = await crypto.subtle.importKey("raw", fromBase64Url(i.certificate.issuer.slice(5), 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(i.signature, 64), invitationText(i)) &&
      !await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(i.signature, 64), new TextEncoder().encode(JSON.stringify(["sovereign-local-core/invitation/v1", i.version, i.descriptor, i.certificate, i.keys, i.currentKeyId])))) throw new Error("Invalid invitation signature");
}
async function importProjectKey(bytes: Uint8Array<ArrayBuffer>): Promise<ProjectKey> {
  if (bytes.length !== 32) throw new TypeError("Expected AES-256 project key");
  const id = `key_${toBase64Url(await crypto.subtle.digest("SHA-256", bytes))}`;
  return { id, bytes, key: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]) };
}
export function generateProjectKey(): Promise<ProjectKey> { return importProjectKey(crypto.getRandomValues(new Uint8Array(32))); }
function envelopeAAD(projectId: string, e: Pick<KeyEnvelope, "keyId" | "recipient" | "ephemeralPublicKey" | "salt">): Uint8Array<ArrayBuffer> {
  return encodeBinary(["sovereign-local-core/project-key/v1", projectId, e.keyId, e.recipient, e.ephemeralPublicKey, e.salt]);
}
async function wrappingKey(privateKey: CryptoKey, publicKey: CryptoKey, salt: string, info: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  try {
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: fromBase64Url(salt, 32), info }, hkdf,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { shared.fill(0); }
}
export async function wrapProjectKey(key: ProjectKey, projectId: string, recipient: string): Promise<KeyEnvelope> {
  normalizeActorId(recipient);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const header = { keyId: key.id, recipient, ephemeralPublicKey: toBase64Url(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
    salt: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(recipient.slice(5), 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const aad = envelopeAAD(projectId, header), kek = await wrappingKey(ephemeral.privateKey, publicKey, header.salt, aad);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, kek, key.bytes);
  return normalizeEnvelope({ ...header, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) });
}
export async function unwrapProjectKey(value: KeyEnvelope, projectId: string, identity: UnlockedIdentity): Promise<ProjectKey> {
  const e = normalizeEnvelope(value);
  if (e.recipient !== identity.actorId) throw new Error("Project key is addressed to another identity");
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(e.ephemeralPublicKey, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const aad = envelopeAAD(projectId, e), kek = await wrappingKey(identity.agreementKey, publicKey, e.salt, aad);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(e.iv, 12), additionalData: aad, tagLength: 128 }, kek, fromBase64Url(e.ciphertext))); }
  catch (error) {
    if (!(error instanceof DOMException) || error.name !== "OperationError") throw error;
    const legacyAAD = new TextEncoder().encode(JSON.stringify(["sovereign-local-core/project-key/v1", projectId, e.keyId, e.recipient, e.ephemeralPublicKey, e.salt]));
    const legacyKey = await wrappingKey(identity.agreementKey, publicKey, e.salt, legacyAAD);
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(e.iv, 12), additionalData: legacyAAD, tagLength: 128 }, legacyKey, fromBase64Url(e.ciphertext)));
  }
  try {
    const key = await importProjectKey(bytes);
    if (key.id !== e.keyId) throw new Error("Wrapped project key ID mismatch");
    return key;
  } catch (error) { bytes.fill(0); throw error; }
}
export function fieldsAAD(metadata: EventMetadata, type: string, itemId: string, keyId: string): Uint8Array<ArrayBuffer> {
  return encodeBinary(["sovereign-local-core/fields/v1", metadata.schemaVersion, metadata.projectId,
    metadata.id, metadata.actorId, metadata.sequence, metadata.lamport, type, itemId, keyId]);
}
function commandMetadata(aad: Uint8Array<ArrayBuffer>) {
  const p = decodeBinary(aad) as unknown[];
  if (!Array.isArray(p) || p.length !== 10 || p[0] !== "sovereign-local-core/fields/v1") throw new TypeError("Invalid command AAD");
  return { id: p[3] as string, actorId: p[4] as string, sequence: p[5] as number, lamport: p[6] as number,
    type: p[7] as import("./types.js").ItemCommand["type"], itemId: p[8] as string };
}
export async function encryptFields(fields: Fields, aad: Uint8Array<ArrayBuffer>, key: ProjectKey): Promise<Ciphertext> {
  const metadata = commandMetadata(aad);
  const command = normalizeCommand(metadata.type === "ITEM_DELETED" ? { type: metadata.type, itemId: metadata.itemId } :
    { type: metadata.type, itemId: metadata.itemId, fields });
  const iv = crypto.getRandomValues(new Uint8Array(12)), plaintext = encodeCommands([{ ...metadata, ...command }]);
  try { return { iv: toBase64Url(iv), ciphertext: toBase64Url(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key.key, plaintext)) }; }
  finally { plaintext.fill(0); }
}
export async function decryptCommand(value: Ciphertext, aad: Uint8Array<ArrayBuffer>, key: ProjectKey): Promise<Uint8Array<ArrayBuffer>> {
  let plaintext: Uint8Array<ArrayBuffer>;
  try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(value.iv, 12), additionalData: aad, tagLength: 128 }, key.key, fromBase64Url(value.ciphertext))); }
  catch (error) {
    if (!(error instanceof DOMException) || error.name !== "OperationError") throw error;
    // Only legacy authenticated ciphertext uses this decoder/one-time conversion.
    const legacyAAD = new TextEncoder().encode(JSON.stringify(decodeBinary(aad)));
    const legacy = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(value.iv, 12), additionalData: legacyAAD, tagLength: 128 }, key.key, fromBase64Url(value.ciphertext)));
    try {
      const pairs = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(legacy));
      if (!Array.isArray(pairs) || pairs.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string") || new Set(pairs.map(p => p[0])).size !== pairs.length) throw new TypeError("Invalid legacy encrypted fields");
      const metadata = commandMetadata(aad), fields = Object.fromEntries(pairs);
      if (metadata.type === "ITEM_DELETED" && pairs.length) throw new TypeError("Deleted item must have empty fields");
      const command = normalizeCommand(metadata.type === "ITEM_DELETED" ? { type: metadata.type, itemId: metadata.itemId } : { type: metadata.type, itemId: metadata.itemId, fields });
      return encodeCommands([{ ...metadata, ...command }]);
    } finally { legacy.fill(0); }
  }
  try {
    const metadata = commandMetadata(aad);
    requireCommandBinding(plaintext, metadata);
    if (metadata.type === "FILE_ADDED") normalizeCommand({ type: metadata.type, itemId: metadata.itemId, fields: decodeCommandFields(plaintext) });
    return plaintext;
  }
  catch (error) { plaintext.fill(0); throw error; }
}
export async function decryptFields(value: Ciphertext, aad: Uint8Array<ArrayBuffer>, key: ProjectKey): Promise<Record<string, unknown>> {
  const plaintext = await decryptCommand(value, aad, key);
  try { return decodeCommandFields(plaintext); } finally { plaintext.fill(0); }
}

