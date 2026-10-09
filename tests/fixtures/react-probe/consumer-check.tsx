import { LocalCoreClient, type StorageProgress } from "sovereign-local-core";
import { ProjectProvider, useProject, useLiveQuery, useStorage } from "sovereign-local-core/react";
import { P2PWebRTC, SyncSession, libraryPolicies, type ByteLink, type IDiscoveryProvider, type IdentityCredentials } from "sovereign-local-core";
import { NostrDiscovery } from "sovereign-local-core/nostr";
function checkDiscovery(client: LocalCoreClient, link: ByteLink, turn: RTCIceServer) {
  const discovery: IDiscoveryProvider = new NostrDiscovery();
  const sync = new P2PWebRTC(client, { discovery, iceServers: [turn], iceTransportPolicy: "relay", maxPeers: 8 });
  const credentials: IdentityCredentials = { mode: "wallet", walletId: "typed-wallet", passphrase: "synthetic-type-passphrase" };
  void client.createProject("typed-library", { ...credentials, projectId: "typed-project", policies: libraryPolicies() });
  void client.inviteMember("typed-actor", "Kiosk");
  void client.dispatch({ type: "CHECKOUT", itemId: "book_1", fields: { borrowerId: "reader_1" } });
  void client.snapshot().then(s => s.decisions?.map(d => d.status));
  void sync.peers.map(p => p.actorId);
  const session = new SyncSession(client);
  session.connect(link);
  const removePeer = client.storage.addPeer(sync);
  removePeer(); sync.stop(); session.stop();
}
void checkDiscovery;
function Consumer() {
  const project = useProject("typed_project", { email: "type@example.test", password: "type-check-password" });
  const query = useLiveQuery(s => s.items.map(i => i.id), { project });
  const storage = useStorage(project);
  const upload = (file: File) => storage.upload(file, { onProgress: (p: StorageProgress) => console.log(p.completedChunks) });
  const client: LocalCoreClient | null = project.client;
  return <ProjectProvider project={project}><button disabled={!client} onClick={() => void upload(new File([], "empty"))}>{query.data?.join(",")}</button></ProjectProvider>;
}
void Consumer;
function WalletConsumer() {
  const project = useProject("typed-library", { mode: "wallet", walletId: "typed-wallet", passphrase: "synthetic-type-passphrase" });
  return <p>{project.status}</p>;
}
void WalletConsumer;
