import { LocalCoreClient, type ItemCommand } from "sovereign-local-core";

const login = document.querySelector<HTMLFormElement>("#login")!;
const add = document.querySelector<HTMLFormElement>("#add")!;
const project = document.querySelector<HTMLElement>("#project")!;
const list = document.querySelector<HTMLUListElement>("#tasks")!;
const error = document.querySelector<HTMLElement>("#error")!;
const preference = "sovereign-local-core.example.project";
const projectInput = login.elements.namedItem("projectId") as HTMLInputElement;
projectInput.value = localStorage.getItem(preference) ?? crypto.randomUUID();
let client: LocalCoreClient | null = null, unsubscribe: (() => void) | null = null;
const report = (value: unknown) => { error.textContent = value instanceof Error ? value.message : String(value); };

async function render() {
  const current = client; if (!current) return;
  const view = await current.snapshot(); if (current !== client) return;
  const rows = view.items.filter(item => item.fields.kind === "task").map(task => {
    const row = document.createElement("li"), label = document.createElement("label"), checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.checked = task.fields.done === true;
    checkbox.addEventListener("change", () => void write({ type: "ITEM_UPDATED", itemId: task.id, fields: { done: checkbox.checked } }).catch(report));
    label.append(checkbox, document.createTextNode(String(task.fields.title)));
    const remove = document.createElement("button"); remove.textContent = "Delete";
    remove.addEventListener("click", () => void write({ type: "ITEM_DELETED", itemId: task.id }).catch(report));
    row.append(label, remove); return row;
  });
  list.replaceChildren(...rows);
}
async function write(command: ItemCommand) {
  if (!client) throw new Error("Open a project first");
  error.textContent = ""; project.setAttribute("aria-busy", "true");
  try { await client.dispatch(command); await render(); }
  finally { project.setAttribute("aria-busy", "false"); }
}
login.addEventListener("submit", event => {
  event.preventDefault();
  const fields = new FormData(login), projectId = String(fields.get("projectId")).trim();
  const credentials = { projectId, email: String(fields.get("email")), password: String(fields.get("password")) };
  const submit = login.querySelector<HTMLButtonElement>("button")!; submit.disabled = true; error.textContent = "";
  void (async () => {
    const opened = new LocalCoreClient();
    try {
      try { await opened.open(projectId, credentials); }
      catch (failure) {
        if (!(failure instanceof Error) || failure.name !== "ProjectNotInitializedError") throw failure;
        await opened.createProject(projectId, credentials);
      }
      client = opened; unsubscribe = client.onCommit(() => void render().catch(report));
      localStorage.setItem(preference, projectId);
      (login.elements.namedItem("password") as HTMLInputElement).value = "";
      login.hidden = true; project.hidden = false; await render();
    } catch (failure) { await opened.close().catch(() => {}); report(failure); }
    finally { submit.disabled = false; }
  })();
});
add.addEventListener("submit", event => {
  event.preventDefault(); const title = String(new FormData(add).get("title")).trim(); if (!title) return;
  void write({ type: "ITEM_ADDED", itemId: `task_${crypto.randomUUID()}`, fields: { kind: "task", title, done: false } }).then(() => add.reset(), report);
});
document.querySelector("#close")!.addEventListener("click", () => {
  const closing = client; client = null; unsubscribe?.(); unsubscribe = null;
  void closing?.close().then(() => { project.hidden = true; login.hidden = false; list.replaceChildren(); }, report);
});
