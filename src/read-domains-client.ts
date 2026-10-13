import { LocalCoreClient, type LocalCoreClientOptions } from "./client.js";
import { AuthorizationError, verifyCertificate, verifyDescriptor } from "./certificates.js";
import { normalizeActorId } from "./crypto-codec.js";
import { normalizeInvitation, verifyInvitationSignature } from "./project-crypto.js";
import { normalizeReadDomainDefinition, normalizeReadDomainSpace, resolveReadDomain, sameReadDomainValue } from "./read-domains.js";
import { P2PWebRTC, type P2PWebRTCOptions } from "./p2p-webrtc.js";
import { filePrefix, type UploadOptions } from "./storage-format.js";
import type { CommitNotification, EventDecision, IdentityCredentials, ItemCommand, ItemView, ProjectInvitation,
  ReadDomainDefinition, ReadDomainEntry, ReadDomainSpace, Role, Snapshot } from "./types.js";

export interface ReadDomainsInvitation { readonly version: 1; readonly invitations: readonly ProjectInvitation[] }
export interface ReadDomainsTrust {
  readonly rootActorId: string; readonly spaceId: string;
  /** Optional trusted completeness requirement; individual grants may cover a subset. */
  readonly requiredDomainIds?: readonly string[];
}
export interface ReadDomainsSnapshot {
  readonly items: readonly ItemView[];
  readonly decisions: readonly (EventDecision & { readonly domainId: string })[];
  readonly domains: readonly { readonly domainId: string; readonly snapshot: Snapshot }[];
  readonly unavailableDomains: readonly string[];
}
export class ReadDomainInitializationError extends Error {
  constructor(readonly createdDatabases: readonly string[], readonly attemptedDatabases: readonly string[], cause: unknown) {
    super("Read-domain initialization failed; attempted databases may contain durable partial initialization", { cause }); this.name = "ReadDomainInitializationError";
  }
}
export class ReadDomainOperationError extends Error {
  constructor(readonly operation: "invite" | "revoke", readonly completedDomainIds: readonly string[], readonly failedDomainId: string, cause: unknown) {
    super(`Read-domain ${operation} failed; completed domains remain committed`, { cause }); this.name = "ReadDomainOperationError";
  }
}
function prefix(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(value)) throw new TypeError("Database prefix must be 1–48 ASCII identifier characters");
  return value;
}
function databaseName(base: string, index: number): string { return `${base}_domain_${index}`; }

/** Preflight the complete signed map and recipient role before creating any Worker. */
export async function verifyReadDomainsInvitation(value: unknown, trust: ReadDomainsTrust): Promise<ReadDomainsInvitation> {
  normalizeActorId(trust.rootActorId);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).sort().join(",") !== "invitations,version") throw new TypeError("Invalid read-domain invitation bundle");
  const bundle = value as ReadDomainsInvitation;
  if (bundle.version !== 1 || !Array.isArray(bundle.invitations) || !bundle.invitations.length || bundle.invitations.length > 16) throw new TypeError("Invalid domain invitation bounds");
  const invitations = bundle.invitations.map(normalizeInvitation);
  const first = invitations[0]!, config = first.descriptor.readDomain;
  if (!config || config.space.spaceId !== trust.spaceId) throw new AuthorizationError("Read-space identity mismatch");
  const ids = new Set<string>();
  for (const invitation of invitations) {
    const descriptor = await verifyDescriptor(invitation.descriptor);
    await verifyCertificate(invitation.certificate, descriptor); await verifyInvitationSignature(invitation);
    if (!descriptor.readDomain || descriptor.rootActorId !== trust.rootActorId || !sameReadDomainValue(descriptor.readDomain.space, config.space) ||
        invitation.certificate.subject !== first.certificate.subject || invitation.certificate.role !== first.certificate.role ||
        ids.has(descriptor.readDomain.domainId)) throw new AuthorizationError("Conflicting root, routing map, recipient, role or domain");
    ids.add(descriptor.readDomain.domainId);
  }
  if (trust.requiredDomainIds && (!Array.isArray(trust.requiredDomainIds) || trust.requiredDomainIds.length > 16 ||
      new Set(trust.requiredDomainIds).size !== trust.requiredDomainIds.length || trust.requiredDomainIds.some(id => !ids.has(id)))) throw new AuthorizationError("Invitation omits a required domain");
  return Object.freeze({ version: 1, invitations: Object.freeze(invitations) });
}

/** Logical namespace over independent project logs, keys, checkpoints and swarms.
 * Authorization lives in each core; routing is convenience, never a secrecy filter.
 */
export class ReadDomainsClient {
  private closing = false;
  private closed: Promise<void> | undefined;
  private connecting = false;
  private readonly resources = new Set<() => void>();
  private readonly syncs = new Map<string, P2PWebRTC>();
  private readonly listeners = new Set<(notification: CommitNotification & { readonly domainId: string }) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private constructor(readonly space: ReadDomainSpace, readonly rootActorId: string,
    private readonly clients: ReadonlyMap<string, LocalCoreClient>, readonly bootstrap: ReadDomainsInvitation) {
    for (const [domainId, client] of clients) this.unsubscribe.push(client.onCommit(notification => {
      const scoped = Object.freeze({ ...notification, domainId });
      for (const listener of this.listeners) { try { listener(scoped); } catch { /* Isolate observers. */ } }
    }));
  }
  static async create(databasePrefix: string, credentials: IdentityCredentials, definitions: readonly ReadDomainDefinition[], options: LocalCoreClientOptions = {}): Promise<ReadDomainsClient> {
    prefix(databasePrefix);
    if (!Array.isArray(definitions)) throw new TypeError("Read-domain definitions required");
    const space = normalizeReadDomainSpace({ version: 1, spaceId: `space_${crypto.randomUUID()}`,
      domains: definitions.map(d => ({ ...normalizeReadDomainDefinition(d), projectId: `domain_${crypto.randomUUID()}` })) });
    const clients = new Map<string, LocalCoreClient>(), invitations: ProjectInvitation[] = [], created: string[] = [], attempted: string[] = [];
    try {
      for (const [index, domain] of space.domains.entries()) {
        const client = new LocalCoreClient(options); clients.set(domain.id, client);
        attempted.push(databaseName(databasePrefix, index));
        await client.createProject(databaseName(databasePrefix, index), { ...credentials, projectId: domain.projectId,
          policies: domain.policies, readDomain: { domainId: domain.id, space } });
        created.push(databaseName(databasePrefix, index));
        // The root's self-invitation is already durable and recipient-encrypted.
        // Export through the Worker rather than exposing private or AES key handles.
        invitations.push(await client.getBootstrapInvitation());
      }
      const root = invitations[0]!.descriptor.rootActorId;
      const bootstrap = await verifyReadDomainsInvitation({ version: 1, invitations }, { rootActorId: root, spaceId: space.spaceId });
      return new ReadDomainsClient(space, root, clients, bootstrap);
    } catch (error) {
      await Promise.allSettled([...clients.values()].map(c => c.close()));
      throw new ReadDomainInitializationError(Object.freeze(created), Object.freeze(attempted), error);
    }
  }
  static async open(databasePrefix: string, credentials: IdentityCredentials, invitation: ReadDomainsInvitation,
    trust: ReadDomainsTrust, options: LocalCoreClientOptions = {}): Promise<ReadDomainsClient> {
    prefix(databasePrefix);
    const bootstrap = await verifyReadDomainsInvitation(invitation, trust);
    const space = bootstrap.invitations[0]!.descriptor.readDomain!.space;
    const clients = new Map<string, LocalCoreClient>();
    try {
      for (const invitation of bootstrap.invitations) {
        const id = invitation.descriptor.readDomain!.domainId, index = space.domains.findIndex(d => d.id === id);
        const client = new LocalCoreClient(options); clients.set(id, client);
        await client.open(databaseName(databasePrefix, index), { ...credentials, projectId: invitation.descriptor.projectId,
          invitation, readDomain: invitation.descriptor.readDomain! });
      }
      return new ReadDomainsClient(space, trust.rootActorId, clients, bootstrap);
    } catch (error) { await Promise.allSettled([...clients.values()].map(c => c.close())); throw error; }
  }
  /** Authorized per-domain handle for existing core query and P2P APIs. */
  domain(id: string): LocalCoreClient {
    this.requireOpen();
    const client = this.clients.get(id);
    if (!client) throw new AuthorizationError("No read access to this domain");
    return client;
  }
  route(itemId: string): ReadDomainEntry { return resolveReadDomain(this.space, itemId); }
  get network() { return Object.freeze([...this.syncs].map(([domainId, sync]) => Object.freeze({ domainId, state: sync.state, peers: sync.peers, stats: sync.stats }))); }
  dispatch(command: ItemCommand) {
    const domain = this.route(command.itemId);
    return this.domain(domain.id).dispatch(command).then(result => ({ domainId: domain.id, ...result }));
  }
  async inviteMember(actorId: string, role: Role = "Member", domainIds?: readonly string[]): Promise<ReadDomainsInvitation> {
    this.requireOpen(); normalizeActorId(actorId);
    if (domainIds && (!Array.isArray(domainIds) || !domainIds.length || new Set(domainIds).size !== domainIds.length ||
        domainIds.some(id => !this.space.domains.some(d => d.id === id && d.readRoles.includes(role))))) throw new AuthorizationError("Unknown, duplicate or role-forbidden domain grant");
    const entitled = this.space.domains.filter(d => d.readRoles.includes(role) && (!domainIds || domainIds.includes(d.id)));
    if (!entitled.length) throw new AuthorizationError("Role has no read domains");
    // Check local authority for every destination before starting durable invitations.
    for (const domain of entitled) if ((await this.domain(domain.id).getProjectInfo()).certificate.role !== "Admin") throw new AuthorizationError("Only domain Admins can invite");
    const invitations: ProjectInvitation[] = [];
    const completed: string[] = [];
    for (const domain of entitled) {
      try { invitations.push((await this.domain(domain.id).inviteMember(actorId, role)).invitation); completed.push(domain.id); }
      catch (error) { throw new ReadDomainOperationError("invite", Object.freeze([...completed]), domain.id, error); }
    }
    return verifyReadDomainsInvitation({ version: 1, invitations }, { rootActorId: this.rootActorId, spaceId: this.space.spaceId });
  }
  /** Revoke/rotate independently in every opened domain where this actor is known. */
  async revokeMember(actorId: string, options: import("./types.js").RevokeOptions = {}): Promise<readonly (import("./types.js").RevokeResult & { readonly domainId: string })[]> {
    this.requireOpen(); normalizeActorId(actorId);
    if (actorId === this.rootActorId) throw new AuthorizationError("Cannot revoke the root");
    const targets: string[] = [];
    for (const [id, client] of this.clients) {
      if ((await client.getProjectInfo()).certificate.subject !== this.rootActorId) throw new AuthorizationError("Only root can revoke read-domain membership");
      if (await client.getMemberCertificate(actorId)) targets.push(id);
    }
    if (!targets.length) throw new AuthorizationError("Unknown actor in opened read domains");
    const results = [];
    for (const id of targets) {
      try { results.push(Object.freeze({ domainId: id, ...await this.domain(id).revokeMember(actorId, options) })); }
      catch (error) { throw new ReadDomainOperationError("revoke", Object.freeze(results.map(r => r.domainId)), id, error); }
    }
    return Object.freeze(results);
  }
  async snapshot(): Promise<ReadDomainsSnapshot> {
    this.requireOpen();
    const domains = await Promise.all([...this.clients].map(async ([domainId, client]) => Object.freeze({ domainId, snapshot: await client.snapshot() })));
    return Object.freeze({ domains: Object.freeze(domains), items: Object.freeze(domains.flatMap(d => d.snapshot.items).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      decisions: Object.freeze(domains.flatMap(d => (d.snapshot.decisions ?? []).map(decision => Object.freeze({ ...decision, domainId: d.domainId })))),
      unavailableDomains: Object.freeze(this.space.domains.filter(d => !this.clients.has(d.id)).map(d => d.id)) });
  }
  uploadFile(domainId: string, blob: Blob, options: UploadOptions = {}) {
    const domain = this.space.domains.find(d => d.id === domainId);
    if (!domain) throw new AuthorizationError("Unknown file domain");
    const selectedPrefix = filePrefix(options.filePrefix ?? domain.prefixes.find(p => p.startsWith("file_") && p.endsWith("_")));
    if (this.route(`${selectedPrefix}00000000-0000-0000-0000-000000000000`).id !== domainId) throw new AuthorizationError("File prefix routes to a different domain");
    return this.domain(domainId).storage.upload(blob, { ...options, filePrefix: selectedPrefix });
  }
  readFileStream(fileId: string, options?: import("./storage-format.js").StorageReadOptions) { return this.domain(this.route(fileId).id).storage.readStream(fileId, options); }
  readFileBlob(fileId: string, options?: import("./storage-format.js").StorageReadOptions) { return this.domain(this.route(fileId).id).storage.readBlob(fileId, options); }
  onCommit(listener: (notification: CommitNotification & { readonly domainId: string }) => void): () => void {
    this.requireOpen(); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  /** Each entitled domain joins only its own key-protected swarm. */
  async connect(options: (domain: ReadDomainEntry) => P2PWebRTCOptions): Promise<void> {
    this.requireOpen();
    if (this.connecting || this.resources.size) throw new Error("Read-domain networking is already started");
    this.connecting = true; const created: (() => void)[] = [];
    try {
      for (const [id, client] of this.clients) {
        this.requireOpen();
        const domain = this.space.domains.find(d => d.id === id)!;
        const sync = new P2PWebRTC(client, options(domain)), remove = client.storage.addPeer(sync);
        let disposed = false;
        const cleanup = () => { if (disposed) return; disposed = true; remove(); sync.stop(); this.resources.delete(cleanup); this.syncs.delete(id); };
        this.resources.add(cleanup); this.syncs.set(id, sync); created.push(cleanup); await sync.start();
      }
      this.requireOpen();
    } catch (error) { for (const cleanup of created) cleanup(); throw error; }
    finally { this.connecting = false; }
  }
  disconnect(): void { for (const cleanup of [...this.resources]) cleanup(); }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true; this.disconnect(); for (const remove of this.unsubscribe) remove(); this.listeners.clear();
    return this.closed = Promise.allSettled([...this.clients.values()].map(c => c.close())).then(results => {
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, "Some read-domain clients failed to close");
    });
  }
  private requireOpen(): void { if (this.closing) throw new Error("Read-domain client is closing"); }
}
