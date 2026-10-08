import React, { useState } from "react";
import { ProjectProvider, useProject } from "sovereign-local-core/react";
import { Tasks } from "./Tasks.jsx";
import { Files } from "./Files.jsx";

const projectPreference = "sovereign-local-core.example.project";
function Project({ account, onClose }) {
  const project = useProject(account.projectId, account);
  if (project.status === "error") return <section><p role="alert">{project.error.message}</p><button onClick={onClose}>Back to sign in</button></section>;
  if (project.status !== "ready") return <p role="status">Opening the encrypted local project…</p>;
  return <ProjectProvider project={project}>
    <p data-testid="project-status">Ready · {project.connection}</p>
    <button onClick={onClose}>Close project</button>
    <Tasks client={project.client}/><Files client={project.client}/>
  </ProjectProvider>;
}
export function App() {
  const [account, setAccount] = useState(null);
  const [projectId, setProjectId] = useState(() => {
    const id = localStorage.getItem(projectPreference) ?? crypto.randomUUID();
    localStorage.setItem(projectPreference, id); return id;
  });
  function signIn(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const selectedProject = String(form.get("projectId")).trim();
    localStorage.setItem(projectPreference, selectedProject);
    setProjectId(selectedProject);
    setAccount({ projectId: selectedProject, email: String(form.get("email")), password: String(form.get("password")), createIfMissing: true });
    event.currentTarget.reset();
  }
  return <main><h1>Sovereign Local Core</h1><p>A small React To-Do app with an encrypted database and file storage in your browser.</p>
    {account ? <Project account={account} onClose={() => setAccount(null)}/> : <section>
      <h2>Open a local project</h2><p>Choose your email identifier and a password of at least 12 characters. Reuse them and this project ID to reopen your data. The password stays in memory while signed in.</p>
      <form onSubmit={signIn} className="login">
        <label>Email<input name="email" type="email" autoComplete="username" required/></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" minLength={12} maxLength={1024} required/></label>
        <label>Project ID<input name="projectId" defaultValue={projectId} pattern="[A-Za-z0-9_-]{1,128}" required/></label>
        <button>Open project</button>
      </form><p>This creates a local Admin project on first use. Joining someone else's project requires their signed invitation; knowing an ID does not grant access.</p>
    </section>}
  </main>;
}
