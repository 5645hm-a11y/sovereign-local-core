import { LocalCoreClient, EpochIncompleteError, type StorageProgress } from "sovereign-local-core";
import { ProjectProvider, useProject, useLiveQuery, useStorage, usePagedQuery } from "sovereign-local-core/react";
import { P2PWebRTC, SyncSession, DiscoveryRecovery, libraryPolicies, type ByteLink, type IDiscoveryProvider, type IdentityCredentials } from "sovereign-local-core";
import { NostrDiscovery, type DiscoveryRoutingOptions } from "sovereign-local-core/nostr";
import { ReadDomainsClient, verifyReadDomainsInvitation, type ReadDomainsInvitation, type ReadDomainsTrust, type ReadDomainDefinition } from "sovereign-local-core";
async function checkGenericReadDomains(credentials: IdentityCredentials, definitions: ReadDomainDefinition[], invitation: ReadDomainsInvitation, trust: ReadDomainsTrust) {
  await verifyReadDomainsInvitation(invitation, trust);
  const db = await ReadDomainsClient.create("typed_domains", credentials, definitions);
  try {
    const bundle: ReadDomainsInvitation = await db.inviteMember("typed-actor", "Member");
    void bundle; void db.bootstrap; void db.network;
    await db.dispatch({ type: "ITEM_ADDED", itemId: "record_1", fields: { text: "Generic data" } });
    void db.revokeMember("typed-actor", { paged: true }).then(results => results.map(r => r.pageCount));
    const snapshot = await db.snapshot(); snapshot.unavailableDomains.map(id => id);
    await db.uploadFile("private", new Blob(["internal"]), { filePrefix: "file_private_" });
    await db.readFileStream("file_00000000-0000-0000-0000-000000000000");
  } finally { await db.close(); }
}
void checkGenericReadDomains;
function checkDiscovery(client: LocalCoreClient, link: ByteLink, turn: RTCIceServer) {
  const routing: DiscoveryRoutingOptions = { bucketCount: 64, sampleBuckets: 3, rotationIntervalMs: 3000 };
  const discovery: IDiscoveryProvider = new NostrDiscovery({ routing });
  const recoveryDiscovery = new NostrDiscovery({ routing: { bucketCount: 64, sampleBuckets: 3 } });
  const recovery = new DiscoveryRecovery(client, { discovery: recoveryDiscovery, intervalMs: 30000 });
  void recovery.stats.completed;
  const sync = new P2PWebRTC(client, { discovery, recovery: { discovery: recoveryDiscovery, onRecovered: keyId => console.log(keyId) },
    iceServers: [turn], iceTransportPolicy: "relay", maxPeers: 8,
    topology: "rotating", maxCandidates: 256, candidateTtlMs: 120000,
    rotationIntervalMs: 30000, minPeerLifetimeMs: 30000, rotationIdleMs: 5000 });
  const neighborDiagnostics: readonly number[] = [sync.candidateCount, sync.topologyStats.rotations];
  void neighborDiagnostics;
  const credentials: IdentityCredentials = { mode: "wallet", walletId: "typed-wallet", passphrase: "synthetic-type-passphrase" };
  void client.createProject("typed-library", { ...credentials, projectId: "typed-project", policies: libraryPolicies() });
  void client.inviteMember("typed-actor", "Kiosk");
  void client.revokeMember("typed-actor", { paged: true }).then(result => result.pageCount).catch(error => {
    if (error instanceof EpochIncompleteError) console.log(error.name);
  });
  void client.getProjectInfo().then(info => info.pendingEpochs.map(p => p.missingKeyPages));
  void client.getDiscoveryRecoveryInfo().then(info => info.topic);
  void client.getDiscoveryRecoveryInfo().then(info => info.instanceId);
  void client.createRoutedDiscoveryRecoveryRequest().then(packet => client.handleRoutedDiscoveryRecoveryRequest(packet)).then(reply => reply?.recipient);
  void client.isDiscoveryPeerAuthorized("typed-actor");
  void client.dispatch({ type: "CHECKOUT", itemId: "book_1", fields: { borrowerId: "reader_1" } });
  void client.snapshot().then(s => s.decisions?.map(d => d.status));
  void client.openCompact("typed-db", { ...credentials, projectId: "typed-project" }).then(opened => opened.recovery.eventCount);
  void client.createProjectCompact("typed-new-db", { ...credentials, projectId: "typed-new-project" });
  void client.dispatchCommitted({ type: "ITEM_UPDATED", itemId: "record_1", fields: { updated: true } }).then(receipt => receipt.revision);
  void client.ingestCommitted([]).then(receipt => receipt.applied);
  void client.openQueryCursor({ kind: "items", prefix: "record_", limit: 32, maxBytes: 16384 }).then(async cursor => {
    const page = await client.readQueryCursor(cursor.id); void page.items; void page.revision;
    await client.closeQueryCursor(cursor.id);
  });
  void sync.peers.map(p => p.actorId);
  const session = new SyncSession(client);
  void client.getSyncSummary().then(summary => client.readMissingEventsPaged(summary));
  void client.openSyncCursor({}).then(async cursor => {
    if (cursor) { await client.readSyncCursor(cursor.id); await client.closeSyncCursor(cursor.id); }
  });
  session.connect(link);
  const removePeer = client.storage.addPeer(sync);
  removePeer(); sync.stop(); session.stop();
}
void checkDiscovery;
function Consumer() {
  const project = useProject("typed_project", { email: "type@example.test", password: "type-check-password" });
  const query = useLiveQuery(s => s.items.map(i => i.id), { project });
  const paged = usePagedQuery({ kind: "items", prefix: "record_", limit: 64, maxBytes: 32768 }, { project, refreshDelayMs: 25 });
  void paged.page?.items; void paged.pageIndex; void paged.canNext; void paged.next; void paged.refresh;
  const filtered = usePagedQuery({ kind: "items", prefix: "record_", where: [{ field: "status", op: "eq", value: "open" }], orderBy: { field: "priority", direction: "desc" } }, { project }); void filtered.page?.items;
  void project.client?.openQueryCursor({ kind: "items", index: "scan", where: [{ field: "priority", op: "gte", value: 3 }] });
  const outcomes = usePagedQuery({ kind: "decisions", limit: 32 }, { project }); void outcomes.page?.decisions;
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
