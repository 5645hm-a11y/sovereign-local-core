import { FramedLog, inspectFrames, LogCorruptionError, type SyncFile } from "./framed-log.js";
import { ProjectContext } from "./project.js";
import { normalizeInvitation } from "./project-crypto.js";
import { sameDescriptor } from "./certificates.js";
import type { UnlockedIdentity } from "./identity.js";
import type { IdentityOpenOptions, ProjectInvitation } from "./types.js";

export class ProjectNotInitializedError extends Error {
  constructor() { super("Project is not initialized: create it or supply a trusted invitation"); this.name = "ProjectNotInitializedError"; }
}
type SyncHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncFile> };
/** Stores only public certificates and recipient-encrypted project keys, never raw AES keys. */
export async function openProject(databaseName: string, identity: UnlockedIdentity, options: IdentityOpenOptions, create: boolean): Promise<ProjectContext> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(databaseName)) throw new TypeError("Invalid database name");
  return navigator.locks.request(`sovereign-project-metadata:${databaseName}`, async () => {
    const root = await navigator.storage.getDirectory();
    const namespace = await root.getDirectoryHandle("sovereign-local-core", { create: true });
    const directory = await namespace.getDirectoryHandle(databaseName, { create: true });
    const file = await directory.getFileHandle("project.slp", { create: true }) as SyncHandle;
    const handle = await file.createSyncAccessHandle(), log = new FramedLog(handle);
    try {
      let saved: ProjectInvitation | undefined;
      inspectFrames(handle, (value, offset) => {
        if (saved) throw new LogCorruptionError(offset, "multiple project descriptors");
        saved = normalizeInvitation(value);
      });
      if (saved) {
        if (create) throw new Error("Project already initialized");
        const context = await ProjectContext.open(saved, identity, options.projectId);
        if (options.invitation && !sameDescriptor(normalizeInvitation(options.invitation).descriptor, context.descriptor)) throw new Error("Invitation conflicts with pinned project root");
        log.recover(() => {});
        return context;
      }
      let context: ProjectContext;
      if (create) {
        if (options.invitation) throw new Error("Cannot create a project using an invitation");
        context = await ProjectContext.create(identity, options.projectId);
      } else {
        if (!options.invitation) throw new ProjectNotInitializedError();
        context = await ProjectContext.open(options.invitation, identity, options.projectId);
      }
      log.recover(() => {});
      log.append(context.invitation); // Flush encrypted bootstrap material before opening the event log.
      return context;
    } finally { log.close(); }
  });
}
