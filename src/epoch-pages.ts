import { encodeBinary } from "./binary-codec.js";
import { encodeWire } from "./binary-events.js";
import { exactObject } from "./certificates.js";
import { fromBase64Url, normalizeActorId, normalizeProjectId, toBase64Url } from "./crypto-codec.js";
import { normalizeEnvelope, normalizeKeyId } from "./project-crypto.js";
import type { EpochCommitment, EpochPage, HistoryWitness, KeyEnvelope } from "./types.js";

export const EPOCH_PAGE_ENTRIES = 128;
export const MAX_EPOCH_ENTRIES = 65536;
export const MAX_EPOCH_PAGE_BYTES = 96 * 1024;
const hash = async (value: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", value));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const node = (a: Uint8Array, b: Uint8Array) => hash(encodeBinary(["slc/key-epoch-node/v1", a, b]));
const leaf = (projectId: string, keyId: string, epochId: string, kind: string, index: number, entries: readonly unknown[]) =>
  hash(encodeWire(["slc/key-epoch-leaf/v1", projectId, keyId, epochId, kind, index, entries]));
export function normalizeEpochId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("epoch_")) throw new TypeError("Invalid epoch ID");
  fromBase64Url(value.slice(6), 32); return value;
}
export const epochPageCount = (count: number): number => Math.ceil(count / EPOCH_PAGE_ENTRIES);
export function normalizeEpochCommitment(value: unknown): EpochCommitment {
  const c = exactObject(value, ["id", "version", "pageSize", "keyCount", "historyCount", "keyRoot", "historyRoot"]);
  normalizeEpochId(c.id);
  if (c.version !== 1 || c.pageSize !== EPOCH_PAGE_ENTRIES || !Number.isSafeInteger(c.keyCount) ||
      (c.keyCount as number) < 1 || (c.keyCount as number) > MAX_EPOCH_ENTRIES || !Number.isSafeInteger(c.historyCount) ||
      (c.historyCount as number) < 0 || (c.historyCount as number) > MAX_EPOCH_ENTRIES) throw new TypeError("Invalid epoch commitment bounds");
  fromBase64Url(c.keyRoot, 32); fromBase64Url(c.historyRoot, 32);
  return Object.freeze({ id: c.id as string, version: 1, pageSize: EPOCH_PAGE_ENTRIES, keyCount: c.keyCount as number,
    historyCount: c.historyCount as number, keyRoot: c.keyRoot as string, historyRoot: c.historyRoot as string });
}
export function normalizeHistoryWitness(value: unknown): HistoryWitness {
  const w = exactObject(value, ["id", "digest"]);
  if (typeof w.id !== "string" || w.id.length > 128) throw new TypeError("Invalid history witness ID");
  const at = w.id.lastIndexOf(":"), sequence = Number(w.id.slice(at + 1));
  normalizeActorId(w.id.slice(0, at));
  if (!Number.isSafeInteger(sequence) || sequence < 1 || w.id !== `${w.id.slice(0, at)}:${sequence}`) throw new TypeError("Invalid witness sequence");
  fromBase64Url(w.digest, 32);
  return Object.freeze({ id: w.id, digest: w.digest as string });
}
export function sameEpochCommitment(a: EpochCommitment, b: EpochCommitment): boolean {
  return a.id === b.id && a.version === b.version && a.pageSize === b.pageSize && a.keyCount === b.keyCount &&
    a.historyCount === b.historyCount && a.keyRoot === b.keyRoot && a.historyRoot === b.historyRoot;
}
export function normalizeEpochPage(value: unknown): EpochPage {
  const p = exactObject(value, ["epochId", "keyId", "targetActorId", "commitment", "kind", "index", "entries", "proof"]);
  const epochId = normalizeEpochId(p.epochId);
  const commitment = normalizeEpochCommitment(p.commitment);
  if (commitment.id !== epochId) throw new TypeError("Epoch page ID mismatch");
  const keyId = normalizeKeyId(p.keyId), targetActorId = normalizeActorId(p.targetActorId);
  if (p.kind !== "keys" && p.kind !== "history") throw new TypeError("Invalid epoch page kind");
  const total = p.kind === "keys" ? commitment.keyCount : commitment.historyCount, count = epochPageCount(total);
  if (!Number.isSafeInteger(p.index) || (p.index as number) < 0 || (p.index as number) >= count || !Array.isArray(p.entries) ||
      p.entries.length !== Math.min(EPOCH_PAGE_ENTRIES, total - (p.index as number) * EPOCH_PAGE_ENTRIES) ||
      !Array.isArray(p.proof) || p.proof.length !== Math.ceil(Math.log2(count))) throw new TypeError("Invalid epoch page shape");
  const proof = Object.freeze(p.proof.map(v => { fromBase64Url(v, 32); return v as string; }));
  const header = { epochId, keyId, targetActorId, commitment, index: p.index as number, proof };
  const page: EpochPage = p.kind === "keys" ? { ...header, kind: "keys", entries: Object.freeze(p.entries.map(normalizeEnvelope)) } :
    { ...header, kind: "history", entries: Object.freeze(p.entries.map(normalizeHistoryWitness)) };
  const names = page.entries.map(e => "recipient" in e ? e.recipient : e.id);
  if (names.some((name, i) => i > 0 && name <= names[i - 1]!)) throw new TypeError("Epoch entries must be unique and sorted");
  if (page.kind === "keys" && page.entries.some(e => e.keyId !== keyId || e.recipient === targetActorId)) throw new TypeError("Invalid epoch key recipient");
  if (encodeWire(page).length > MAX_EPOCH_PAGE_BYTES) throw new RangeError("Epoch page exceeds byte budget");
  return Object.freeze(page);
}
/** Verify placement and exact proof depth against the signed page commitment. */
export async function verifyEpochPage(projectId: string, value: EpochPage): Promise<void> {
  const p = normalizeEpochPage(value); normalizeProjectId(projectId);
  let h = await leaf(projectId, p.keyId, p.epochId, p.kind, p.index, p.entries), at = p.index;
  let width = epochPageCount(p.kind === "keys" ? p.commitment.keyCount : p.commitment.historyCount);
  for (const sibling of p.proof) {
    const s = fromBase64Url(sibling, 32);
    if ((at ^ 1) >= width && !equal(s, h)) throw new TypeError("Invalid duplicate-last Merkle sibling");
    h = at % 2 === 0 ? await node(h, s) : await node(s, h);
    at = Math.floor(at / 2); width = Math.ceil(width / 2);
  }
  if (toBase64Url(h) !== (p.kind === "keys" ? p.commitment.keyRoot : p.commitment.historyRoot)) throw new TypeError("Epoch page proof mismatch");
}
export async function emptyEpochRoot(projectId: string, keyId: string, kind: string): Promise<string> {
  return toBase64Url(await hash(encodeBinary(["slc/key-epoch-empty/v1", projectId, keyId, kind])));
}
async function tree(projectId: string, keyId: string, epochId: string, kind: string, entries: readonly unknown[]) {
  const pages = Array.from({ length: epochPageCount(entries.length) }, (_, index) => entries.slice(index * EPOCH_PAGE_ENTRIES, (index + 1) * EPOCH_PAGE_ENTRIES));
  if (!pages.length) return { root: await emptyEpochRoot(projectId, keyId, kind), pages, proofs: [] as string[][] };
  const levels = [await Promise.all(pages.map((page, i) => leaf(projectId, keyId, epochId, kind, i, page)))];
  while (levels.at(-1)!.length > 1) {
    const last = levels.at(-1)!;
    levels.push(await Promise.all(Array.from({ length: Math.ceil(last.length / 2) }, (_, i) => node(last[i * 2]!, last[i * 2 + 1] ?? last[i * 2]!))));
  }
  return { root: toBase64Url(levels.at(-1)![0]!), pages,
    proofs: pages.map((_, index) => levels.slice(0, -1).map((level, depth) => { const at = Math.floor(index / 2 ** depth); return toBase64Url(level[at ^ 1] ?? level[at]!); })) };
}
/** Preparation allocates a bounded complete plan; wire/storage records remain independently bounded. */
export async function buildEpochPages(projectId: string, keyId: string, targetActorId: string, epochId: string,
  envelopes: readonly KeyEnvelope[], history: readonly HistoryWitness[]): Promise<{ commitment: EpochCommitment; pages: readonly EpochPage[] }> {
  normalizeProjectId(projectId); normalizeKeyId(keyId); normalizeActorId(targetActorId); normalizeEpochId(epochId);
  if (!envelopes.length || envelopes.length > MAX_EPOCH_ENTRIES || history.length > MAX_EPOCH_ENTRIES) throw new RangeError("Epoch plan exceeds bounds");
  const keys = envelopes.map(normalizeEnvelope).sort((a, b) => a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0);
  const witnesses = history.map(normalizeHistoryWitness).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (keys.some((e, i) => i > 0 && e.recipient === keys[i - 1]!.recipient) || witnesses.some((e, i) => i > 0 && e.id === witnesses[i - 1]!.id)) throw new TypeError("Duplicate epoch entry");
  const [k, h] = await Promise.all([tree(projectId, keyId, epochId, "keys", keys), tree(projectId, keyId, epochId, "history", witnesses)]);
  const commitment = normalizeEpochCommitment({ id: epochId, version: 1, pageSize: EPOCH_PAGE_ENTRIES, keyCount: keys.length, historyCount: witnesses.length, keyRoot: k.root, historyRoot: h.root });
  const pages = [...k.pages.map((entries, index) => normalizeEpochPage({ epochId, keyId, targetActorId, commitment, kind: "keys", index, entries, proof: k.proofs[index] })),
    ...h.pages.map((entries, index) => normalizeEpochPage({ epochId, keyId, targetActorId, commitment, kind: "history", index, entries, proof: h.proofs[index] }))];
  return { commitment, pages: Object.freeze(pages) };
}
