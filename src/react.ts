"use client";
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ProjectSession, equalQuery, type ProjectCredentials } from "./react-session.js";
import { PagedQueryStore } from "./paged-query.js";
import { normalizeQueryOptions, queryOptionsKey, type QueryOptions } from "./query.js";
export type { PagedQueryState } from "./paged-query.js";
import type { Snapshot } from "./types.js";
import type { StorageProgress, UploadOptions, StorageReadOptions } from "./storage-format.js";
export type { ProjectCredentials, ProjectState } from "./react-session.js";

export function useProject(projectId: string, credentials: ProjectCredentials) {
  const wallet = credentials.mode === "wallet";
  const selector = wallet ? credentials.walletId : credentials.email;
  const secret = wallet ? credentials.passphrase : credentials.password;
  const session = useMemo(() => new ProjectSession(projectId, credentials), [projectId, wallet, selector, secret, credentials.policies, credentials.readDomain,
    credentials.vaultName, credentials.invitation, credentials.databaseName, credentials.createIfMissing, credentials.clientOptions, credentials.p2p]);
  useEffect(() => session.retain(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getServerState);
  return useMemo(() => ({ ...state, projectId, session }), [state, projectId, session]);
}
export type ProjectHandle = ReturnType<typeof useProject>;
const ProjectContext = createContext<ProjectSession | null>(null);
export function ProjectProvider({ project, children }: { project: ProjectHandle; children: ReactNode }) {
  return createElement(ProjectContext.Provider, { value: project.session }, children);
}
function useSession(project?: ProjectHandle): ProjectSession {
  const context = useContext(ProjectContext), session = project?.session ?? context;
  if (!session) throw new Error("Wrap hooks in ProjectProvider or pass a ProjectHandle");
  return session;
}
export interface LiveQueryResult<T> { readonly data: T | undefined; readonly loading: boolean; readonly error: Error | null }
const waiting = Object.freeze({ data: undefined, loading: true, error: null });
/** Synchronous pure projection of the cached Worker view. IO belongs to effects/actions. */
export function useLiveQuery<T>(queryFn: (snapshot: Snapshot) => T, options: { project?: ProjectHandle; isEqual?: (a: T, b: T) => boolean } = {}): LiveQueryResult<T> {
  const session = useSession(options.project);
  const committed = useRef<LiveQueryResult<T>>(waiting);
  const store = useMemo(() => {
    let result: LiveQueryResult<T> = committed.current;
    const selector = queryFn, equals = options.isEqual ?? equalQuery;
    let lastView: Snapshot | null | undefined, lastFailure: Error | null | undefined;
    const evaluate = () => {
      const view = session.getView(), failure = session.getState().error;
      if (view === lastView && failure === lastFailure) return result;
      lastView = view; lastFailure = failure;
      if (!view) {
        if (failure) { if (result.error !== failure) result = { data: undefined, loading: false, error: failure }; }
        else result = waiting;
        return result;
      }
      try {
        const data = selector(view);
        if (result.loading || result.error || !equals(result.data as T, data)) result = { data, loading: false, error: null };
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        if (!result.error || result.error.name !== error.name || result.error.message !== error.message) result = { data: undefined, loading: false, error };
      }
      return result;
    };
    return {
      getSnapshot: evaluate,
      getServerSnapshot: () => waiting,
      subscribe(listener: () => void) {
        const changed = () => { const before = result; if (evaluate() !== before) listener(); };
        const offView = session.subscribeView(changed), offState = session.subscribe(changed);
        return () => { offView(); offState(); };
      },
    };
  }, [session, queryFn, options.isEqual]);
  // Each render owns its selector closure; an abandoned concurrent render cannot replace a committed subscription's query.
  const result = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => { committed.current = result; }, [result]);
  return result;
}

export interface StorageHookState {
  readonly status: "idle" | "uploading" | "downloading" | "success" | "error";
  readonly progress: StorageProgress | null; readonly error: Error | null;
}
/** One bounded page; relevant commits restart at page zero. No full Snapshot subscription. */
export function usePagedQuery(query: QueryOptions, options: { project?: ProjectHandle; refreshDelayMs?: number } = {}) {
  const session = useSession(options.project), normalized = normalizeQueryOptions(query);
  const descriptor = queryOptionsKey(normalized);
  const store = useMemo(() => new PagedQueryStore(session, normalized, options.refreshDelayMs),
    [session, descriptor, options.refreshDelayMs]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return useMemo(() => ({ ...state, next: store.next, refresh: store.refresh }), [state, store]);
}
export function useStorage(project?: ProjectHandle) {
  const session = useSession(project);
  const [state, setState] = useState<StorageHookState>({ status: "idle", progress: null, error: null });
  const active = useRef(false), current = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; current.current?.abort(); current.current = null; }; }, [session]);
  const actions = useMemo(() => {
    async function run<T>(status: "uploading" | "downloading", options: StorageReadOptions,
      action: (options: StorageReadOptions) => Promise<T>): Promise<T> {
      if (!active.current) throw new Error("Storage hook is unmounted");
      if (current.current) throw new Error("A storage operation is already active in this hook");
      const controller = new AbortController(); current.current = controller;
      const abort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
      setState({ status, progress: null, error: null });
      try {
        const result = await action({ signal: controller.signal, onProgress: progress => {
          if (active.current && current.current === controller) setState({ status, progress, error: null });
          try { options.onProgress?.(progress); } catch { /* Isolate observers. */ }
        } });
        if (active.current && current.current === controller) setState(old => ({ ...old, status: "success" }));
        return result;
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        if (active.current && current.current === controller) setState(old => ({ ...old, status: "error", error }));
        throw error;
      } finally { options.signal?.removeEventListener("abort", abort); if (current.current === controller) current.current = null; }
    }
    return {
      upload: (blob: Blob, options: UploadOptions = {}) => run("uploading", options,
        progress => session.requireClient().storage.upload(blob, { ...options, ...progress })),
      readBlob: (id: string, options: StorageReadOptions = {}) => run("downloading", options,
        progress => session.requireClient().storage.readBlob(id, progress)),
      pipeTo: (id: string, destination: WritableStream<Uint8Array<ArrayBuffer>>, options: StorageReadOptions = {}) => run("downloading", options,
        progress => session.requireClient().storage.pipeTo(id, destination, progress)),
      cancel: () => current.current?.abort(),
    };
  }, [session]);
  return { ...state, ...actions };
}
