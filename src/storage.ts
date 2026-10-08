import type { LocalCore } from "./engine.js";
import type { IEvent, Snapshot } from "./types.js";
import { CHUNK_BYTES, CHUNK_OVERHEAD, MAX_FILE_BYTES, chunkPlaintextSize, decryptChunk, encryptChunk, fileId, hashChunk,
  manifestFields, manifestFromFields, manifestDigest, normalizeManifest, normalizeChunkRequest,
  type ChunkRequest, type FileManifest, type IBlobStore, type UploadOptions } from "./storage-format.js";
export * from "./storage-format.js";

/** Slice first so even a source returning huge stream chunks cannot exceed our chunk bound. */
export async function* fileChunks(blob: Blob, chunkSize: number): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 65536 || chunkSize > CHUNK_BYTES) throw new RangeError("Invalid chunk size");
  for (let at = 0; at < blob.size; at += chunkSize) {
    const length = Math.min(chunkSize, blob.size - at), bytes = new Uint8Array(length);
    const reader = blob.slice(at, at + length).stream().getReader(); let offset = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        if (value.length > length - offset) throw new Error("File stream exceeded slice length");
        bytes.set(value, offset); offset += value.length;
      }
      if (offset !== length) throw new Error("Incomplete file stream");
      yield bytes;
    } finally { bytes.fill(0); try { await reader.cancel(); } finally { reader.releaseLock(); } }
  }
}
/** Worker-side service. Keys, plaintext validation and all storage writes remain here. */
export class StorageEngine {
  constructor(private readonly core: LocalCore, private readonly blobs: IBlobStore) {}
  async upload(blob: Blob, options: UploadOptions = {}): Promise<{ manifest: FileManifest; event: IEvent; snapshot: Snapshot }> {
    if (!(blob instanceof Blob) || blob.size > MAX_FILE_BYTES) throw new TypeError("Blob/File up to 1 GiB required");
    const chunkSize = options.chunkSize ?? CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 65536 || chunkSize > CHUNK_BYTES || Math.ceil(blob.size / chunkSize) > 1024) throw new RangeError("Invalid chunk size or count");
    const access = await this.core.storageKey();
    const chunks = Array.from({ length: Math.ceil(blob.size / chunkSize) }, () => "A".repeat(43));
    const draft = normalizeManifest({ version: 1, fileId: `file_${crypto.randomUUID()}`, name: options.name ?? ("name" in blob ? (blob as File).name : "unnamed"),
      mime: options.mime ?? (blob.type || "application/octet-stream"), size: blob.size, chunkSize: options.chunkSize ?? CHUNK_BYTES, keyId: access.keyId, chunks });
    const descriptor = (await this.core.getProjectInfo()).descriptor;
    let index = 0, processedBytes = 0;
    const progress = () => { try { options.onProgress?.({ direction: "upload", fileId: draft.fileId, completedChunks: index,
      totalChunks: chunks.length, processedBytes, totalBytes: draft.size, cachedChunks: index }); } catch { /* Isolate observers. */ } };
    options.signal?.throwIfAborted(); progress();
    for await (const plaintext of fileChunks(blob, draft.chunkSize)) {
      options.signal?.throwIfAborted();
      const bytes = await encryptChunk(plaintext, access.key, this.core.projectId, descriptor.rootActorId, descriptor.genesisKeyId, draft, index);
      const hash = await hashChunk(bytes); await this.blobs.put(hash, bytes); chunks[index++] = hash;
      processedBytes += plaintext.length; progress();
    }
    options.signal?.throwIfAborted();
    const manifest = normalizeManifest({ ...draft, chunks });
    // Only after every chunk is closed/flushed; failure leaves unreferenced encrypted chunks, no manifest event.
    const committed = await this.core.dispatch({ type: "FILE_ADDED", itemId: manifest.fileId, fields: manifestFields(manifest) });
    return { manifest, ...committed };
  }
  async info(id: string): Promise<FileManifest> {
    fileId(id);
    const item = (await this.core.snapshot()).items.find(item => item.id === id);
    if (!item) throw new Error("File is absent/deleted in the authorized view");
    const manifest = manifestFromFields(item.fields);
    if (manifest.fileId !== id) throw new Error("Manifest file ID mismatch");
    return manifest;
  }
  private async requireManifest(id: string, expected?: string): Promise<FileManifest> {
    const m = await this.info(id);
    if (expected !== undefined && await manifestDigest(m) !== expected) throw new Error("File manifest changed during read");
    return m;
  }
  async readChunk(id: string, index: number, expected?: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const manifest = await this.requireManifest(id, expected); chunkPlaintextSize(manifest, index);
    const access = await this.core.storageKey(manifest.keyId), bytes = await this.blobs.get(manifest.chunks[index]!);
    if (!bytes) return null;
    return this.decrypt(bytes, manifest, index, access.key);
  }
  async acceptChunk(id: string, index: number, bytes: Uint8Array<ArrayBuffer>, expected?: string): Promise<Uint8Array<ArrayBuffer>> {
    const manifest = await this.requireManifest(id, expected), access = await this.core.storageKey(manifest.keyId);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Binary chunk required");
    const plaintext = await this.decrypt(bytes, manifest, index, access.key);
    try { await this.blobs.put(manifest.chunks[index]!, bytes); return plaintext; }
    catch (error) { plaintext.fill(0); throw error; }
  }
  private async decrypt(bytes: Uint8Array<ArrayBuffer>, m: FileManifest, index: number, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
    const d = (await this.core.getProjectInfo()).descriptor;
    return decryptChunk(bytes, key, this.core.projectId, d.rootActorId, d.genesisKeyId, m, index);
  }
  async createRequest(id: string, index: number, expected?: string): Promise<ChunkRequest> {
    const m = await this.requireManifest(id, expected); chunkPlaintextSize(m, index);
    return this.core.createChunkRequest(id, index, m.chunks[index]!);
  }
  async serveChunk(value: ChunkRequest): Promise<Uint8Array<ArrayBuffer> | null> {
    const request = normalizeChunkRequest(value);
    await this.core.authorizeChunkRequest(request);
    const manifest = await this.info(request.fileId); chunkPlaintextSize(manifest, request.index);
    if (manifest.chunks[request.index] !== request.hash) throw new Error("Request is not bound to the file manifest");
    const bytes = await this.blobs.get(request.hash);
    if (bytes && (bytes.length !== chunkPlaintextSize(manifest, request.index) + CHUNK_OVERHEAD || await hashChunk(bytes) !== request.hash)) throw new Error("Stored ciphertext is corrupt");
    return bytes;
  }
}
