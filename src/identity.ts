import { fromBase64Url, normalizeActorId, toBase64Url } from "./crypto-codec.js";
import { canonicalEventBytes, legacyEventText, normalizeEvent, normalizeUnsignedEvent } from "./validation.js";
import type { IEvent, UnsignedEvent } from "./types.js";

export const PBKDF2_ITERATIONS = 600000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
const signatureAlgorithm = { name: "ECDSA", hash: "SHA-256" } as const;

export interface IdentityVault {
  readonly version: 1;
  readonly kdf: "PBKDF2-SHA-256";
  readonly iterations: number;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

/** These handles stay inside the worker in the normal client API; they are never returned by RPC. */
export interface UnlockedIdentity {
  readonly actorId: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** Same P-256 identity point imported for ECDH; not exposed by client RPC. */
  readonly agreementKey: CryptoKey;
}

export class IdentityUnlockError extends Error {
  constructor() { super("Identity vault could not be unlocked: credentials or vault integrity are invalid"); this.name = "IdentityUnlockError"; }
}
export class InvalidEventSignatureError extends Error {
  constructor() { super("Invalid event signature"); this.name = "InvalidEventSignatureError"; }
}
export class EventProjectMismatchError extends Error {
  constructor() { super("Signed event belongs to another project"); this.name = "EventProjectMismatchError"; }
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Email required");
  const email = value.trim().normalize("NFC").toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError("Invalid email identifier");
  return email;
}

function passwordInput(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 1024) {
    throw new TypeError("Password must contain 12–1024 characters");
  }
  return value; // Passwords are not trimmed or case-normalized.
}

export function normalizeVault(value: unknown): IdentityVault {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid identity vault");
  const vault = value as Record<string, unknown>;
  if (Object.keys(vault).sort().join(",") !== "ciphertext,iterations,iv,kdf,salt,version" ||
      vault.version !== 1 || vault.kdf !== "PBKDF2-SHA-256" || vault.iterations !== PBKDF2_ITERATIONS) {
    throw new TypeError("Unsupported vault format or KDF parameters");
  }
  fromBase64Url(vault.salt, 16); fromBase64Url(vault.iv, 12);
  const ciphertext = fromBase64Url(vault.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > 8192) throw new TypeError("Invalid vault ciphertext size");
  return Object.freeze({ version: 1, kdf: "PBKDF2-SHA-256", iterations: PBKDF2_ITERATIONS,
    salt: vault.salt as string, iv: vault.iv as string, ciphertext: vault.ciphertext as string });
}

function aad(vault: Omit<IdentityVault, "ciphertext">, email: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["sovereign-local-core/vault/v1", email,
    vault.version, vault.kdf, vault.iterations, vault.salt, vault.iv]));
}

async function deriveVaultKey(email: string, password: string, salt: string): Promise<CryptoKey> {
  // Length-delimited JSON avoids ambiguity between email/password combinations.
  const input = encoder.encode(JSON.stringify(["sovereign-local-core/credentials/v1", email, password]));
  try {
    const base = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "PBKDF2", salt: fromBase64Url(salt, 16),
      iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { input.fill(0); }
}

export async function createIdentityVault(emailInput: string, password: string): Promise<{ vault: IdentityVault; identity: UnlockedIdentity }> {
  return createVault(normalizeEmail(emailInput), password);
}
export function normalizeWalletId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("Wallet ID must be 1–128 ASCII letters, digits, _ or -");
  return value;
}
export function createWalletVault(walletId: string, passphrase: string): Promise<{ vault: IdentityVault; identity: UnlockedIdentity }> {
  return createVault(`sovereign-wallet/v1:${normalizeWalletId(walletId)}`, passphrase);
}
export function unlockWalletVault(vault: unknown, walletId: string, passphrase: string): Promise<UnlockedIdentity> {
  return unlockVault(vault, `sovereign-wallet/v1:${normalizeWalletId(walletId)}`, passphrase);
}
async function createVault(email: string, password: string): Promise<{ vault: IdentityVault; identity: UnlockedIdentity }> {
  passwordInput(password);
  const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const header = { version: 1, kdf: "PBKDF2-SHA-256", iterations: PBKDF2_ITERATIONS,
    salt: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    iv: toBase64Url(crypto.getRandomValues(new Uint8Array(12))) } as const;
  const key = await deriveVaultKey(email, password, header.salt);
  const plaintext = encoder.encode(JSON.stringify({ version: 1,
    privateKey: toBase64Url(privateBytes), publicKey: toBase64Url(raw) }));
  try {
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: fromBase64Url(header.iv, 12),
      additionalData: aad(header, email), tagLength: 128 }, key, plaintext);
    const vault = normalizeVault({ ...header, ciphertext: toBase64Url(encrypted) });
    // Re-import private material non-extractably; do not retain the exportable generated key.
    const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, algorithm, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("raw", raw, algorithm, false, ["verify"]);
    const agreementKey = await crypto.subtle.importKey("pkcs8", privateBytes, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { vault, identity: Object.freeze({ actorId: `p256_${toBase64Url(raw)}`, privateKey, publicKey, agreementKey }) };
  } finally { privateBytes.fill(0); plaintext.fill(0); }
}

export async function unlockIdentityVault(value: unknown, emailInput: string, password: string): Promise<UnlockedIdentity> {
  return unlockVault(value, normalizeEmail(emailInput), password);
}
async function unlockVault(value: unknown, email: string, password: string): Promise<UnlockedIdentity> {
  const vault = normalizeVault(value);
  passwordInput(password);
  const key = await deriveVaultKey(email, password, vault.salt);
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  let privateBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(vault.iv, 12),
      additionalData: aad(vault, email), tagLength: 128 }, key, fromBase64Url(vault.ciphertext)));
    const content = JSON.parse(decoder.decode(plaintext));
    if (Object.keys(content).sort().join(",") !== "privateKey,publicKey,version" || content.version !== 1) throw new Error();
    privateBytes = fromBase64Url(content.privateKey);
    const raw = fromBase64Url(content.publicKey, 65);
    const actorId = normalizeActorId(`p256_${toBase64Url(raw)}`);
    const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, algorithm, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("raw", raw, algorithm, false, ["verify"]);
    const agreementKey = await crypto.subtle.importKey("pkcs8", privateBytes, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const challenge = encoder.encode("sovereign-local-core/vault-key-pair/v1");
    const signature = await crypto.subtle.sign(signatureAlgorithm, privateKey, challenge);
    if (!await crypto.subtle.verify(signatureAlgorithm, publicKey, signature, challenge)) throw new Error();
    return Object.freeze({ actorId, privateKey, publicKey, agreementKey });
  } catch { throw new IdentityUnlockError(); }
  finally { plaintext?.fill(0); privateBytes?.fill(0); }
}

export async function signEvent(value: UnsignedEvent, identity: UnlockedIdentity): Promise<IEvent> {
  const event = normalizeUnsignedEvent(value);
  if (event.actorId !== identity.actorId) throw new Error("Cannot sign as another actor");
  const signature = await crypto.subtle.sign(signatureAlgorithm, identity.privateKey, canonicalEventBytes(event));
  return normalizeEvent({ ...event, signature: toBase64Url(signature) });
}

const publicKeys = new Map<string, Promise<CryptoKey>>();
function verificationKey(actorId: string): Promise<CryptoKey> {
  let key = publicKeys.get(actorId);
  if (!key) {
    if (publicKeys.size >= 128) publicKeys.delete(publicKeys.keys().next().value!);
    key = crypto.subtle.importKey("raw", fromBase64Url(actorId.slice(5), 65), algorithm, false, ["verify"]);
    publicKeys.set(actorId, key);
  }
  return key;
}

export async function verifySignature(value: unknown): Promise<boolean> {
  try {
    const { signature, ...event } = normalizeEvent(value);
    const key = await verificationKey(event.actorId), bytes = fromBase64Url(signature, 64);
    return await crypto.subtle.verify(signatureAlgorithm, key, bytes, canonicalEventBytes(event)) ||
      (event.schemaVersion === 3 && await crypto.subtle.verify(signatureAlgorithm, key, bytes, encoder.encode(legacyEventText(event))));
  } catch { return false; }
}

export async function requireValidEvent(value: unknown, projectId: string): Promise<IEvent> {
  const event = normalizeEvent(value);
  if (event.projectId !== projectId) throw new EventProjectMismatchError();
  if (!await verifySignature(event)) throw new InvalidEventSignatureError();
  return event;
}
