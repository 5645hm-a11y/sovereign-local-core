import { encodeBinary, decodeBinary } from "./binary-codec.js";
import { encodeWire } from "./binary-events.js";
import { fromBase64Url, toBase64Url, normalizeActorId, normalizeProjectId } from "./crypto-codec.js";
import { exactObject, normalizeCertificate } from "./certificates.js";
import { normalizeKeyId } from "./project-crypto.js";
import type { Certificate, Fields } from "./types.js";

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * CHUNK_BYTES;
export const MAX_BLOB_BYTES = 16 * CHUNK_BYTES;
export const CHUNK_OVERHEAD = 40; // magic/version/plaintext length/IV + GCM tag
const MAGIC = 0x31424c53; // SLB1
export interface FileManifest {
  readonly version: 1; readonly fileId: string; readonly name: string; readonly mime: string;
  readonly size: number; readonly chunkSize: number; readonly keyId: string; readonly chunks: readonly string[];
}
export interface ChunkRequest {
  readonly version: 1; readonly requestId: string; readonly projectId: string; readonly rootActorId: string;
  readonly genesisKeyId: string; readonly actorId: string; readonly certificate: Certificate;
  readonly fileId: string; readonly index: number; readonly hash: string; readonly signature: string;
}
export interface IBlobStore {
  get(hash: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Must resolve after complete durable ciphertext write. */
  put(hash: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}
export interface IChunkProvider { serveChunk(request: ChunkRequest): Promise<Uint8Array<ArrayBuffer> | null> }
export interface IChunkTransport { requestChunk(request: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> }
export interface StorageProgress {
  readonly direction: "upload" | "download";
  readonly completedChunks: number; readonly totalChunks: number;
  readonly processedBytes: number; readonly totalBytes: number;
  readonly fileId: string;
  /** Upload counts durable local chunks; download also reports verified cache hits. */
  readonly cachedChunks: number;
}
export interface StorageReadOptions { readonly signal?: AbortSignal; readonly onProgress?: (progress: StorageProgress) => void }
export interface UploadOptions extends StorageReadOptions {
  readonly name?: string; readonly mime?: string; readonly chunkSize?: number;
  /** Optional immutable namespace, e.g. file_private_; default remains file_. */
  readonly filePrefix?: string;
}
export function filePrefix(value: unknown): string {
  if (typeof value !== "string" || !/^file_(?:[A-Za-z0-9_-]{1,48}_)?$/.test(value)) throw new TypeError("Invalid file prefix");
  return value;
}
export function fileId(value: unknown): string {
  if (typeof value !== "string" || !/^file_(?:[A-Za-z0-9_-]{1,48}_)?[a-f0-9-]{36}$/.test(value)) throw new TypeError("Invalid file ID");
  return value;
}
export function chunkHash(value: unknown): string { fromBase64Url(value, 32); return value as string; }
export function normalizeManifest(value: unknown): FileManifest {
  const m = exactObject(value, ["version", "fileId", "name", "mime", "size", "chunkSize", "keyId", "chunks"]);
  if (m.version !== 1 || typeof m.name !== "string" || !m.name.length || m.name.length > 255 ||
      typeof m.mime !== "string" || !/^[\x20-\x7e]{1,128}$/.test(m.mime) ||
      !Number.isSafeInteger(m.size) || (m.size as number) < 0 || (m.size as number) > MAX_FILE_BYTES ||
      !Number.isSafeInteger(m.chunkSize) || (m.chunkSize as number) < 65536 || (m.chunkSize as number) > CHUNK_BYTES ||
      !Array.isArray(m.chunks) || m.chunks.length !== Math.ceil((m.size as number) / (m.chunkSize as number)) || m.chunks.length > 1024) {
    throw new TypeError("Invalid file manifest or storage limits");
  }
  return Object.freeze({ version: 1, fileId: fileId(m.fileId), name: m.name, mime: m.mime, size: m.size as number,
    chunkSize: m.chunkSize as number, keyId: normalizeKeyId(m.keyId), chunks: Object.freeze(m.chunks.map(chunkHash)) });
}
/** A single atomic scalar manifest avoids mixing descriptors across independent field updates. */
export function manifestFields(value: FileManifest): Fields {
  return { storageType: "FILE_ADDED", manifest: toBase64Url(encodeBinary(normalizeManifest(value))) };
}
export function manifestFromFields(fields: Fields): FileManifest {
  if (fields.storageType !== "FILE_ADDED" || typeof fields.manifest !== "string") throw new TypeError("Item is not a file manifest");
  return normalizeManifest(decodeBinary(fromBase64Url(fields.manifest)));
}
export async function manifestDigest(m: FileManifest): Promise<string> { return hashChunk(encodeBinary(normalizeManifest(m))); }
export function chunkPlaintextSize(m: FileManifest, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= m.chunks.length) throw new RangeError("Invalid chunk index");
  return Math.min(m.chunkSize, m.size - index * m.chunkSize);
}
export async function hashChunk(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", bytes));
}
function aad(projectId: string, rootActorId: string, genesisKeyId: string, m: FileManifest, index: number): Uint8Array<ArrayBuffer> {
  return encodeBinary(["sovereign-local-core/blob-chunk/v1", projectId, rootActorId, genesisKeyId,
    m.fileId, m.keyId, m.size, m.chunkSize, index, chunkPlaintextSize(m, index)]);
}
export async function encryptChunk(plaintext: Uint8Array<ArrayBuffer>, key: CryptoKey, projectId: string,
  rootActorId: string, genesisKeyId: string, m: FileManifest, index: number): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length !== chunkPlaintextSize(m, index)) throw new TypeError("Chunk length mismatch");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128,
    additionalData: aad(projectId, rootActorId, genesisKeyId, m, index) }, key, plaintext));
  const result = new Uint8Array(plaintext.length + CHUNK_OVERHEAD), header = new DataView(result.buffer);
  header.setUint32(0, MAGIC, true); header.setUint32(4, 1, true); header.setUint32(8, plaintext.length, true);
  result.set(iv, 12); result.set(ciphertext, 24); return result;
}
export async function decryptChunk(bytes: Uint8Array<ArrayBuffer>, key: CryptoKey, projectId: string,
  rootActorId: string, genesisKeyId: string, m: FileManifest, index: number): Promise<Uint8Array<ArrayBuffer>> {
  if (bytes.length !== chunkPlaintextSize(m, index) + CHUNK_OVERHEAD || await hashChunk(bytes) !== m.chunks[index]) throw new Error("Chunk hash/length mismatch");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== 1 || header.getUint32(8, true) !== bytes.length - CHUNK_OVERHEAD) throw new Error("Invalid chunk header");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(12, 24), tagLength: 128,
    additionalData: aad(projectId, rootActorId, genesisKeyId, m, index) }, key, bytes.subarray(24)));
}
export function normalizeChunkRequest(value: unknown): ChunkRequest {
  const r = exactObject(value, ["version", "requestId", "projectId", "rootActorId", "genesisKeyId", "actorId", "certificate", "fileId", "index", "hash", "signature"]);
  if (r.version !== 1 || typeof r.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(r.requestId) || !Number.isSafeInteger(r.index) || (r.index as number) < 0 || (r.index as number) >= 1024) throw new TypeError("Invalid chunk request");
  fromBase64Url(r.signature, 64);
  return Object.freeze({ version: 1, requestId: r.requestId, projectId: normalizeProjectId(r.projectId),
    rootActorId: normalizeActorId(r.rootActorId), genesisKeyId: normalizeKeyId(r.genesisKeyId), actorId: normalizeActorId(r.actorId),
    certificate: normalizeCertificate(r.certificate), fileId: fileId(r.fileId), index: r.index as number,
    hash: chunkHash(r.hash), signature: r.signature as string });
}
export function requestBytes(request: ChunkRequest): Uint8Array<ArrayBuffer> {
  const { signature: _, ...unsigned } = normalizeChunkRequest(request);
  return encodeWire(["sovereign-local-core/chunk-request/v1", unsigned]);
}
