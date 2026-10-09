import React, { StrictMode, memo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectProvider, useProject, useLiveQuery, useStorage } from "sovereign-local-core/react";
import "./style.css";

const params = new URLSearchParams(location.search);
const credentials = { email: "react-demo@example.test", password: "local-demo-password-2026", createIfMissing: true,
  ...(params.has("hosted") ? { clientOptions: { workerUrl: new URL("./p2p-core/worker.js", location.href) } } : {}),
  ...(params.has("signaling") ? { p2p: { signalingUrl: params.get("signaling"), roomId: params.get("room") } } : {}) };
const Tasks = memo(function Tasks({ client }) {
  const renders = useRef(0); renders.current++;
  const { data = [], error } = useLiveQuery(view => view.items.filter(item => item.fields.kind === "task"));
  const [title, setTitle] = useState(""), [failure, setFailure] = useState(null);
  async function add(event) {
    event.preventDefault(); if (!title.trim()) return;
    try { await client.dispatch({ type: "ITEM_ADDED", itemId: `task_${crypto.randomUUID()}`, fields: { kind: "task", title: title.trim(), done: false } }); setTitle(""); }
    catch (error) { setFailure(error.message); }
  }
  return <section><h2>Tasks</h2><form onSubmit={add}><input aria-label="Task title" value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?"/><button>Add task</button></form>
    <ul data-testid="tasks">{data.map(item => <li key={item.id}>{item.fields.title}</li>)}</ul>
    {(failure || error) && <p role="alert">{failure || error.message}</p>}
    <small>Task renders: <span data-testid="task-renders">{renders.current}</span></small></section>;
});
function Files() {
  const { data = [] } = useLiveQuery(view => view.items.filter(item => item.fields.storageType === "FILE_ADDED"));
  const storage = useStorage(), [failure, setFailure] = useState(null);
  async function upload(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try { await storage.upload(file); } catch (error) { setFailure(error.message); }
    event.target.value = "";
  }
  async function download(id) {
    try {
      // A user-selected streaming destination keeps large files bounded in memory.
      if ("showSaveFilePicker" in window) {
        const handle = await window.showSaveFilePicker(); await storage.pipeTo(id, await handle.createWritable());
      } else {
        const blob = await storage.readBlob(id); const url = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = url; link.download = "download"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { setFailure(error.message); }
  }
  const p = storage.progress;
  return <section><h2>Encrypted files</h2><input aria-label="Upload file" type="file" onChange={upload} disabled={["uploading", "downloading"].includes(storage.status)}/>
    <p data-testid="storage-status">{storage.status}{p && ` · ${p.completedChunks}/${p.totalChunks} chunks · ${p.processedBytes} bytes`}</p>
    <progress max={p?.totalChunks || 1} value={p?.completedChunks || 0}/>
    <ul data-testid="files">{data.map(item => <li key={item.id}>{item.id} <button onClick={() => download(item.id)}>Save file</button></li>)}</ul>
    {storage.status === "uploading" && <button onClick={storage.cancel}>Cancel upload</button>}
    {(failure || storage.error) && <p role="alert">{failure || storage.error.message}</p>}
  </section>;
}
function Project() {
  const project = useProject("react_demo_project", credentials);
  const [failure, setFailure] = useState(null);
  if (project.status !== "ready") return <p role={project.error ? "alert" : "status"}>{project.error?.message || "Opening encrypted local project…"}</p>;
  return <ProjectProvider project={project}><p data-testid="project-status">Ready · {project.connection}</p>
    <Tasks client={project.client}/><Files/>
    <button onClick={() => project.client.dispatch({ type: "ITEM_ADDED", itemId: `note_${crypto.randomUUID()}`, fields: { kind: "note", title: "Unrelated record" } }).catch(error => setFailure(error.message))}>Add unrelated record</button>
    {failure && <p role="alert">{failure}</p>}
  </ProjectProvider>;
}
function App() {
  const [mounted, setMounted] = useState(true);
  return <main><h1>Local-first React</h1><p>Tasks and encrypted file chunks persist in this browser. This example uses fixed demo credentials; supply real user credentials in your application.</p>
    <button onClick={() => setMounted(!mounted)}>{mounted ? "Close project" : "Reopen project"}</button>
    {mounted && <Project/>}
  </main>;
}
// Installed optional-entry probe, also exercised in the production /demo/ bundle.
window.probeNostr = async url => {
  const { NostrDiscovery } = await import("sovereign-local-core/nostr");
  const provider = new NostrDiscovery({ relays: [url] });
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const topic = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  let receive, timer;
  const delivered = new Promise((resolve, reject) => {
    receive = resolve;
    timer = setTimeout(() => reject(new Error("Installed Nostr adapter receive timed out")), 5000);
  });
  try {
    await provider.start(topic, receive);
    await provider.publish(bytes);
    const received = await delivered;
    return { equal: received.every((value, index) => value === bytes[index]), ...provider.stats };
  } finally { clearTimeout(timer); provider.stop(); }
};
createRoot(document.getElementById("root")).render(<StrictMode><App/></StrictMode>);
