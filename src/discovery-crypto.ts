import { encodeBinary, decodeBinary } from "./binary-codec.js";
import { exactObject, normalizeCertificate } from "./certificates.js";
import { fromBase64Url, normalizeActorId, toBase64Url } from "./crypto-codec.js";
import type { ProjectKey } from "./project-crypto.js";
import type { Certificate, ProjectDescriptor } from "./types.js";
import { MAX_DISCOVERY_PACKET, type DiscoverySignal } from "./discovery-provider.js";

const TTL = 60000, SKEW = 30000;
export class DiscoveryReplayError extends Error { constructor() { super("Discovery replay rejected"); this.name = "DiscoveryReplayError"; } }
export function discoveryToken(): string { return toBase64Url(crypto.getRandomValues(new Uint8Array(32))); }
function token(value: unknown): string { fromBase64Url(value, 32); return value as string; }
export function normalizeDiscoverySignal(value: unknown): DiscoverySignal {
  const s = exactObject(value, ["kind", "from", "to", "session", "challenge", "response", "description", "candidate"]);
  if (!["hello", "challenge", "proof", "offer", "answer", "ice"].includes(s.kind as string)) throw new TypeError("Unknown discovery signal");
  token(s.from); if (s.to !== null) token(s.to);
  if (s.session !== null) token(s.session);
  if (s.challenge !== null) token(s.challenge); if (s.response !== null) token(s.response);
  let description: RTCSessionDescriptionInit | null = null, candidate: RTCIceCandidateInit | null = null;
  if (s.kind === "hello") {
    if ([s.to, s.session, s.challenge, s.response, s.description, s.candidate].some(v => v !== null)) throw new TypeError("Invalid hello");
  } else {
    if (s.to === null || s.session === null || s.challenge === null || s.to === s.from) throw new TypeError("Addressed discovery signal required");
    if (s.kind === "challenge" ? s.response !== null : s.response === null) throw new TypeError("Invalid freshness proof");
    if (s.kind === "offer" || s.kind === "answer") {
      const d = exactObject(s.description, ["type", "sdp"]);
      if (d.type !== s.kind || typeof d.sdp !== "string" || !d.sdp.length || d.sdp.length > 12000 || s.candidate !== null) throw new TypeError("Invalid SDP");
      description = { type: d.type as "offer" | "answer", sdp: d.sdp };
    } else if (s.kind === "ice") {
      const c = exactObject(s.candidate, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]);
      if (typeof c.candidate !== "string" || c.candidate.length > 2048 ||
          (c.sdpMid !== null && (typeof c.sdpMid !== "string" || c.sdpMid.length > 256)) ||
          (c.usernameFragment !== null && (typeof c.usernameFragment !== "string" || c.usernameFragment.length > 256)) ||
          (c.sdpMLineIndex !== null && (!Number.isInteger(c.sdpMLineIndex) || (c.sdpMLineIndex as number) < 0 || (c.sdpMLineIndex as number) > 65535)) || s.description !== null) throw new TypeError("Invalid ICE candidate");
      candidate = c as unknown as RTCIceCandidateInit;
    } else if (s.description !== null || s.candidate !== null) throw new TypeError("Unexpected discovery body");
  }
  return Object.freeze({ ...s, description, candidate }) as unknown as DiscoverySignal;
}
export interface DiscoveryPayload {
  version: 1; projectId: string; rootActorId: string; keyId: string; actorId: string;
  certificate: Certificate; nonce: string; issuedAt: number; expiresAt: number; signal: DiscoverySignal;
}
export interface DiscoveryMaterial { topic: string; key: CryptoKey; aad: Uint8Array<ArrayBuffer> }
/** Domain-separated rendezvous key and opaque topic; project AES bytes stay in Worker. */
export async function deriveDiscoveryMaterial(project: ProjectDescriptor, key: ProjectKey): Promise<DiscoveryMaterial> {
  const salt = await crypto.subtle.digest("SHA-256", encodeBinary([project.projectId, project.rootActorId]));
  const base = await crypto.subtle.importKey("raw", key.bytes, "HKDF", false, ["deriveBits"]);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt,
    info: encodeBinary(["sovereign-local-core/rendezvous/v1", key.id]) }, base, 256));
  try {
    const rendezvous = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
    const topic = toBase64Url(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt,
      info: encodeBinary(["sovereign-local-core/discovery-topic/v1"]) }, rendezvous, 256));
    const cipher = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt,
      info: encodeBinary(["sovereign-local-core/discovery-aes/v1"]) }, rendezvous, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { topic, key: cipher, aad: encodeBinary(["sovereign-local-core/discovery/v1", project.projectId, project.rootActorId, key.id, topic]) };
  } finally { secret.fill(0); }
}
export function discoveryPayload(project: ProjectDescriptor, keyId: string, actorId: string, certificate: Certificate, signal: unknown): DiscoveryPayload {
  const issuedAt = Date.now();
  return { version: 1, projectId: project.projectId, rootActorId: project.rootActorId, keyId, actorId, certificate,
    nonce: discoveryToken(), issuedAt, expiresAt: issuedAt + TTL, signal: normalizeDiscoverySignal(signal) };
}
export async function sealDiscoveryPayload(payload: DiscoveryPayload, material: DiscoveryMaterial, privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = encodeBinary(payload);
  if (bytes.length > MAX_DISCOVERY_PACKET - 256) throw new RangeError("Discovery payload too large");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes));
  const plaintext = encodeBinary({ payload, signature }), iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: material.aad }, material.key, plaintext));
    const packet = encodeBinary({ version: 1, iv, ciphertext });
    if (packet.length > MAX_DISCOVERY_PACKET) throw new RangeError("Discovery packet too large");
    return packet;
  } finally { bytes.fill(0); plaintext.fill(0); }
}
export async function decryptDiscoveryPayload(packet: Uint8Array<ArrayBuffer>, material: DiscoveryMaterial): Promise<{ payload: DiscoveryPayload; signature: Uint8Array<ArrayBuffer> }> {
  if (!(packet instanceof Uint8Array) || packet.length > MAX_DISCOVERY_PACKET) throw new RangeError("Invalid discovery packet size");
  const e = exactObject(decodeBinary(packet), ["version", "iv", "ciphertext"]);
  if (e.version !== 1 || !(e.iv instanceof Uint8Array) || e.iv.length !== 12 || !(e.ciphertext instanceof Uint8Array) || e.ciphertext.length < 16) throw new TypeError("Invalid discovery ciphertext");
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: e.iv as Uint8Array<ArrayBuffer>, additionalData: material.aad }, material.key, e.ciphertext as Uint8Array<ArrayBuffer>));
  try {
    const signed = exactObject(decodeBinary(plaintext), ["payload", "signature"]);
    if (!(signed.signature instanceof Uint8Array) || signed.signature.length !== 64) throw new TypeError("Invalid discovery signature");
    const p = exactObject(signed.payload, ["version", "projectId", "rootActorId", "keyId", "actorId", "certificate", "nonce", "issuedAt", "expiresAt", "signal"]);
    if (p.version !== 1 || typeof p.projectId !== "string" || typeof p.keyId !== "string") throw new TypeError("Invalid discovery payload");
    normalizeActorId(p.actorId); normalizeActorId(p.rootActorId); token(p.nonce);
    const payload = { ...p, certificate: normalizeCertificate(p.certificate), signal: normalizeDiscoverySignal(p.signal) } as unknown as DiscoveryPayload;
    return { payload, signature: signed.signature as Uint8Array<ArrayBuffer> };
  } finally { plaintext.fill(0); }
}
/** Do not evict unexpired nonces to make room: saturation fails closed. */
export class DiscoveryReplayWindow {
  private readonly seen = new Map<string, number>();
  accept(payload: Pick<DiscoveryPayload, "actorId" | "nonce" | "issuedAt" | "expiresAt">, now = Date.now()): void {
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > TTL || payload.issuedAt > now + SKEW || payload.expiresAt < now - SKEW) throw new Error("Expired or invalid discovery time window");
    for (const [nonce, expiry] of this.seen) if (expiry < now) this.seen.delete(nonce);
    const nonce = `${payload.actorId}:${payload.nonce}`;
    if (this.seen.has(nonce)) throw new DiscoveryReplayError();
    if (this.seen.size >= 4096) throw new Error("Discovery replay window is full");
    this.seen.set(nonce, payload.expiresAt + SKEW);
  }
}
