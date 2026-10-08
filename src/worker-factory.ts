export interface LocalCoreClientOptions {
  /** Same-origin hosted bundle, useful when CSP disallows blob: Workers. */
  readonly workerUrl?: string | URL;
  /** Override for bundler-specific worker imports or tests. Caller owns its creation. */
  readonly workerFactory?: () => Worker;
}
export function createCoreWorker(options: LocalCoreClientOptions): Worker {
  if (options.workerFactory) return options.workerFactory();
  if (options.workerUrl) return new Worker(options.workerUrl, { type: "module" });
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}
