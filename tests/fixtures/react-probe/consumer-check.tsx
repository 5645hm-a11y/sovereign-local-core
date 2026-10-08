import { LocalCoreClient, type StorageProgress } from "sovereign-local-core";
import { ProjectProvider, useProject, useLiveQuery, useStorage } from "sovereign-local-core/react";
function Consumer() {
  const project = useProject("typed_project", { email: "type@example.test", password: "type-check-password" });
  const query = useLiveQuery(s => s.items.map(i => i.id), { project });
  const storage = useStorage(project);
  const upload = (file: File) => storage.upload(file, { onProgress: (p: StorageProgress) => console.log(p.completedChunks) });
  const client: LocalCoreClient | null = project.client;
  return <ProjectProvider project={project}><button disabled={!client} onClick={() => void upload(new File([], "empty"))}>{query.data?.join(",")}</button></ProjectProvider>;
}
void Consumer;
