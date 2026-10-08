import { FramedLog, LogCorruptionError, type SyncFile } from "./framed-log.js";
import { createIdentityVault, normalizeEmail, normalizeVault, unlockIdentityVault, type IdentityVault, type UnlockedIdentity } from "./identity.js";
import { toBase64Url } from "./crypto-codec.js";
import type { IdentityOpenOptions } from "./types.js";

type SyncCapableHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncFile> };

/** Vault creation/read is serialized across workers. Only encrypted bytes are ever written. */
export async function openIdentityVault(options: IdentityOpenOptions): Promise<UnlockedIdentity> {
  if (!options || typeof options !== "object") throw new TypeError("Identity credentials required");
  const email = normalizeEmail(options.email);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const vaultName = options.vaultName ?? `account_${toBase64Url(digest)}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(vaultName)) throw new TypeError("Invalid vault name");
  return navigator.locks.request(`sovereign-vault:${vaultName}`, async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("sovereign-identity-vaults", { create: true });
    const file = await directory.getFileHandle(`${vaultName}.slv`, { create: true }) as SyncCapableHandle;
    const handle = await file.createSyncAccessHandle();
    const log = new FramedLog(handle);
    try {
      let vault: IdentityVault | undefined;
      log.recover((value, offset) => {
        if (vault !== undefined) throw new LogCorruptionError(offset, "multiple vault records");
        vault = normalizeVault(value);
      });
      if (vault) return await unlockIdentityVault(vault, email, options.password);
      const created = await createIdentityVault(email, options.password);
      log.append(created.vault); // Flush vault BEFORE any project log can refer to its actor.
      return created.identity;
    } finally { log.close(); }
  });
}

/** One local writer per actor/project even when two tabs choose different replica filenames. */
export async function acquireWriterLease(actorId: string, projectId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const lease = navigator.locks.request(`sovereign-writer:${projectId}:${actorId}`, { ifAvailable: true }, async lock => {
    if (!lock) throw new DOMException("This identity already writes this project in another worker", "NoModificationAllowedError");
    acquired();
    await released;
  }).catch(error => { failed(error); });
  await ready;
  return async () => { release(); await lease; };
}
