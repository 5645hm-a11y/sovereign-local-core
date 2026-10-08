import { CHUNK_BYTES, CHUNK_OVERHEAD, chunkHash, hashChunk, type IBlobStore } from "./storage-format.js";

/** Separate content-addressed ciphertext files. createWritable uses a temporary file until close. */
export class OPFSBlobStore implements IBlobStore {
  private constructor(private readonly directory: FileSystemDirectoryHandle) {}
  static async open(databaseName: string, projectId: string): Promise<OPFSBlobStore> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(databaseName) || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new TypeError("Invalid storage namespace");
    const root = await navigator.storage.getDirectory();
    const ns = await root.getDirectoryHandle("sovereign-local-core", { create: true });
    const db = await ns.getDirectoryHandle(databaseName, { create: true });
    const project = await db.getDirectoryHandle(projectId, { create: true });
    return new OPFSBlobStore(await project.getDirectoryHandle("blobs", { create: true }));
  }
  async get(hash: string): Promise<Uint8Array<ArrayBuffer> | null> {
    chunkHash(hash);
    let file: File;
    try { file = await (await this.directory.getFileHandle(hash)).getFile(); }
    catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
    if (file.size < CHUNK_OVERHEAD || file.size > CHUNK_BYTES + CHUNK_OVERHEAD) throw new Error("Invalid stored chunk size");
    return new Uint8Array(await file.arrayBuffer()); // One bounded encrypted chunk, never a whole user file.
  }
  async put(hash: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    chunkHash(hash);
    if (bytes.length < CHUNK_OVERHEAD || bytes.length > CHUNK_BYTES + CHUNK_OVERHEAD || await hashChunk(bytes) !== hash) throw new Error("Invalid ciphertext chunk");
    const handle = await this.directory.getFileHandle(hash, { create: true });
    const writer = await handle.createWritable();
    try { await writer.write(bytes); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch { /* Preserve original failure. */ } throw error; }
    // In the Dedicated Worker, explicitly flush after the atomic writable close.
    const sync = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ flush(): void; close(): void }> }).createSyncAccessHandle();
    try { sync.flush(); } finally { sync.close(); }
  }
}
