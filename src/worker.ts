import { LocalCore } from "./engine.js";
import { openOPFSStore } from "./opfs.js";
import { normalizeCommand } from "./validation.js";
import { openIdentityVault } from "./identity-storage.js";
import { normalizeProjectId } from "./crypto-codec.js";
import type { IdentityOpenOptions } from "./types.js";
import { openProject } from "./project-storage.js";
import { loadWasmRuntime } from "./wasm-loader.js";
import { StorageEngine } from "./storage.js";
import { OPFSBlobStore } from "./blob-store.js";

interface WorkerScope {
  onmessage: ((message: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}
const scope = globalThis as unknown as WorkerScope;
let core: LocalCore | undefined;
let storage: StorageEngine | undefined;
let queue: Promise<void> = Promise.resolve();
const uploads = new Map<number, AbortController>();
const wasmReady = loadWasmRuntime(); // Start compilation/loading when the Dedicated Worker starts.
void wasmReady.catch(() => {}); // Report startup failure through the normal open RPC.

scope.onmessage = (message) => {
  if (message.data.method === "cancelUpload") { uploads.get(message.data.targetId)?.abort(); return; }
  if (message.data.method === "uploadFile") uploads.set(message.data.id, new AbortController());
  queue = queue.then(async () => {
    const request = message.data as {
      id: number; method: string; databaseName?: string; command?: unknown; events?: unknown[]; summary?: unknown;
      options?: IdentityOpenOptions;
      actorId?: string; role?: import("./types.js").Role;
      revokeOptions?: import("./types.js").RevokeOptions;
      blob?: Blob; uploadOptions?: import("./storage.js").UploadOptions; fileId?: string; index?: number;
      bytes?: Uint8Array<ArrayBuffer>; chunkRequest?: import("./storage.js").ChunkRequest; manifestDigest?: string;
      signal?: import("./discovery-provider.js").DiscoverySignal; packet?: Uint8Array<ArrayBuffer>;
      cursorId?: string;
      queryOptions?: import("./query.js").QueryOptions;
    };
    try {
      let result: unknown;
      if (request.method === "identify") {
        if (core) throw new Error("Identity identification requires an unopened client");
        result = { actorId: (await openIdentityVault(request.options!)).actorId };
      } else if (["open", "createProject", "openCompact", "createProjectCompact"].includes(request.method)) {
        await wasmReady;
        if (core) throw new Error("Worker already owns a database");
        if (!request.options) throw new TypeError("Identity credentials and projectId are required");
        const projectId = normalizeProjectId(request.options.projectId);
        const identity = await openIdentityVault(request.options);
        const databaseName = request.databaseName ?? "local-core";
        const creating = request.method === "createProject" || request.method === "createProjectCompact";
        const compact = request.method === "openCompact" || request.method === "createProjectCompact";
        const project = await openProject(databaseName, identity, request.options, creating);
        core = await LocalCore.open(await openOPFSStore(databaseName, identity.actorId, projectId, project), identity, project);
        try {
          storage = new StorageEngine(core, await OPFSBlobStore.open(databaseName, projectId));
          core.onCommit(notification => scope.postMessage({ kind: "commit", ...notification }));
          const opened = { actorId: core.actorId, projectId: core.projectId, recovery: core.recovery };
          result = compact ? opened : { ...opened, snapshot: await core.snapshot() };
        } catch (error) {
          // Lazy first-view failure must release the log lock and permit reopening this Worker.
          try { await core.close(); } catch { /* Preserve the original startup error. */ }
          core = undefined; storage = undefined; throw error;
        }
      } else {
        if (!core) throw new Error("Open a database first");
        switch (request.method) {
          case "dispatch": result = await core.dispatch(normalizeCommand(request.command)); break;
          case "dispatchCommitted": result = await core.dispatchCommitted(normalizeCommand(request.command)); break;
          case "snapshot": result = await core.snapshot(); break;
          case "openQueryCursor": result = await core.openQueryCursor(request.queryOptions!); break;
          case "readQueryCursor": result = await core.readQueryCursor(request.cursorId!); break;
          case "closeQueryCursor": await core.closeQueryCursor(request.cursorId!); result = null; break;
          case "getProjectInfo": result = await core.getProjectInfo(); break;
          case "getBootstrapInvitation": result = await core.getBootstrapInvitation(); break;
          case "getMemberCertificate": result = await core.getMemberCertificate(request.actorId!); break;
          case "getDiscoveryInfo": result = await core.getDiscoveryInfo(); break;
          case "isDiscoveryPeerAuthorized": result = await core.isDiscoveryPeerAuthorized(request.actorId!); break;
          case "getDiscoveryRecoveryInfo": result = await core.getDiscoveryRecoveryInfo(); break;
          case "createDiscoveryRecoveryRequest": result = await core.createDiscoveryRecoveryRequest(); break;
          case "createRoutedDiscoveryRecoveryRequest": result = await core.createRoutedDiscoveryRecoveryRequest(); break;
          case "handleDiscoveryRecoveryRequest": result = await core.handleDiscoveryRecoveryRequest(request.packet!); break;
          case "handleRoutedDiscoveryRecoveryRequest": result = await core.handleRoutedDiscoveryRecoveryRequest(request.packet!); break;
          case "acceptDiscoveryRecoveryResponse": result = await core.acceptDiscoveryRecoveryResponse(request.packet!); break;
          case "cancelDiscoveryRecovery": await core.cancelDiscoveryRecovery(); result = null; break;
          case "sealDiscovery": result = await core.sealDiscovery(request.signal!); break;
          case "openDiscovery": result = await core.openDiscovery(request.packet!); break;
          case "inviteMember": result = await core.inviteMember(request.actorId!, request.role); break;
          case "revokeMember": result = await core.revokeMember(request.actorId!, request.revokeOptions); break;
          case "readEvents": result = await core.readEvents(); break;
          case "getSyncSummary": result = await core.getSyncSummary(); break;
          case "readMissingEvents": result = await core.readMissingEvents(request.summary as import("./types.js").SyncSummary); break;
          case "readMissingEventsPaged": result = await core.readMissingEventsPaged(request.summary as import("./types.js").SyncSummary); break;
          case "openSyncCursor": result = await core.openSyncCursor(request.summary as import("./types.js").SyncSummary); break;
          case "readSyncCursor": result = await core.readSyncCursor(request.cursorId!); break;
          case "closeSyncCursor": await core.closeSyncCursor(request.cursorId!); result = null; break;
          case "ingestEvents": result = await core.ingestEvents(request.events!); break;
          case "ingestCommitted": result = await core.ingestCommitted(request.events!); break;
          case "uploadFile": result = await storage!.upload(request.blob!, { ...request.uploadOptions,
            signal: uploads.get(request.id)!.signal,
            onProgress: progress => scope.postMessage({ kind: "progress", id: request.id, progress }) }); break;
          case "fileInfo": result = await storage!.info(request.fileId!); break;
          case "readFileChunk": result = await storage!.readChunk(request.fileId!, request.index!, request.manifestDigest); break;
          case "acceptFileChunk": result = await storage!.acceptChunk(request.fileId!, request.index!, request.bytes!, request.manifestDigest); break;
          case "createChunkRequest": result = await storage!.createRequest(request.fileId!, request.index!, request.manifestDigest); break;
          case "serveChunk": result = await storage!.serveChunk(request.chunkRequest!); break;
          case "close": await core.close(); core = undefined; storage = undefined; result = null; break;
          default: throw new Error("Unknown worker method");
        }
      }
      scope.postMessage({ id: request.id, ok: true, result }, result instanceof Uint8Array ? [result.buffer] : []);
    } catch (error) {
      scope.postMessage({ id: request.id, ok: false, error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      } });
    } finally { uploads.delete(request.id); }
  });
};
