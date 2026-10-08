import { encodeWire, decodeWire } from "./binary-events.js";
import { encodeBinary, decodeBinary } from "./binary-codec.js";
import { LogCorruptionError, type SyncFile } from "./framed-log.js";
import type { ProjectContext } from "./project.js";
import type { Certificate, IEvent } from "./types.js";

export interface CoreCheckpoint {
  version: 1; generation: number; eventCount: number; offset: number; lamport: number; sequence: number;
  index: { id: string; digest: string }[];
  controls: IEvent[]; certificates: Certificate[];
  native: Uint8Array<ArrayBuffer>;
  prefixHash: Uint8Array<ArrayBuffer>;
  readonly proof?: Uint8Array<ArrayBuffer>;
}
export type CheckpointData = Omit<CoreCheckpoint, "version" | "generation" | "offset" | "prefixHash" | "proof">;
const CHUNK = 1024 * 1024, LIMIT = 128 * 1024 * 1024;
function read(file: SyncFile, at: number, size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size); let n = 0;
  while (n < size) { const count = file.read(bytes.subarray(n), { at: at + n }); if (!Number.isInteger(count) || count < 1 || count > size - n) throw new Error("Checkpoint read failed"); n += count; }
  return bytes;
}
function write(file: SyncFile, bytes: Uint8Array): void {
  file.truncate(0); let at = 0;
  while (at < bytes.length) { const count = file.write(bytes.subarray(at), { at }); if (!Number.isInteger(count) || count < 1 || count > bytes.length - at) throw new Error("Checkpoint write failed"); at += count; }
  file.flush();
}
function checkpointAAD(project: ProjectContext): Uint8Array<ArrayBuffer> { return encodeBinary(["sovereign-local-core/checkpoint/v1", project.descriptor.projectId, project.descriptor.rootActorId, project.descriptor.genesisKeyId, project.identity.actorId]); }
/** Engine authenticates the sealed checkpoint again; arbitrary ILocalStore implementations cannot inject a view. */
export async function authenticateCheckpoint(proof: Uint8Array<ArrayBuffer> | undefined, project: ProjectContext, maxOffset = Number.MAX_SAFE_INTEGER): Promise<CoreCheckpoint> {
  if (!proof || proof.length > LIMIT) throw new TypeError("Authenticated checkpoint proof required");
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
        const envelope = decodeBinary(proof) as { version: number; iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> };
        if (envelope.version !== 1 || !(envelope.iv instanceof Uint8Array) || envelope.iv.length !== 12 ||
            !(envelope.ciphertext instanceof Uint8Array) || envelope.ciphertext.length < 16 || !(envelope.signature instanceof Uint8Array) || envelope.signature.length !== 64) throw new TypeError("Invalid checkpoint");
        const signed = encodeBinary([checkpointAAD(project), envelope.iv, envelope.ciphertext]);
        if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, project.identity.publicKey, envelope.signature, signed)) throw new TypeError("Invalid checkpoint");
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.iv, additionalData: checkpointAAD(project) }, await project.checkpointKey(), envelope.ciphertext));
        const cp = decodeWire(plaintext) as CoreCheckpoint;
        if (cp.version !== 1 || !Number.isSafeInteger(cp.generation) || cp.generation < 1 || !Number.isSafeInteger(cp.offset) || cp.offset < 0 || cp.offset > maxOffset ||
            !Number.isSafeInteger(cp.eventCount) || cp.eventCount < 1 || cp.eventCount > 1000000 || !Array.isArray(cp.index) || cp.index.length !== cp.eventCount ||
            !Array.isArray(cp.controls) || !Array.isArray(cp.certificates) || !(cp.native instanceof Uint8Array) || !(cp.prefixHash instanceof Uint8Array) || cp.prefixHash.length !== 32 ||
            !Number.isSafeInteger(cp.lamport) || cp.lamport < 0 || !Number.isSafeInteger(cp.sequence) || cp.sequence < 0) throw new TypeError("Invalid checkpoint");

    Object.defineProperty(cp, "proof", { value: proof.slice(), enumerable: false });
    return cp;
  } finally { plaintext?.fill(0); }
}
/** Two crash-safe slots. Never modifies the event log or trusts an unsigned cached view. */
export class CheckpointJournal {
  private generation = 0; private latestSlot = 1;
  private readonly chunkHashes: Uint8Array<ArrayBuffer>[] = [];
  constructor(private readonly files: readonly [SyncFile, SyncFile], private readonly project: ProjectContext) {}
  private aad(): Uint8Array<ArrayBuffer> { return checkpointAAD(this.project); }
  private async prefix(file: SyncFile, end: number): Promise<Uint8Array<ArrayBuffer>> {
    // Hash raw prefix bytes to detect old-log tampering, without decoding/re-verifying old events.
    const full = Math.floor(end / CHUNK), hashes = this.chunkHashes.slice(0, full);
    for (let i = hashes.length; i < full; i++) { const bytes = read(file, i * CHUNK, CHUNK); try { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); this.chunkHashes[i] = hash; hashes.push(hash); } finally { bytes.fill(0); } }
    if (end % CHUNK) { const bytes = read(file, full * CHUNK, end % CHUNK); try { hashes.push(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))); } finally { bytes.fill(0); } }
    const concatenated = new Uint8Array(8 + hashes.length * 32), v = new DataView(concatenated.buffer); v.setUint32(0, end >>> 0, true); v.setUint32(4, Math.floor(end / 4294967296), true);
    hashes.forEach((hash, i) => concatenated.set(hash, 8 + i * 32)); return new Uint8Array(await crypto.subtle.digest("SHA-256", concatenated));
  }
  async load(log: SyncFile): Promise<CoreCheckpoint | undefined> {
    const valid: { checkpoint: CoreCheckpoint; slot: number }[] = [];
    for (let slot = 0; slot < 2; slot++) {
      try {
        const file = this.files[slot]!, size = file.getSize(); if (!size || size > LIMIT) continue;
        const cp = await authenticateCheckpoint(read(file, 0, size), this.project, log.getSize());
        valid.push({ checkpoint: cp, slot });
      } catch { /* Missing/torn/invalid cache falls back to the other slot or full verified replay. */ }
    }
    valid.sort((a, b) => b.checkpoint.generation - a.checkpoint.generation);
    const chosen = valid[0]; if (!chosen) return undefined;
    const hash = await this.prefix(log, chosen.checkpoint.offset);
    if (!hash.every((b, i) => b === chosen.checkpoint.prefixHash[i])) throw new LogCorruptionError(0, "checkpoint prefix digest mismatch");
    this.generation = chosen.checkpoint.generation; this.latestSlot = chosen.slot;
    return chosen.checkpoint;
  }
  async save(log: SyncFile, offset: number, data: CheckpointData): Promise<void> {
    const cp: CoreCheckpoint = { ...data, version: 1, generation: this.generation + 1, offset, prefixHash: await this.prefix(log, offset) };
    const plaintext = encodeWire(cp), iv = crypto.getRandomValues(new Uint8Array(12));
    try {
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad() }, await this.project.checkpointKey(), plaintext));
      const signed = encodeBinary([this.aad(), iv, encrypted]);
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.project.identity.privateKey, signed));
      const slot = 1 - this.latestSlot;
      write(this.files[slot]!, encodeBinary({ version: 1, iv, ciphertext: encrypted, signature }));
      this.generation = cp.generation; this.latestSlot = slot;
    } finally { plaintext.fill(0); }
  }
  close(): void { for (const file of this.files) file.close(); this.chunkHashes.length = 0; }
}
