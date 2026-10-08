import test from "node:test";
import assert from "node:assert/strict";
import { LocalCore } from "../../dist/engine.js";
import { LocalEventStore } from "../../dist/local-store.js";
import { ProjectContext } from "../../dist/project.js";
import { StorageEngine, CHUNK_BYTES, manifestDigest, manifestFields, hashChunk } from "../../dist/storage.js";
import { P2PStorage } from "../../dist/storage-client.js";
import { P2PSync } from "../../dist/p2p-sync.js";
import { generateProjectKey, fieldsAAD } from "../../dist/project-crypto.js";
import { signEvent, verifySignature } from "../../dist/identity.js";
import { encodeCommands } from "../../dist/binary-command.js";
import { toBase64Url } from "../../dist/crypto-codec.js";
import { CheckpointJournal } from "../../dist/checkpoints.js";
import { alice, bob, Device } from "../helpers/core-fixtures.mjs";
import { mockChannelPair } from "../helpers/mock-data-channel.mjs";

class MemoryBlobs {
  files = new Map(); failAt = Infinity; writes = 0; maxBytes = 0;
  async get(hash) { return this.files.get(hash)?.slice() ?? null; }
  async put(hash, bytes) { if (++this.writes === this.failAt) throw new Error("blob flush failed"); this.maxBytes = Math.max(this.maxBytes, bytes.length); this.files.set(hash, bytes.slice()); }
}
async function fixture() {
  const projectId = `storage-${crypto.randomUUID()}`, devices = [new Device(), new Device()];
  const root = await ProjectContext.create(alice, projectId);
  const a = await LocalCore.open(await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }), alice, root);
  const { invitation, event } = await a.inviteMember(bob.actorId);
  const member = await ProjectContext.open(invitation, bob, projectId);
  const b = await LocalCore.open(await LocalEventStore.open(devices[1].open(), { actorId: bob.actorId, projectId }), bob, member);
  await b.ingestEvents([event]);
  const stores = [new MemoryBlobs(), new MemoryBlobs()], services = [new StorageEngine(a, stores[0]), new StorageEngine(b, stores[1])];
  const adapter = (core, storage) => ({
    getSyncSummary: () => core.getSyncSummary(), readMissingEvents: s => core.readMissingEvents(s), ingestEvents: e => core.ingestEvents(e), onCommit: fn => core.onCommit(fn),
    uploadFile: (f, o) => storage.upload(f, o), fileInfo: id => storage.info(id), readFileChunk: (...args) => storage.readChunk(...args),
    acceptFileChunk: (...args) => storage.acceptChunk(...args), createChunkRequest: (...args) => storage.createRequest(...args), serveChunk: r => storage.serveChunk(r),
  });
  return { a, b, stores, services, devices, root, member, projectId, adapters: [adapter(a, services[0]), adapter(b, services[1])], close: () => Promise.all([a.close(), b.close()]) };
}
async function until(predicate) { const end = Date.now() + 5000; while (!await predicate()) { if (Date.now() > end) throw new Error("Test condition timed out"); await new Promise(r => setTimeout(r, 5)); } }
async function connected(f, overrides = {}) {
  const roomId = crypto.randomUUID(), opts = { roomId, signalingUrl: "ws://unused.invalid", acknowledgementTimeoutMs: 1000 };
  const channels = mockChannelPair(), transports = f.adapters.map((core, i) => new P2PSync(core, { ...opts, ...(i === 0 ? overrides : {}) }));
  transports.forEach((sync, i) => sync.connectDataChannel(channels[i]));
  await until(() => transports.every(sync => sync.state === "online"));
  return { channels, transports, stop: () => transports.forEach(sync => sync.stop()) };
}

test("chunk progress counts durable preparation, received chunks and verified cache hits", async () => {
  const f = await fixture(), link = await connected(f);
  try {
    const uploads = [], bytes = new Uint8Array(65536 + 13).fill(99);
    const { manifest } = await f.services[0].upload(new Blob([bytes]), { chunkSize: 65536, onProgress: p => {
      assert.equal(f.stores[0].files.size, p.completedChunks); uploads.push(p);
    } });
    assert.deepEqual(uploads.map(p => p.completedChunks), [0, 1, 2]); assert.equal(uploads.at(-1).processedBytes, bytes.length);
    await until(async () => (await f.b.snapshot()).items.some(i => i.id === manifest.fileId));
    const files = new P2PStorage(f.adapters[1]); files.addPeer(link.transports[1]);
    const received = []; await files.readBlob(manifest.fileId, { onProgress: p => received.push(p) });
    assert.deepEqual(received.map(p => p.completedChunks), [1, 2]); assert.equal(received.at(-1).cachedChunks, 0);
    const cached = []; await files.readBlob(manifest.fileId, { onProgress: p => cached.push(p) });
    assert.equal(cached.at(-1).cachedChunks, 2); assert.equal(cached.at(-1).processedBytes, bytes.length);
  } finally { link.stop(); await f.close(); }
});

test("cancelled upload stops between chunks and never publishes a partial manifest", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const before = (await f.a.readEvents()).length;
    await assert.rejects(f.services[0].upload(new Blob([new Uint8Array(3 * 65536)]), {
      chunkSize: 65536, signal: controller.signal, onProgress: p => { if (p.completedChunks === 1) controller.abort(); },
    }), { name: "AbortError" });
    assert.equal(f.stores[0].files.size, 1); assert.equal((await f.a.readEvents()).length, before);
  } finally { await f.close(); }
});

test("streamed upload splits exact chunks and commits only encrypted CRDT metadata after durable storage", async () => {
  const f = await fixture();
  try {
    class StreamOnlyBlob extends Blob { arrayBuffer() { throw new Error("Whole-file read forbidden"); } }
    const bytes = new Uint8Array(2 * 65536 + 11).fill(88), blob = new StreamOnlyBlob([bytes], { type: "image/png" });
    const logBefore = f.devices[0].durable.length;
    const result = await f.services[0].upload(blob, { name: "תמונה.png", chunkSize: 65536 });
    assert.equal(result.manifest.chunks.length, 3); assert.equal(result.manifest.size, bytes.length);
    assert.equal(result.event.type, "FILE_ADDED"); assert.equal(result.event.fields, undefined);
    assert.equal(result.snapshot.items.find(i => i.id === result.manifest.fileId).fields.storageType, "FILE_ADDED");
    assert.ok(f.devices[0].durable.length - logBefore < 8192, "Log append contains metadata, not file bytes");
    assert.deepEqual([...f.stores[0].files.values()].map(b => b.length), [65576, 65576, 51]);
    assert.equal(new Set(result.manifest.chunks).size, 3, "Repeated plaintext gets independent random IVs");
    for (const [hash, data] of f.stores[0].files) { assert.equal(await hashChunk(data), hash); assert.equal(new DataView(data.buffer).getUint32(0, true), 0x31424c53); }
  } finally { await f.close(); }
});

test("mock DataChannel synchronizes only manifest, pulls fragmented ciphertext on demand and reassembles exact Blob", async () => {
  const f = await fixture(), link = await connected(f);
  try {
    const bytes = Uint8Array.from({ length: 2 * CHUNK_BYTES + 37 }, (_, i) => i % 251);
    const published = await f.services[0].upload(new Blob([bytes], { type: "application/octet-stream" }), { name: "virtual.bin" });
    await until(async () => (await f.b.snapshot()).items.some(i => i.id === published.manifest.fileId));
    assert.equal(f.stores[1].files.size, 0); assert.equal(link.transports[0].stats.chunksSent, 0);
    const files = new P2PStorage(f.adapters[1]); files.addPeer(link.transports[1]);
    const received = await files.readBlob(published.manifest.fileId);
    assert.deepEqual(new Uint8Array(await received.arrayBuffer()), bytes); assert.equal(received.type, "application/octet-stream");
    assert.equal(f.stores[1].files.size, 3); assert.equal(link.transports[1].stats.chunksRequested, 3);
    assert.ok(link.channels[0].maximumFrame <= 16384); assert.ok(link.channels[0].maximumBuffered <= 256 * 1024 + 16384);
    await files.readBlob(published.manifest.fileId); assert.equal(link.transports[1].stats.chunksRequested, 3, "Cached reads are offline/local");
  } finally { link.stop(); await f.close(); }
});

test("hash and GCM/AAD failures never persist a remote chunk; alternate peer can complete the pull", async () => {
  const f = await fixture();
  try {
    const { manifest, event } = await f.services[0].upload(new Blob(["private chunk"])); await f.b.ingestEvents([event]);
    const request = await f.services[1].createRequest(manifest.fileId, 0), good = await f.services[0].serveChunk(request), bad = good.slice(); bad[bad.length - 1] ^= 1;
    await assert.rejects(f.services[1].acceptChunk(manifest.fileId, 0, bad), /hash/); assert.equal(f.stores[1].files.size, 0);
    const files = new P2PStorage(f.adapters[1]); files.addPeer({ requestChunk: async () => bad }); files.addPeer({ requestChunk: async r => f.services[0].serveChunk(r) });
    assert.equal(await (await files.readBlob(manifest.fileId)).text(), "private chunk");
    const wrong = await generateProjectKey(), falseManifest = { ...manifest, fileId: `file_${crypto.randomUUID()}`, keyId: wrong.id };
    const altered = await f.b.dispatch({ type: "ITEM_ADDED", itemId: falseManifest.fileId, fields: manifestFields(falseManifest) });
    await f.a.ingestEvents([altered.event]);
    await assert.rejects(f.services[0].acceptChunk(falseManifest.fileId, 0, good), /authorized storage key/);
    const sameKeyWrongBinding = { ...manifest, fileId: `file_${crypto.randomUUID()}` };
    await f.b.dispatch({ type: "ITEM_ADDED", itemId: sameKeyWrongBinding.fileId, fields: manifestFields(sameKeyWrongBinding) });
    await assert.rejects(f.services[1].acceptChunk(sameKeyWrongBinding.fileId, 0, good), { name: "OperationError" });
    wrong.bytes.fill(0);
  } finally { await f.close(); }
});

test("failed chunk flush produces no file event; empty files and exact chunk boundaries recover", async () => {
  const f = await fixture();
  try {
    f.stores[0].failAt = 2; const before = (await f.a.readEvents()).length;
    await assert.rejects(f.services[0].upload(new Blob([new Uint8Array(2 * 65536)]), { chunkSize: 65536 }), /blob flush/);
    assert.equal((await f.a.readEvents()).length, before); assert.equal(f.stores[0].files.size, 1);
    f.stores[0].failAt = Infinity;
    const empty = await f.services[0].upload(new Blob([])); assert.deepEqual(empty.manifest.chunks, []);
    const files = new P2PStorage(f.adapters[0]); assert.equal((await files.readBlob(empty.manifest.fileId)).size, 0);
    const exact = await f.services[0].upload(new Blob([new Uint8Array(65536)]), { chunkSize: 65536 }); assert.equal(exact.manifest.chunks.length, 1);
    await assert.rejects(f.services[0].upload(new Blob(["x"]), { chunkSize: 1 }), /chunk size/);
  } finally { await f.close(); }
});

test("signed pulls reject impersonation, another project, unknown hashes and revoked members", async () => {
  const f = await fixture();
  try {
    const { manifest, event } = await f.services[0].upload(new Blob(["old epoch"])); await f.b.ingestEvents([event]);
    const request = await f.services[1].createRequest(manifest.fileId, 0);
    assert.ok(await f.services[0].serveChunk(request));
    await assert.rejects(f.services[0].serveChunk({ ...request, actorId: alice.actorId }), /actor mismatch/);
    await assert.rejects(f.services[0].serveChunk({ ...request, projectId: "other" }), /project mismatch/);
    await assert.rejects(f.services[0].serveChunk({ ...request, hash: "A".repeat(43) }), /signature/);
    const unknown = await f.b.createChunkRequest(manifest.fileId, 0, "A".repeat(43));
    await assert.rejects(f.services[0].serveChunk(unknown), /manifest/);
    const revocation = await f.a.revokeMember(bob.actorId); await f.b.ingestEvents([revocation.event]);
    await assert.rejects(f.services[0].serveChunk(request), /revoked/);
    await assert.rejects(f.services[1].readChunk(manifest.fileId, 0), /revoked/);
    assert.equal(await new P2PStorage(f.adapters[0]).readBlob(manifest.fileId).then(b => b.text()), "old epoch");
  } finally { await f.close(); }
});

test("a read detects manifest replacement and cancellation cleans the pending chunk request", async () => {
  const f = await fixture(); let finish;
  const link = await connected(f, { storage: { serveChunk: () => new Promise(resolve => { finish = resolve; }) } });
  try {
    const { manifest, event } = await f.services[0].upload(new Blob(["cancel"])); await f.b.ingestEvents([event]);
    const digest = await manifestDigest(manifest);
    await f.b.dispatch({ type: "ITEM_UPDATED", itemId: manifest.fileId, fields: manifestFields({ ...manifest, name: "changed" }) });
    await assert.rejects(f.services[1].readChunk(manifest.fileId, 0, digest), /manifest changed/);
    const request = await f.services[1].createRequest(manifest.fileId, 0), abort = new AbortController();
    const waiting = link.transports[1].requestChunk(request, abort.signal); await until(() => !!finish); abort.abort(new Error("cancelled"));
    await assert.rejects(waiting, /cancelled/); finish(null);
    await until(() => link.transports[0].state === "online");
  } finally { finish?.(null); link.stop(); await f.close(); }
});

test("500 MiB virtual source uses bounded slice streams and large reads require streaming", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    let largestSlice = 0, writes = 0, largestStored = 0;
    class VirtualFile extends Blob {
      get size() { return 500 * CHUNK_BYTES; }
      arrayBuffer() { throw new Error("Whole 500 MiB read forbidden"); }
      stream() { throw new Error("Only bounded slice streams allowed"); }
      slice(start, end) { largestSlice = Math.max(largestSlice, end - start); assert.ok(end - start <= CHUNK_BYTES); return new Blob([new Uint8Array(end - start).fill(start / CHUNK_BYTES % 251)]); }
    }
    const boundedStore = { get: async () => null, put: async (_, bytes) => { writes++; largestStored = Math.max(largestStored, bytes.length); } };
    const files = new StorageEngine(f.a, boundedStore), { manifest } = await files.upload(new VirtualFile(), { name: "500mb.bin" });
    assert.equal(writes, 500); assert.equal(largestSlice, CHUNK_BYTES); assert.equal(largestStored, CHUNK_BYTES + 40); assert.equal(manifest.chunks.length, 500);
    assert.ok(f.devices[0].durable.length < 150000, "Only hashes/metadata scale with file length");
    await assert.rejects(new P2PStorage(f.adapters[0]).readBlob(manifest.fileId), /readStream/);
  } finally { await f.close(); }
});

test("large streamed download applies consumer backpressure without whole-file assembly", async () => {
  const f = await fixture(), link = await connected(f);
  try {
    class VirtualFile extends Blob {
      get size() { return 17 * CHUNK_BYTES + 3; }
      arrayBuffer() { throw new Error("Whole-file read forbidden"); }
      slice(start, end) { return new Blob([new Uint8Array(end - start).fill(7)]); }
    }
    const { manifest, event } = await f.services[0].upload(new VirtualFile()); await f.b.ingestEvents([event]);
    const files = new P2PStorage(f.adapters[1]); files.addPeer(link.transports[1]);
    await assert.rejects(files.readBlob(manifest.fileId), /readStream/);
    const stream = await files.readStream(manifest.fileId); assert.equal(link.transports[1].stats.chunksRequested, 0, "No eager pull before consumer read");
    let bytes = 0, largest = 0, writes = 0;
    await stream.pipeTo(new WritableStream({ async write(chunk) {
      bytes += chunk.length; largest = Math.max(largest, chunk.length); writes++;
      assert.ok(chunk.every(byte => byte === 7)); await new Promise(resolve => setTimeout(resolve, 1));
    } }, { highWaterMark: 1 }));
    assert.equal(bytes, manifest.size); assert.equal(largest, CHUNK_BYTES); assert.equal(writes, 18);
    assert.equal(link.transports[1].stats.chunksRequested, 18);
  } finally { link.stop(); await f.close(); }
});

test("concurrent file consumers serialize chunk pulls rather than failing or buffering whole files", async () => {
  const f = await fixture(), link = await connected(f);
  try {
    const results = await Promise.all([f.services[0].upload(new Blob(["first"])), f.services[0].upload(new Blob(["second"]))]);
    await f.b.ingestEvents(results.map(r => r.event));
    const files = new P2PStorage(f.adapters[1]); files.addPeer(link.transports[1]);
    const received = await Promise.all(results.map(async r => (await files.readBlob(r.manifest.fileId)).text()));
    assert.deepEqual(received, ["first", "second"]); assert.equal(link.transports[1].stats.chunksRequested, 2);
  } finally { link.stop(); await f.close(); }
});

test("readBlob pins the size-checked manifest once so replacement cannot bypass the memory cap", async () => {
  const f = await fixture();
  try {
    const { manifest } = await f.services[0].upload(new Blob(["bounded"])); let reads = 0;
    const facade = new P2PStorage({ ...f.adapters[0], fileInfo: async () => {
      reads++;
      if (reads > 1) throw new Error("Manifest was re-read after size check");
      return manifest;
    } });
    assert.equal(await (await facade.readBlob(manifest.fileId)).text(), "bounded"); assert.equal(reads, 1);
  } finally { await f.close(); }
});

test("FILE_ADDED type is signed and malformed encrypted metadata rejects the whole incoming batch", async () => {
  const f = await fixture();
  try {
    const good = await f.services[1].upload(new Blob(["authorized"]));
    assert.equal(await verifySignature({ ...good.event, type: "ITEM_ADDED" }), false);
    const state = await f.root.evaluateBinary([]), key = state.keys.get(state.currentKeyId);
    const id = `file_${crypto.randomUUID()}`, metadata = { schemaVersion: 3, projectId: f.projectId,
      actorId: bob.actorId, sequence: 10, lamport: 100, id: `${bob.actorId}:10`, certificate: f.member.certificate };
    const bytes = encodeCommands([{ ...metadata, type: "FILE_ADDED", itemId: id, fields: { arbitrary: "not file metadata" } }]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: fieldsAAD(metadata, "FILE_ADDED", id, key.id) }, key.key, bytes);
    const bad = await signEvent({ ...metadata, type: "FILE_ADDED", itemId: id, keyId: key.id,
      encryptedFields: { iv: toBase64Url(iv), ciphertext: toBase64Url(encrypted) } }, bob);
    const before = f.devices[0].durable.slice();
    await assert.rejects(f.a.ingestEvents([good.event, bad]), /Missing or unknown properties/);
    assert.deepEqual(f.devices[0].durable, before); assert.deepEqual((await f.a.snapshot()).items, []);
    await assert.rejects(f.a.dispatch({ type: "FILE_ADDED", itemId: id, fields: manifestFields({ ...good.manifest, fileId: good.manifest.fileId }) }), /manifest ID/);
    await f.a.ingestEvents([good.event]); assert.equal((await f.a.snapshot()).items.length, 1);
  } finally { await f.close(); }
});

test("FILE_ADDED before/after a native checkpoint reopens through the data-delta path and reads encrypted blobs", async () => {
  const projectId = `checkpoint-file-${crypto.randomUUID()}`, devices = [new Device(), new Device(), new Device()], blobs = new MemoryBlobs();
  let context = await ProjectContext.create(alice, projectId), invitation = context.invitation, core;
  const open = async () => {
    const journal = new CheckpointJournal([devices[1].open(), devices[2].open()], context);
    const log = await LocalEventStore.open(devices[0].open(), { actorId: alice.actorId, projectId }, () => {}, undefined, journal);
    return LocalCore.open(log, alice, context, { checkpointInterval: 2 });
  };
  try {
    core = await open(); let service = new StorageEngine(core, blobs);
    const first = await service.upload(new Blob(["first"]));
    await core.dispatch({ type: "ITEM_ADDED", itemId: "ordinary", fields: { n: 1 } });
    const second = await service.upload(new Blob(["delta"])), expected = await core.snapshot();
    await core.close(); context = await ProjectContext.open(invitation, alice, projectId); core = await open(); service = new StorageEngine(core, blobs);
    assert.equal(core.recovery.checkpointEvents, 2); assert.equal(core.recovery.replayedEvents, 1);
    assert.deepEqual(await core.snapshot(), expected);
    assert.equal(new TextDecoder().decode(await service.readChunk(first.manifest.fileId, 0)), "first");
    assert.equal(new TextDecoder().decode(await service.readChunk(second.manifest.fileId, 0)), "delta");
    assert.deepEqual((await core.readEvents()).map(e => e.type), ["FILE_ADDED", "ITEM_ADDED", "FILE_ADDED"]);
  } finally { await core?.close(); }
});
