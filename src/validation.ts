import { encodeWire } from "./binary-events.js";
import { toBase64Url } from "./crypto-codec.js";
import type { Fields, IEvent, ItemCommand, UnsignedEvent } from "./types.js";
import { fromBase64Url, normalizeActorId, normalizeProjectId } from "./crypto-codec.js";
import { exactObject, normalizeCertificate } from "./certificates.js";
import { normalizeCiphertext, normalizeEnvelope, normalizeInvitation, normalizeKeyId } from "./project-crypto.js";
import { manifestFromFields } from "./storage-format.js";

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Expected a plain object");
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(compareText);
  if (actual.join(",") !== [...expected].sort(compareText).join(",")) {
    throw new TypeError("Missing or unknown properties");
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${label} must contain 1–128 ASCII letters, digits, _ or -`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function fields(value: unknown): Fields {
  const input = record(value);
  const output: Record<string, string | number | boolean | null> = Object.create(null);
  for (const key of Object.keys(input).sort(compareText)) {
    if (!key.length || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TypeError("Invalid field name");
    }
    const field = input[key];
    if (field !== null && typeof field !== "string" && typeof field !== "boolean" &&
        !(typeof field === "number" && Number.isFinite(field))) {
      throw new TypeError(`Field ${key} must be a finite JSON scalar`);
    }
    output[key] = typeof field === "number" && Object.is(field, -0) ? 0 : field;
  }
  return Object.freeze(output);
}

function commandParts(input: Record<string, unknown>): ItemCommand {
  const itemId = identifier(input.itemId, "itemId");
  if (input.type === "ITEM_DELETED") {
    return { type: input.type, itemId };
  }
  if (input.type !== "ITEM_ADDED" && input.type !== "ITEM_UPDATED" && input.type !== "FILE_ADDED") {
    throw new TypeError("Unsupported event type");
  }
  const normalized = fields(input.fields);
  if (input.type === "FILE_ADDED") {
    keys(normalized, ["manifest", "storageType"]);
    if (manifestFromFields(normalized).fileId !== itemId) throw new TypeError("File manifest ID mismatch");
  }
  return { type: input.type, itemId, fields: normalized };
}

export function normalizeCommand(value: unknown): ItemCommand {
  const input = record(value);
  keys(input, input.type === "ITEM_DELETED" ? ["type", "itemId"] : ["type", "itemId", "fields"]);
  return Object.freeze(commandParts(input));
}

export function normalizeUnsignedEvent(value: unknown): UnsignedEvent {
  const input = record(value);
  const expected = ["schemaVersion", "projectId", "id", "actorId", "sequence", "lamport", "type", "certificate"];
  if (input.type === "MEMBER_INVITED") expected.push("invitation");
  else if (input.type === "MEMBER_REVOKED") expected.push("revocation");
  else expected.push("itemId", "keyId", "encryptedFields");
  keys(input, expected);
  if (input.schemaVersion !== 3) throw new TypeError("Encrypted authorized event schema version 3 required; legacy logs require explicit migration");
  const actorId = normalizeActorId(input.actorId);
  const sequence = positiveInteger(input.sequence, "sequence");
  const lamport = positiveInteger(input.lamport, "lamport");
  if (input.id !== `${actorId}:${sequence}`) throw new TypeError("Event id does not match actor/sequence");
  const metadata = {
    schemaVersion: 3 as const,
    projectId: normalizeProjectId(input.projectId),
    id: input.id,
    actorId,
    sequence,
    lamport,
    certificate: normalizeCertificate(input.certificate),
  };
  if (input.type === "MEMBER_INVITED") return Object.freeze({ ...metadata, type: input.type, invitation: normalizeInvitation(input.invitation) });
  if (input.type === "MEMBER_REVOKED") {
    const r = exactObject(input.revocation, ["targetActorId", "allowedHistory", "keyId", "envelopes"]);
    if (!Array.isArray(r.allowedHistory) || r.allowedHistory.length > 4096 || !Array.isArray(r.envelopes) || r.envelopes.length > 4096) throw new TypeError("Invalid revocation bounds");
    const allowedHistory = r.allowedHistory.map(value => {
      const entry = exactObject(value, ["id", "digest"]);
      if (typeof entry.id !== "string" || entry.id.length > 128) throw new TypeError("Invalid history ID");
      fromBase64Url(entry.digest, 32);
      return Object.freeze({ id: entry.id, digest: entry.digest as string });
    });
    if (new Set(allowedHistory.map(e => e.id)).size !== allowedHistory.length) throw new TypeError("Duplicate history ID");
    return Object.freeze({ ...metadata, type: input.type, revocation: Object.freeze({ targetActorId: normalizeActorId(r.targetActorId),
      keyId: normalizeKeyId(r.keyId), allowedHistory: Object.freeze(allowedHistory), envelopes: Object.freeze(r.envelopes.map(normalizeEnvelope)) }) });
  }
  if (!["ITEM_ADDED", "ITEM_UPDATED", "ITEM_DELETED", "FILE_ADDED"].includes(input.type as string)) throw new TypeError("Unsupported event type");
  return Object.freeze({ ...metadata, type: input.type as ItemCommand["type"], itemId: identifier(input.itemId, "itemId"),
    keyId: normalizeKeyId(input.keyId), encryptedFields: normalizeCiphertext(input.encryptedFields) });
}

export function normalizeEvent(value: unknown): IEvent {
  const input = record(value);
  const { signature, ...unsigned } = input;
  fromBase64Url(signature, 64); // Web Crypto P-256 signatures use IEEE P1363 r||s, not DER.
  return Object.freeze({ ...normalizeUnsignedEvent(unsigned), signature: signature as string });
}

/** Domain-separated fixed tuple; field pairs are ordinal-sorted. Signature is not part of its own payload. */
export function canonicalEventBytes(value: UnsignedEvent): Uint8Array<ArrayBuffer> {
  const event = normalizeUnsignedEvent(value);
  const body = event.type === "MEMBER_INVITED" ? event.invitation : event.type === "MEMBER_REVOKED" ? event.revocation :
    { itemId: event.itemId, keyId: event.keyId, encryptedFields: event.encryptedFields };
  return encodeWire(["sovereign-local-core/event-binary/v1", event.schemaVersion, event.projectId, event.id,
    event.actorId, event.sequence, event.lamport, event.certificate, event.type, body]);
}

/** Read-only compatibility transcript for already signed JSON v3 history. New events never use it. */
export function legacyEventText(value: UnsignedEvent): string {
  const e = normalizeUnsignedEvent(value);
  const body = e.type === "MEMBER_INVITED" ? e.invitation : e.type === "MEMBER_REVOKED" ? e.revocation :
    [e.itemId, e.keyId, e.encryptedFields.iv, e.encryptedFields.ciphertext];
  return JSON.stringify(["sovereign-local-core/event/v3", e.schemaVersion, e.projectId, e.id, e.actorId, e.sequence, e.lamport, e.certificate, e.type, body]);
}
export function canonicalEventText(value: UnsignedEvent): string { return toBase64Url(canonicalEventBytes(value)); }

/** Deduplicate content, not randomized/malleable ECDSA signature bytes. Verify BEFORE using this identity. */
export function eventText(event: IEvent): string {
  const { signature: _, ...unsigned } = normalizeEvent(event);
  return canonicalEventText(unsigned);
}

export function nextInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Logical counter exhausted");
  }
  return value + 1;
}
