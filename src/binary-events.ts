import { encodeBinary, decodeBinary } from "./binary-codec.js";
import { fromBase64Url, toBase64Url } from "./crypto-codec.js";
const binaryKeys = new Set(["iv", "ciphertext", "signature", "ephemeralPublicKey", "salt", "digest"]);
function transform(value: unknown, inbound: boolean, key = "", depth = 0): unknown {
  if (depth > 32) throw new TypeError("Binary event nesting limit");
  if (binaryKeys.has(key)) {
    if (inbound && value instanceof Uint8Array) return toBase64Url(value);
    if (!inbound && typeof value === "string") return fromBase64Url(value);
  }
  if (Array.isArray(value)) return value.map(v => transform(v, inbound, "", depth + 1));
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value)) Object.defineProperty(result, k, { value: transform((value as Record<string, unknown>)[k], inbound, k, depth + 1), enumerable: true });
    return result;
  }
  return value;
}
/** Raw signatures, IVs and ciphertext on disk/wire; compatibility objects at the public API. */
export function encodeWire(value: unknown): Uint8Array<ArrayBuffer> { return encodeBinary(transform(value, false)); }
export function decodeWire(value: Uint8Array): unknown { return transform(decodeBinary(value), true); }
