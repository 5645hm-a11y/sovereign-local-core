import { LocalCoreClient, P2PWebRTC, type ItemCommand, type ProjectInvitation, type IEvent, type WalletOpenOptions } from "sovereign-local-core";
import { NostrDiscovery } from "sovereign-local-core/nostr";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const walletForm = element<HTMLFormElement>("wallet"), projectForm = element<HTMLFormElement>("project-form");
const joinForm = element<HTMLFormElement>("join"), inviteForm = element<HTMLFormElement>("invite");
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
const preference = "sovereign-local-core.sync-example";
let remembered: { walletId?: string; projectId?: string } = {};
try { remembered = JSON.parse(localStorage.getItem(preference) ?? "{}"); } catch { /* Preferences are optional. */ }
field(walletForm, "walletId").value = typeof remembered.walletId === "string" ? remembered.walletId : globalThis.crypto?.randomUUID?.() ?? "";
field(projectForm, "projectId").value = typeof remembered.projectId === "string" ? remembered.projectId : globalThis.crypto?.randomUUID?.() ?? "";
let client: LocalCoreClient | null = null;
let credentials: Omit<WalletOpenOptions, "projectId"> | null = null;
let sync: P2PWebRTC | null = null, offCommit: (() => void) | null = null, offState: (() => void) | null = null, offStorage: (() => void) | null = null;
let opened = false, busy = false, renderPending = false, rendering = false;
let session = 0;
const report = (error: unknown) => { element("error").textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error); };

async function capabilityCheck() {
  const status = element("capabilities");
  if (!isSecureContext || !globalThis.Worker || !navigator.storage?.getDirectory || !globalThis.crypto?.subtle) {
    status.textContent = "Unavailable: use HTTPS or localhost in a browser with Worker OPFS and Web Crypto.";
    walletForm.querySelector<HTMLButtonElement>("button")!.disabled = true; return;
  }
  const worker = new Worker(new URL("./capabilities-worker.ts", import.meta.url), { type: "module" });
  try {
    const result = await new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker capability check timed out")), 10000);
      worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage(null);
    });
    status.textContent = result.message;
    walletForm.querySelector<HTMLButtonElement>("button")!.disabled = !result.ok;
  } catch (error) { status.textContent = `Capability check failed: ${error instanceof Error ? error.message : String(error)}`; }
  finally { worker.terminate(); }
}
void capabilityCheck();

async function action(work: () => Promise<void>) {
  if (busy) return;
  busy = true; element("error").textContent = ""; document.body.setAttribute("aria-busy", "true");
  element<HTMLButtonElement>("close").disabled = true;
  try { await work(); } catch (error) { report(error); }
  finally { busy = false; document.body.setAttribute("aria-busy", "false"); element<HTMLButtonElement>("close").disabled = false; }
}
function requireClient() { if (!client) throw new Error("Unlock this device first"); return client; }
function pauseSync() {
  offState?.(); offState = null; offStorage?.(); offStorage = null; sync?.stop(); sync = null;
  element<HTMLButtonElement>("connect").disabled = !opened;
  element<HTMLButtonElement>("disconnect").disabled = true;
  element("network-status").textContent = "Sync paused. Local edits are stored on this device.";
}
async function render() {
  renderPending = true; if (rendering) return; rendering = true;
  try {
    while (renderPending && client && opened) {
      renderPending = false; const current = client;
      const cursor = await current.openQueryCursor({ kind: "items", prefix: "note_", limit: 100 });
      try {
        const page = await current.readQueryCursor(cursor.id);
        if (current !== client) return;
        const rows = page.items.map(item => {
          const row = document.createElement("li"), label = document.createElement("label"), checkbox = document.createElement("input");
          checkbox.type = "checkbox"; checkbox.checked = item.fields.done === true;
          checkbox.addEventListener("change", () => void action(() => write({ type: "ITEM_UPDATED", itemId: item.id, fields: { done: checkbox.checked } })));
          label.append(checkbox, document.createTextNode(String(item.fields.title)));
          row.append(label); return row;
        });
        element("records").replaceChildren(...rows); element("empty").hidden = rows.length > 0; element("read-limit").hidden = page.done;
      } catch (error) {
        if (error instanceof Error && error.name === "QueryCursorInvalidatedError") renderPending = true;
        else throw error;
      } finally { await current.closeQueryCursor(cursor.id); }
    }
  } finally { rendering = false; }
}
async function projectReady() {
  const db = requireClient(), info = await db.getProjectInfo(); opened = true;
  field(projectForm, "projectId").value = info.descriptor.projectId;
  try { localStorage.setItem(preference, JSON.stringify({ walletId: credentials?.walletId, projectId: info.descriptor.projectId })); }
  catch { /* Preferences are optional; an OPFS commit must not depend on localStorage. */ }
  element("project-status").textContent = `${info.certificate.role} · ${info.descriptor.projectId}`;
  element<HTMLTextAreaElement>("root").value = info.descriptor.rootActorId; element("root-label").hidden = false;
  inviteForm.hidden = info.certificate.role !== "Admin"; projectForm.hidden = true; joinForm.hidden = true;
  element<HTMLFieldSetElement>("network-controls").disabled = false; element<HTMLFieldSetElement>("write-controls").disabled = false;
  offCommit?.(); offCommit = db.onCommit(() => void render().catch(report)); await render();
}
async function write(command: ItemCommand) {
  if (!opened) throw new Error("Open a project first");
  await requireClient().dispatchCommitted(command); await render();
}
walletForm.addEventListener("submit", event => {
  event.preventDefault(); void action(async () => {
    const db = new LocalCoreClient();
    const next = { mode: "wallet" as const, walletId: field(walletForm, "walletId").value, passphrase: field(walletForm, "passphrase").value };
    try {
      const identity = await db.identify(next); client = db; credentials = next; session++;
      element<HTMLTextAreaElement>("actor").value = identity.actorId;
      field(walletForm, "passphrase").value = ""; walletForm.hidden = true; element("workspace").hidden = false;
    } catch (error) { await db.close().catch(() => {}); throw error; }
  });
});
projectForm.addEventListener("submit", event => {
  event.preventDefault(); const operation = (event as SubmitEvent).submitter?.getAttribute("value");
  void action(async () => {
    const db = requireClient(), projectId = field(projectForm, "projectId").value;
    const options = { ...credentials!, projectId };
    if (operation === "create") await db.createProjectCompact(projectId, options);
    else await db.openCompact(projectId, options);
    await projectReady();
  });
});
inviteForm.addEventListener("submit", event => {
  event.preventDefault(); void action(async () => {
    const result = await requireClient().inviteMember(field(inviteForm, "recipient").value.trim());
    element<HTMLTextAreaElement>("invitation-output").value = JSON.stringify({ invitation: result.invitation, event: result.event });
  });
});
element("copy-invitation").addEventListener("click", () => void action(async () => {
  const output = element<HTMLTextAreaElement>("invitation-output");
  if (!output.value) throw new Error("Create an invitation first");
  try { await navigator.clipboard.writeText(output.value); }
  catch { output.focus(); output.select(); throw new Error("Clipboard unavailable. Copy the selected invitation manually."); }
}));
joinForm.addEventListener("submit", event => {
  event.preventDefault(); void action(async () => {
    const raw = field(joinForm, "invitation").value;
    if (raw.length > 1048576) throw new Error("Invitation exceeds this example’s 1 MiB limit");
    const bundle = JSON.parse(raw) as { invitation: ProjectInvitation; event: IEvent };
    if (!bundle.invitation?.descriptor || !bundle.event || bundle.invitation.descriptor.rootActorId !== field(joinForm, "trustedRoot").value.trim()) throw new Error("Invitation root does not match the trusted project root");
    const projectId = bundle.invitation.descriptor.projectId;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new Error("Invalid project ID");
    const db = requireClient();
    await db.openCompact(projectId, { ...credentials!, projectId, invitation: bundle.invitation });
    await db.ingestCommitted([bundle.event]); await projectReady();
    field(joinForm, "invitation").value = "";
  });
});
element("connect").addEventListener("click", () => void action(async () => {
  if (!opened) throw new Error("Open a project first");
  pauseSync(); const db = requireClient(), activeSession = session;
  const relays = element<HTMLTextAreaElement>("relays").value.split(/[\s,]+/).filter(Boolean);
  const iceServers: RTCIceServer[] = JSON.parse(element<HTMLTextAreaElement>("ice").value);
  if (!Array.isArray(iceServers)) throw new Error("ICE configuration must be an array");
  if (!globalThis.RTCPeerConnection) throw new Error("This browser does not expose WebRTC DataChannels");
  const network = new P2PWebRTC(db, { discovery: new NostrDiscovery({ relays }), iceServers, maxPeers: 4,
    onError: error => { if (session === activeSession) report(error); } });
  sync = network; offStorage = db.storage.addPeer(network);
  offState = network.onStateChange(state => { element("network-status").textContent = `${state} · ${network.peers.filter(peer => peer.state === "online").length} online peers`; });
  element<HTMLButtonElement>("connect").disabled = true;
  element<HTMLButtonElement>("disconnect").disabled = false;
  try { await network.start(); } catch (error) { pauseSync(); throw error; }
}));
element("disconnect").addEventListener("click", pauseSync);
element<HTMLFormElement>("add-note").addEventListener("submit", event => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement, title = field(form, "title").value.trim();
  if (title) void action(async () => { await write({ type: "ITEM_ADDED", itemId: `note_${crypto.randomUUID()}`, fields: { title, done: false } }); form.reset(); });
});
element("close").addEventListener("click", () => void action(async () => {
  session++; pauseSync(); offCommit?.(); offCommit = null; opened = false;
  const closing = client; client = null; credentials = null; await closing?.close();
  location.reload();
}));
addEventListener("pagehide", () => { session++; pauseSync(); offCommit?.(); client?.terminate(); client = null; credentials = null; });
