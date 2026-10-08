export function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(value: unknown, expectedBytes?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > 1398104 || (expectedBytes !== undefined && value.length !== Math.ceil(expectedBytes * 8 / 6)) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Invalid base64url encoding");
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (toBase64Url(bytes) !== value || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    throw new TypeError("Noncanonical or wrong-length base64url value");
  }
  return bytes;
}

/** Actor ID contains the full SEC1 public point, not a hash or a server-assigned ID. */
export function normalizeActorId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("p256_")) throw new TypeError("P-256 public-key actor ID required");
  const raw = fromBase64Url(value.slice(5), 65);
  if (raw[0] !== 4) throw new TypeError("Uncompressed P-256 public point required");
  return value;
}

export function normalizeProjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("Invalid project ID");
  return value;
}
