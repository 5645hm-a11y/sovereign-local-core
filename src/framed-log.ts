import { encodeWire, decodeWire } from "./binary-events.js";
/** Structural interface shared by native OPFS and fault-injection test devices. */
export interface SyncFile {
  getSize(): number;
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const HEADER_BYTES = 16;
const BINARY_MAGIC = 0x32434c53; // SLC2
const MAGIC = 0x31434c53; // SLC1, little-endian
export const MAX_RECORD_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

export class LogCorruptionError extends Error {
  constructor(readonly offset: number, reason: string) {
    super(`Log corruption at byte ${offset}: ${reason}. File preserved.`);
    this.name = "LogCorruptionError";
  }
}

export class UncertainCommitError extends Error {
  constructor(cause: unknown) {
    super("Write or flush failed; commit status is unknown. Close and reopen before retrying.", { cause });
    this.name = "UncertainCommitError";
  }
}

export function encodeFrame(record: unknown): Uint8Array {
  const binary = !!record && typeof record === "object" && ("kind" in record) && ((record as { kind?: string }).kind === "event" || ((record as { kind?: string; version?: number }).kind === "identity" && (record as { version?: number }).version === 3));
  const json = binary ? "" : JSON.stringify(record);
  if (json === undefined) throw new TypeError("Record is not JSON serializable");
  const payload = binary ? encodeWire(record) : encoder.encode(json);
  if (!payload.length || payload.length > MAX_RECORD_BYTES) throw new RangeError("Record exceeds 1 MiB");
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  const header = new DataView(frame.buffer);
  header.setUint32(0, binary ? BINARY_MAGIC : MAGIC, true);
  header.setUint32(4, payload.length, true);
  header.setUint32(8, (~payload.length) >>> 0, true);
  header.setUint32(12, crc32(payload), true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

function readExactly(file: SyncFile, bytes: Uint8Array, offset: number): void {
  let read = 0;
  while (read < bytes.length) {
    const count = file.read(bytes.subarray(read), { at: offset + read });
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - read) {
      throw new Error(`Unable to read file at byte ${offset + read}`);
    }
    read += count;
  }
}

interface ScanResult { validBytes: number; tailBytes: number }

/** Bounded reads. Validation precedes any truncation, including semantic validation. */
export function inspectFrames(file: SyncFile, visit: (record: unknown, offset: number) => void, start = 0): ScanResult {
  const size = file.getSize();
  if (!Number.isSafeInteger(start) || start < 0 || start > size) throw new LogCorruptionError(start, "invalid recovery offset");
  let offset = start;
  while (offset < size) {
    if (size - offset < HEADER_BYTES) break;
    const headerBytes = new Uint8Array(HEADER_BYTES);
    readExactly(file, headerBytes, offset);
    const header = new DataView(headerBytes.buffer);
    const length = header.getUint32(4, true);
    if (![MAGIC, BINARY_MAGIC].includes(header.getUint32(0, true)) ||
        header.getUint32(8, true) !== ((~length) >>> 0) || !length || length > MAX_RECORD_BYTES) {
      throw new LogCorruptionError(offset, "invalid frame header");
    }
    if (size - offset - HEADER_BYTES < length) break;
    const payload = new Uint8Array(length);
    readExactly(file, payload, offset + HEADER_BYTES);
    if (crc32(payload) !== header.getUint32(12, true)) {
      throw new LogCorruptionError(offset, "checksum mismatch");
    }
    let record: unknown;
    try { record = header.getUint32(0, true) === BINARY_MAGIC ? decodeWire(payload) : JSON.parse(decoder.decode(payload)); }
    catch { throw new LogCorruptionError(offset, "invalid record encoding"); }
    visit(record, offset);
    offset += HEADER_BYTES + length;
  }
  return { validBytes: offset, tailBytes: size - offset };
}

/** Only the uncommitted, incomplete tail may be removed. Existing complete frames stay immutable. */
export class FramedLog {
  private end = 0;
  private state: "new" | "ready" | "faulted" | "closed" = "new";

  constructor(private readonly file: SyncFile) {}

  recover(visit: (record: unknown, offset: number) => void, start = 0): number {
    if (this.state !== "new") throw new Error("Log already opened");
    try {
      const result = inspectFrames(this.file, visit, start);
      if (result.tailBytes) {
        this.file.truncate(result.validBytes);
        this.file.flush();
      }
      this.end = result.validBytes;
      this.state = "ready";
      return result.tailBytes;
    } catch (error) {
      this.state = "faulted";
      throw error;
    }
  }

  read(visit: (record: unknown, offset: number) => void): void {
    this.assertReady();
    try {
      const result = inspectFrames(this.file, visit);
      if (result.tailBytes || result.validBytes !== this.end) {
        throw new LogCorruptionError(result.validBytes, "unexpected file size while open");
      }
    } catch (error) {
      this.state = "faulted";
      throw error;
    }
  }

  append(record: unknown): void {
    this.assertReady();
    const bytes = encodeFrame(record); // Size/serialization failure does not poison the writer.
    try {
      let written = 0;
      while (written < bytes.length) {
        const count = this.file.write(bytes.subarray(written), { at: this.end + written });
        if (!Number.isInteger(count) || count <= 0 || count > bytes.length - written) {
          throw new Error("Short write made no progress");
        }
        written += count;
      }
      this.file.flush();
      this.end += bytes.length;
    } catch (error) {
      this.state = "faulted";
      throw new UncertainCommitError(error);
    }
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.file.close();
  }

  get endOffset(): number { return this.end; }

  private assertReady(): void {
    if (this.state !== "ready") throw new Error(`Log is ${this.state}; reopen the store`);
  }
}
