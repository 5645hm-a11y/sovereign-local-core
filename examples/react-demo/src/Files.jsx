import React, { useEffect, useState } from "react";
import { useLiveQuery, useStorage } from "sovereign-local-core/react";

function FileRow({ item, client, save, busy }) {
  const [manifest, setManifest] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    client.storage.info(item.id).then(value => { if (live) setManifest(value); }, error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [client, item.id, item.fields.manifest]);
  return <li>{error || manifest?.name || "Loading metadata…"}{manifest && <> · {manifest.size} bytes <button disabled={busy} onClick={() => void save(manifest)}>Save file</button></>}</li>;
}
export function Files({ client }) {
  const { data: files = [] } = useLiveQuery(view => view.items.filter(item => item.fields.storageType === "FILE_ADDED"));
  const storage = useStorage(), [error, setError] = useState(null);
  const busy = ["uploading", "downloading"].includes(storage.status);
  async function upload(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setError(null);
    try { await storage.upload(file); } catch (error) { setError(error.message); }
    event.target.value = "";
  }
  async function save(manifest) {
    setError(null);
    try {
      if ("showSaveFilePicker" in window) {
        const handle = await window.showSaveFilePicker({ suggestedName: manifest.name });
        await storage.pipeTo(manifest.fileId, await handle.createWritable());
      } else {
        const blob = await storage.readBlob(manifest.fileId); // 16 MiB cap; larger files need a streaming destination.
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = manifest.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { setError(error.message); }
  }
  const p = storage.progress;
  return <section><h2>Encrypted files</h2><input aria-label="Upload file" type="file" onChange={upload} disabled={busy}/>
    <p data-testid="storage-status">{storage.status}{p && ` · ${p.completedChunks}/${p.totalChunks} chunks`}</p>
    <progress aria-label="File progress" max={p?.totalChunks || 1} value={p?.completedChunks || 0}/>
    {busy && <button onClick={storage.cancel}>Cancel transfer</button>}
    <ul data-testid="files">{files.map(item => <FileRow key={item.id} item={item} client={client} save={save} busy={busy}/>)}</ul>
    {(error || storage.error) && <p role="alert">{error || storage.error.message}</p>}
  </section>;
}
