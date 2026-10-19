/// <reference lib="webworker" />
export {};
const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = async () => {
  let handle: FileSystemSyncAccessHandle | undefined;
  let directory: FileSystemDirectoryHandle | undefined;
  const name = `.slc-support-${crypto.randomUUID()}`;
  let result: { ok: boolean; message: string };
  let stage = "basic WASM";
  try {
    await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
    stage = "Web Crypto"; await crypto.subtle.digest("SHA-256", new Uint8Array([1]));
    stage = "OPFS directory";
    directory = await navigator.storage.getDirectory();
    stage = "OPFS file"; const file = await directory.getFileHandle(name, { create: true });
    stage = "OPFS synchronous access handle";
    handle = await file.createSyncAccessHandle();
    stage = "OPFS write / flush / read"; handle.write(new Uint8Array([83,76,67]), { at: 0 }); handle.flush();
    const read = new Uint8Array(3); handle.read(read, { at: 0 });
    if (read.join() !== "83,76,67") throw new Error("OPFS write/read mismatch");
    result = { ok: true, message: "Worker OPFS flush/read, Web Crypto and basic WASM checks passed. Opening a project tests the complete engine." };
  } catch (error) {
    result = { ok: false, message: `${stage}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` };
  } finally {
    handle?.close();
    await directory?.removeEntry(name).catch(() => {});
  }
  scope.postMessage(result);
};
