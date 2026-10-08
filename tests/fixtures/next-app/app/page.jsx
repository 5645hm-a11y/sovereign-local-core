"use client";
import { useProject, useLiveQuery } from "sovereign-local-core/react";
const credentials = { email: "next-smoke@example.test", password: "next-smoke-password-2026", createIfMissing: true };
export default function Page() {
  const project = useProject("next_smoke", credentials);
  const query = useLiveQuery(view => view.items.filter(item => item.fields.kind === "task"), { project });
  return <main><h1>Next.js installed package</h1><p data-testid="status">{project.error?.message || project.status}</p>
    <button disabled={!project.client} onClick={() => project.client.dispatch({ type: "ITEM_ADDED", itemId: `task_${crypto.randomUUID()}`, fields: { kind: "task", title: "Next task" } })}>Create task</button>
    <ul>{query.data?.map(item => <li key={item.id}>{item.fields.title}</li>)}</ul>
  </main>;
}
