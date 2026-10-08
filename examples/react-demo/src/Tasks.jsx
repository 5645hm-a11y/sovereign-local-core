import React, { memo, useState } from "react";
import { useLiveQuery } from "sovereign-local-core/react";

export const Tasks = memo(function Tasks({ client }) {
  const { data: tasks = [], error } = useLiveQuery(view => view.items.filter(item => item.fields.kind === "task"));
  const [title, setTitle] = useState(""), [failure, setFailure] = useState(null), [busy, setBusy] = useState(false);
  async function write(command) {
    setBusy(true); setFailure(null);
    try { await client.dispatch(command); return true; } catch (error) { setFailure(error.message); return false; }
    finally { setBusy(false); }
  }
  async function add(event) {
    event.preventDefault(); if (!title.trim()) return;
    if (await write({ type: "ITEM_ADDED", itemId: `task_${crypto.randomUUID()}`, fields: { kind: "task", title: title.trim(), done: false } })) setTitle("");
  }
  return <section><h2>Tasks</h2><form onSubmit={add}>
    <input aria-label="Task title" value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={500}/>
    <button disabled={busy}>Add task</button>
  </form><ul data-testid="tasks">{tasks.map(task => <li key={task.id}>
    <label><input type="checkbox" checked={task.fields.done === true} disabled={busy} onChange={e => void write({ type: "ITEM_UPDATED", itemId: task.id, fields: { done: e.target.checked } })}/>{task.fields.title}</label>
    <button disabled={busy} onClick={() => void write({ type: "ITEM_DELETED", itemId: task.id })} aria-label={`Delete ${task.fields.title}`}>Delete</button>
  </li>)}</ul>{(failure || error) && <p role="alert">{failure || error.message}</p>}</section>;
});
