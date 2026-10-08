import { MAX_BLOB_BYTES, manifestDigest, normalizeManifest, chunkPlaintextSize, type FileManifest, type ChunkRequest, type IChunkTransport, type UploadOptions, type StorageReadOptions } from "./storage-format.js";
import type { IEvent, Snapshot } from "./types.js";
export interface IStorageCore {
  uploadFile(blob: Blob, options?: UploadOptions): Promise<{ manifest: FileManifest; event: IEvent; snapshot: Snapshot }>;
  fileInfo(fileId: string): Promise<FileManifest>;
  readFileChunk(fileId: string, index: number, manifestDigest?: string): Promise<Uint8Array<ArrayBuffer> | null>;
  acceptFileChunk(fileId: string, index: number, bytes: Uint8Array<ArrayBuffer>, manifestDigest?: string): Promise<Uint8Array<ArrayBuffer>>;
  createChunkRequest(fileId: string, index: number, manifestDigest?: string): Promise<ChunkRequest>;
}
/** Main-thread orchestration; never sees project keys or writes ciphertext storage. */
export class P2PStorage {
  private readonly peers = new Set<IChunkTransport>();
  constructor(private readonly core: IStorageCore) {}
  addPeer(peer: IChunkTransport): () => void { this.peers.add(peer); return () => { this.peers.delete(peer); }; }
  upload(blob: Blob, options: UploadOptions = {}) { return this.core.uploadFile(blob, options); }
  info(id: string) { return this.core.fileInfo(id); }
  async readStream(id: string, options: StorageReadOptions = {}): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    return this.streamManifest(normalizeManifest(await this.core.fileInfo(id)), options);
  }
  private async streamManifest(manifest: FileManifest, options: StorageReadOptions): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const id = manifest.fileId, digest = await manifestDigest(manifest), controller = new AbortController(); let index = 0, processedBytes = 0, cachedChunks = 0;
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    return new ReadableStream({
      pull: async output => {
        try {
          controller.signal.throwIfAborted();
          if (index === manifest.chunks.length) { cleanup(); output.close(); return; }
          let plaintext = await this.core.readFileChunk(id, index, digest);
          if (plaintext) cachedChunks++;
          if (!plaintext) {
            const request = await this.core.createChunkRequest(id, index, digest); let failure: unknown = new Error("No connected peer has this chunk");
            for (const peer of this.peers) {
              controller.signal.throwIfAborted();
              try { const bytes = await peer.requestChunk(request, controller.signal); plaintext = await this.core.acceptFileChunk(id, index, bytes, digest); break; }
              catch (error) { failure = error; }
            }
            if (!plaintext) throw failure;
          }
          if (plaintext.length !== chunkPlaintextSize(manifest, index)) { plaintext.fill(0); throw new Error("Decrypted chunk length mismatch"); }
          if (controller.signal.aborted) { plaintext.fill(0); controller.signal.throwIfAborted(); }
          index++; processedBytes += plaintext.length;
          try { options.onProgress?.({ direction: "download", fileId: id, completedChunks: index, totalChunks: manifest.chunks.length,
            processedBytes, totalBytes: manifest.size, cachedChunks }); } catch { /* Isolate observers. */ }
          output.enqueue(plaintext);
        } catch (error) { cleanup(); output.error(error); }
      },
      cancel: reason => { controller.abort(reason); cleanup(); },
    }, { highWaterMark: 0 }); // No prefetch: at most one requested/decrypted chunk per consumer pull.
  }
  async readBlob(id: string, options: StorageReadOptions = {}): Promise<Blob> {
    const manifest = normalizeManifest(await this.core.fileInfo(id));
    if (manifest.size > MAX_BLOB_BYTES) throw new RangeError("readBlob is limited to 16 MiB; use readStream/pipeTo for large files");
    return new Blob([await new Response(await this.streamManifest(manifest, options)).arrayBuffer()], { type: manifest.mime });
  }
  async pipeTo(id: string, destination: WritableStream<Uint8Array<ArrayBuffer>>, options: StorageReadOptions = {}): Promise<void> {
    await (await this.readStream(id, options)).pipeTo(destination, options);
  }
}
