"use client";
import { useProject, useLiveQuery, usePagedQuery } from "sovereign-local-core/react";
const credentials = { email: "next-smoke@example.test", password: "next-smoke-password-2026", createIfMissing: true };
export default function Page() {
  const project = useProject("next_smoke", credentials);
  const paged = usePagedQuery({ kind: "items", prefix: "task_", limit: 2, maxBytes: 4096 }, { project });
  const query = useLiveQuery(view => view.items.filter(item => item.fields.kind === "task"), { project });
  return <main><h1>Next.js installed package</h1><p data-testid="status">{project.error?.message || project.status}</p>
    <button disabled={!project.client} onClick={() => project.client.dispatch({ type: "ITEM_ADDED", itemId: `task_${crypto.randomUUID()}`, fields: { kind: "task", title: "Next task" } })}>Create task</button>
    <p data-testid="paged-next-status">{paged.loading ? "loading" : paged.error?.message || "ready"}</p>
    <p data-testid="paged-next-count">{paged.page?.items.length ?? 0}</p>
    <ul>{query.data?.map(item => <li key={item.id}>{item.fields.title}</li>)}</ul>
  </main>;
}
