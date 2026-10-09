import { LocalEventStore } from "./local-store.js";
import type { SyncFile } from "./framed-log.js";
import { acquireWriterLease } from "./identity-storage.js";
import { normalizeActorId, normalizeProjectId } from "./crypto-codec.js";
import type { ProjectContext } from "./project.js";
import { CheckpointJournal } from "./checkpoints.js";
import { BinaryProjection } from "./wasm-loader.js";
import { inspectFrames } from "./framed-log.js";
import { normalizeEvent } from "./validation.js";
import type { IEvent } from "./types.js";
import { isDataType } from "./types.js";

type SyncCapableHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncFile>;
};

/** Call only inside a Dedicated Worker in a secure context (HTTPS or localhost). */
export async function openOPFSStore(databaseName: string, actorId: string, projectId: string, project: ProjectContext): Promise<LocalEventStore> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(databaseName)) throw new TypeError("Invalid database name");
  if (!globalThis.isSecureContext || typeof navigator.storage?.getDirectory !== "function") {
    throw new Error("OPFS requires a supported browser and HTTPS or localhost");
  }
  normalizeActorId(actorId); normalizeProjectId(projectId);
  const release = await acquireWriterLease(actorId, projectId);
  try {
    const root = await navigator.storage.getDirectory();
    const namespace = await root.getDirectoryHandle("sovereign-local-core", { create: true });
    const directory = await namespace.getDirectoryHandle(databaseName, { create: true });
    const file = await directory.getFileHandle("events.slc", { create: true }) as SyncCapableHandle;
    if (typeof file.createSyncAccessHandle !== "function") {
      throw new Error("Synchronous OPFS access requires a supported Dedicated Worker");
    }
  // Default readwrite mode owns an exclusive browser-managed lock until close/worker death.
  // A second tab fails clearly instead of using unsafe concurrent writers.
    const handle = await file.createSyncAccessHandle();
    const checkpointHandles: SyncFile[] = [];
    let journal: CheckpointJournal | undefined;
    try {
      for (const slot of [0, 1]) {
        const file = await directory.getFileHandle(`checkpoint-${slot}.slc`, { create: true }) as SyncCapableHandle;
        checkpointHandles.push(await file.createSyncAccessHandle());
      }
      journal = new CheckpointJournal(checkpointHandles as [SyncFile, SyncFile], project);
      return await LocalEventStore.open(handle, { actorId, projectId }, release, async (events, cp) => {
        const native = await BinaryProjection.create(project.descriptor.policies);
        let blocks: readonly Uint8Array<ArrayBuffer>[] = [];
        let roles: readonly import("./types.js").Role[] = [];
        try {
          if (cp && events.every(e => isDataType(e.type))) {
            native.restore(cp.native);
            const policy = await project.restorePolicy(cp.controls, cp.certificates);
            const state = await project.extend(policy, events); blocks = state.blocks; roles = state.roles;
          } else {
            const history: IEvent[] = [];
            if (cp) inspectFrames(handle, value => {
              const record = value as { kind: string; event: unknown };
              if (record.kind === "event") history.push(normalizeEvent(record.event));
            });
            const state = await project.evaluateBinary(cp ? history : events); blocks = state.blocks; roles = state.roles;
          }
          native.applyAuthorized(blocks, roles); // Native scalar and RLS checks precede incomplete-tail repair.
        } finally { for (const block of blocks) block.fill(0); native.close(); }
      }, journal);
    } catch (error) {
      // LocalEventStore already closes on its own failure; close is idempotent for normal handles.
      for (const file of checkpointHandles) try { file.close(); } catch { /* Preserve original error. */ }
      try { handle.close(); } catch { /* Preserve original error. */ }
      throw error;
    }
  } catch (error) { await release(); throw error; }
}
