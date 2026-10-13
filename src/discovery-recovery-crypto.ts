import { encodeBinary, decodeBinary } from "./binary-codec.js";
import { exactObject, normalizeCertificate } from "./certificates.js";
import { fromBase64Url, normalizeActorId, toBase64Url } from "./crypto-codec.js";
import type { UnlockedIdentity } from "./identity.js";
import type { Certificate, ProjectDescriptor } from "./types.js";
import type { ProjectKey } from "./project-crypto.js";
import { MAX_DISCOVERY_PACKET } from "./discovery-provider.js";
import { discoveryToken } from "./discovery-crypto.js";

export const RECOVERY_FRAGMENT_BYTES = 16 * 1024;
export const MAX_RECOVERY_CONTROLS = 65536;
type Kind = "request" | "response";
export interface RecoveryMaterial { topic: string; key: CryptoKey; aad: Uint8Array<ArrayBuffer> }
interface IdentityProof { actorId: string; certificate: Certificate; nonce: string; issuedAt: number; expiresAt: number }
export interface RecoveryRequest extends IdentityProof {
  session: string; responder: string | null; cursor: string | null;
  index: number; offset: number; knownKeyId: string | null;
  replyTo?: string;
}
export interface RecoveryResponse extends IdentityProof {
  requestId: string; session: string; recipient: string; cursor: string | null;
  index: number; offset: number; totalBytes: number; count: number;
  bytes: Uint8Array<ArrayBuffer>; keyId: string; done: boolean;
  replyTo?: string;
  offer?: true;
}
const token = (v: unknown): string => { fromBase64Url(v, 32); return v as string; };
const integer = (v: unknown, max: number): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new TypeError("Invalid recovery range");
  return v as number;
};
function proof(p: Record<string, unknown>): IdentityProof {
  return { actorId: normalizeActorId(p.actorId), certificate: normalizeCertificate(p.certificate), nonce: token(p.nonce),
    issuedAt: integer(p.issuedAt, Number.MAX_SAFE_INTEGER), expiresAt: integer(p.expiresAt, Number.MAX_SAFE_INTEGER) };
}
function keyId(value: unknown): string { if (typeof value !== "string" || !value.startsWith("key_")) throw new TypeError("Invalid recovery key"); fromBase64Url(value.slice(4), 32); return value; }
export function normalizeRecoveryRequest(value: unknown): RecoveryRequest {
  const routed = !!value && typeof value === "object" && "replyTo" in value;
  const p = exactObject(value, ["actorId", "certificate", "nonce", "issuedAt", "expiresAt", "session", "responder", "cursor", "index", "offset", "knownKeyId", ...(routed ? ["replyTo"] : [])]);
  const result = { ...proof(p), session: token(p.session), responder: p.responder === null ? null : normalizeActorId(p.responder),
    cursor: p.cursor === null ? null : token(p.cursor), index: integer(p.index, MAX_RECOVERY_CONTROLS),
    offset: integer(p.offset, 1024 * 1024), knownKeyId: p.knownKeyId === null ? null : keyId(p.knownKeyId), ...(routed ? { replyTo: token(p.replyTo) } : {}) };
  if (result.cursor === null && ((!routed && result.responder !== null) || result.index || result.offset)) throw new TypeError("Invalid initial recovery request");
  if (result.cursor !== null && result.responder === null) throw new TypeError("Recovery cursor needs a responder");
  return Object.freeze(result);
}
export function normalizeRecoveryResponse(value: unknown): RecoveryResponse {
  const routed = !!value && typeof value === "object" && "replyTo" in value;
  const offer = !!value && typeof value === "object" && "offer" in value;
  const p = exactObject(value, ["actorId", "certificate", "nonce", "issuedAt", "expiresAt", "requestId", "session", "recipient", "cursor", "index", "offset", "totalBytes", "count", "bytes", "keyId", "done", ...(routed ? ["replyTo"] : []), ...(offer ? ["offer"] : [])]);
  if (offer && (!routed || p.offer !== true)) throw new TypeError("Invalid routed recovery offer");
  if (!(p.bytes instanceof Uint8Array) || p.bytes.length > RECOVERY_FRAGMENT_BYTES || typeof p.done !== "boolean") throw new TypeError("Invalid recovery fragment");
  const r = { ...proof(p), requestId: token(p.requestId), session: token(p.session), recipient: normalizeActorId(p.recipient), cursor: offer && p.cursor === null ? null : token(p.cursor),
    index: integer(p.index, MAX_RECOVERY_CONTROLS), offset: integer(p.offset, 1024 * 1024), totalBytes: integer(p.totalBytes, 1024 * 1024),
    count: integer(p.count, MAX_RECOVERY_CONTROLS), bytes: p.bytes.slice(), keyId: keyId(p.keyId), done: p.done,
    ...(routed ? { replyTo: token(p.replyTo) } : {}), ...(offer ? { offer: true as const } : {}) };
  if (offer ? r.cursor !== null || r.done || r.index !== 0 || r.offset !== 0 || r.count !== 0 || r.totalBytes !== 0 || r.bytes.length !== 0 :
      r.done ? r.index !== r.count || r.offset !== 0 || r.totalBytes !== 0 || r.bytes.length !== 0 :
      r.index >= r.count || !r.totalBytes || !r.bytes.length || r.offset + r.bytes.length > r.totalBytes) throw new TypeError("Invalid recovery fragment placement");
  return Object.freeze(r);
}
export function recoveryProof(actorId: string, certificate: Certificate): IdentityProof {
  const issuedAt = Date.now(); return { actorId, certificate, nonce: discoveryToken(), issuedAt, expiresAt: issuedAt + 60000 };
}
export async function deriveRecoveryMaterial(project: ProjectDescriptor, genesis: ProjectKey): Promise<RecoveryMaterial> {
  const aad = encodeBinary(["slc/recovery-channel/v1", project.projectId, project.rootActorId, project.genesisKeyId]);
  const salt = await crypto.subtle.digest("SHA-256", aad);
  const base = await crypto.subtle.importKey("raw", genesis.bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
  const topic = toBase64Url(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt,
    info: encodeBinary(["slc/recovery-topic/v1"]) }, base, 256));
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt,
    info: encodeBinary(["slc/recovery-aes/v1"]) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { topic, key, aad };
}
function envelope(packet: Uint8Array<ArrayBuffer>) {
  if (!(packet instanceof Uint8Array) || packet.length > MAX_DISCOVERY_PACKET) throw new RangeError("Invalid recovery packet size");
  const e = exactObject(decodeBinary(packet), ["v", "kind", "iv", "ciphertext"]);
  if (e.v !== 1 || !["request", "response"].includes(e.kind as string) || !(e.iv instanceof Uint8Array) || e.iv.length !== 12 ||
      !(e.ciphertext instanceof Uint8Array) || e.ciphertext.length < 16) throw new TypeError("Invalid recovery packet");
  return e as { v: number; kind: Kind; iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> };
}
export function recoveryPacketKind(packet: Uint8Array<ArrayBuffer>): Kind { return envelope(packet).kind; }
function aad(material: RecoveryMaterial, kind: Kind) { return encodeBinary([material.aad, kind]); }
async function wrap(kind: Kind, value: unknown, material: RecoveryMaterial): Promise<Uint8Array<ArrayBuffer>> {
  const plain = encodeBinary(value), iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(material, kind) }, material.key, plain));
    const packet = encodeBinary({ v: 1, kind, iv, ciphertext });
    if (packet.length > MAX_DISCOVERY_PACKET) throw new RangeError("Recovery packet exceeds budget"); return packet;
  } finally { plain.fill(0); }
}
async function unwrap(packet: Uint8Array<ArrayBuffer>, kind: Kind, material: RecoveryMaterial): Promise<unknown> {
  const e = envelope(packet); if (e.kind !== kind) throw new TypeError("Wrong recovery packet kind");
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: e.iv, additionalData: aad(material, kind) }, material.key, e.ciphertext));
  try { return decodeBinary(plain); } finally { plain.fill(0); }
}
function transcript(kind: Kind, value: unknown) { return encodeBinary(["slc/recovery-signature/v1", kind, value]); }
async function signed(kind: Kind, payload: unknown, identity: UnlockedIdentity) {
  const bytes = transcript(kind, payload);
  try { return { payload, signature: new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, bytes)) }; }
  finally { bytes.fill(0); }
}
export async function verifyRecoverySignature(kind: Kind, payload: { actorId: string }, signature: Uint8Array<ArrayBuffer>): Promise<void> {
  const key = await crypto.subtle.importKey("raw", fromBase64Url(payload.actorId.slice(5), 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, transcript(kind, payload))) throw new Error("Invalid recovery signature");
}
function unpack(value: unknown) {
  const s = exactObject(value, ["payload", "signature"]);
  if (!(s.signature instanceof Uint8Array) || s.signature.length !== 64) throw new TypeError("Invalid recovery signature size");
  return { payload: s.payload, signature: s.signature as Uint8Array<ArrayBuffer> };
}
export async function sealRecoveryRequest(value: RecoveryRequest, material: RecoveryMaterial, identity: UnlockedIdentity) {
  const p = normalizeRecoveryRequest(value); if (p.actorId !== identity.actorId) throw new Error("Cannot impersonate a recovery requester");
  return wrap("request", await signed("request", p, identity), material);
}
export async function openRecoveryRequest(packet: Uint8Array<ArrayBuffer>, material: RecoveryMaterial) {
  const s = unpack(await unwrap(packet, "request", material)); return { payload: normalizeRecoveryRequest(s.payload), signature: s.signature };
}
async function responseKey(privateKey: CryptoKey, publicKey: CryptoKey, header: unknown) {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  try {
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]), info = encodeBinary(["slc/recovery-recipient-key/v1", header]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: await crypto.subtle.digest("SHA-256", info), info }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { shared.fill(0); }
}
export async function sealRecoveryResponse(value: RecoveryResponse, material: RecoveryMaterial, identity: UnlockedIdentity) {
  const p = normalizeRecoveryResponse(value); if (p.actorId !== identity.actorId) throw new Error("Cannot impersonate a recovery responder");
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const header = { channel: material.aad, recipient: p.recipient, ephemeral: toBase64Url(await crypto.subtle.exportKey("raw", ephemeral.publicKey)) };
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(p.recipient.slice(5), 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await responseKey(ephemeral.privateKey, publicKey, header), iv = crypto.getRandomValues(new Uint8Array(12)), plain = encodeBinary(await signed("response", p, identity));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encodeBinary(header) }, key, plain));
    return wrap("response", { recipient: p.recipient, ephemeral: header.ephemeral, iv, ciphertext }, material);
  } finally { plain.fill(0); }
}
export async function openRecoveryResponse(packet: Uint8Array<ArrayBuffer>, material: RecoveryMaterial, identity: UnlockedIdentity) {
  const box = exactObject(await unwrap(packet, "response", material), ["recipient", "ephemeral", "iv", "ciphertext"]);
  normalizeActorId(box.recipient); fromBase64Url(box.ephemeral, 65);
  if (!(box.iv instanceof Uint8Array) || box.iv.length !== 12 || !(box.ciphertext instanceof Uint8Array)) throw new TypeError("Invalid recipient recovery box");
  if (box.recipient !== identity.actorId) return null;
  const header = { channel: material.aad, recipient: box.recipient, ephemeral: box.ephemeral };
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(box.ephemeral, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await responseKey(identity.agreementKey, publicKey, header);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv as Uint8Array<ArrayBuffer>, additionalData: encodeBinary(header) }, key, box.ciphertext as Uint8Array<ArrayBuffer>));
  try { const s = unpack(decodeBinary(plain)); return { payload: normalizeRecoveryResponse(s.payload), signature: s.signature }; }
  finally { plain.fill(0); }
}
