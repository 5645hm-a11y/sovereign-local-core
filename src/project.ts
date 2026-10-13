import { AuthorizationError, EpochIncompleteError, certificateActors, certificateText, issueCertificate, sameDescriptor, signDescriptor, verifyCertificate, verifyDescriptor } from "./certificates.js";
import { toBase64Url, fromBase64Url, normalizeProjectId } from "./crypto-codec.js";
import { encodeBinary } from "./binary-codec.js";
import { requireValidEvent, type UnlockedIdentity } from "./identity.js";
import { decryptFields, decryptCommand, fieldsAAD, generateProjectKey, normalizeInvitation, signInvitation, verifyInvitationSignature, unwrapProjectKey, wrapProjectKey, type ProjectKey } from "./project-crypto.js";
import { eventText, canonicalEventBytes, legacyEventText, normalizeCommand } from "./validation.js";
import type { Certificate, IEvent, ItemCommand, KeyEnvelope, HistoryWitness, PendingEpoch, ProjectDescriptor, ProjectInvitation, ReadDomainConfig, ReducerPolicies, Role } from "./types.js";
import { emptyEpochRoot, epochPageCount, sameEpochCommitment, verifyEpochPage } from "./epoch-pages.js";
import { normalizePolicies } from "./policies.js";
import { isDataType } from "./types.js";
import { normalizeReadDomainConfig, readDomainEntry, resolveReadDomain } from "./read-domains.js";

export type PlainItemEvent = ItemCommand & { readonly id: string; readonly actorId: string; readonly sequence: number; readonly lamport: number };
export interface ProjectEvaluation {
  readonly items: readonly PlainItemEvent[];
  readonly blocks: readonly Uint8Array<ArrayBuffer>[];
  readonly roles: readonly Role[];
  readonly eligible: ReadonlySet<string>;
  readonly keys: ReadonlyMap<string, ProjectKey>;
  readonly currentKeyId: string;
  readonly certificates: ReadonlyMap<string, Certificate>;
  readonly revocations: readonly IEvent[];
  readonly governance: readonly IEvent[];
  readonly epochs: ReadonlyMap<string, { readonly envelopes: readonly KeyEnvelope[]; readonly history: ReadonlyMap<string, string> }>;
  readonly pendingEpochs: readonly PendingEpoch[];
}
export async function payloadDigest(event: IEvent): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", canonicalEventBytes((({ signature: _, ...unsigned }) => unsigned)(event))));
}
async function matchesPayloadDigest(event: IEvent, expected: string): Promise<boolean> {
  if (await payloadDigest(event) === expected) return true;
  const { signature: _, ...unsigned } = event;
  return toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacyEventText(unsigned)))) === expected;
}
export class ProjectContext {
  private readonly certificateCache = new Map<string, Promise<Certificate>>();
  private cacheKey: Promise<CryptoKey> | undefined;
  private constructor(readonly invitation: ProjectInvitation, readonly identity: UnlockedIdentity,
    private readonly initialKeys: Map<string, ProjectKey>) {}
  get descriptor(): ProjectDescriptor { return this.invitation.descriptor; }
  get certificate(): Certificate { return this.invitation.certificate; }

  static async create(identity: UnlockedIdentity, projectId: string, policies?: ReducerPolicies, domain?: ReadDomainConfig): Promise<ProjectContext> {
    normalizeProjectId(projectId);
    const readDomain = domain === undefined ? undefined : normalizeReadDomainConfig(domain);
    if (readDomain && !policies) throw new TypeError("Read domains require explicit write policies");
    const pinnedPolicies = policies === undefined ? undefined : normalizePolicies(policies);
    const key = await generateProjectKey();
    const rootCertificate = await issueCertificate(identity, projectId, identity.actorId, "Admin", 0, null);
    const descriptor = await signDescriptor({ version: readDomain ? 3 : pinnedPolicies ? 2 : 1, ...(pinnedPolicies ? { policies: pinnedPolicies } : {}), ...(readDomain ? { readDomain } : {}), projectId, rootActorId: identity.actorId,
      genesisKeyId: key.id, rootCertificate, signature: "A".repeat(86) }, identity);
    const invitation = await signInvitation({ version: 1, descriptor, certificate: rootCertificate,
      keys: [await wrapProjectKey(key, projectId, identity.actorId)], currentKeyId: key.id, signature: "A".repeat(86) }, identity);
    return new ProjectContext(invitation, identity, new Map([[key.id, key]]));
  }
  static async open(value: unknown, identity: UnlockedIdentity, expectedProject: string): Promise<ProjectContext> {
    const invitation = normalizeInvitation(value), descriptor = await verifyDescriptor(invitation.descriptor);
    if (descriptor.projectId !== expectedProject) throw new AuthorizationError("Invitation project mismatch");
    const certificate = await verifyCertificate(invitation.certificate, descriptor);
    await verifyInvitationSignature(invitation);
    if (certificate.subject !== identity.actorId) throw new AuthorizationError("Invitation belongs to another actor");
    const keys = new Map<string, ProjectKey>();
    for (const envelope of invitation.keys) {
      const key = await unwrapProjectKey(envelope, expectedProject, identity);
      if (keys.has(key.id)) { key.bytes.fill(0); throw new TypeError("Duplicate invitation key"); }
      keys.set(key.id, key);
    }
    if (!keys.has(descriptor.genesisKeyId)) throw new AuthorizationError("Invitation omits genesis key");
    return new ProjectContext(invitation, identity, keys);
  }
  private verified(certificate: Certificate): Promise<Certificate> {
    const text = certificateText(certificate) + certificate.signature;
    let result = this.certificateCache.get(text);
    if (!result) {
      if (this.certificateCache.size >= 256) this.certificateCache.delete(this.certificateCache.keys().next().value!);
      result = verifyCertificate(certificate, this.descriptor);
      this.certificateCache.set(text, result);
    }
    return result;
  }
  async verifyEvent(value: IEvent): Promise<void> {
    await this.authenticateEvent(value);
  }
  /** Authenticates a copied, immutable envelope; business admission is a separate check. */
  async authenticateEvent(value: IEvent): Promise<IEvent> {
    const e = await requireValidEvent(value, this.descriptor.projectId), c = await this.verified(e.certificate);
    if (c.subject !== e.actorId || e.lamport < c.issuedLamport) throw new AuthorizationError("Event certificate mismatch");
    if (isDataType(e.type) && "itemId" in e) this.assertItemDomain(e.itemId);
    if (e.type === "KEY_EPOCH_PAGE") await this.verifyPageEvent(e);
    return e;
  }
  private async verifyPageEvent(e: Extract<IEvent, { type: "KEY_EPOCH_PAGE" }>): Promise<void> {
    const p = e.epochPage;
    if (e.actorId !== this.descriptor.rootActorId || e.certificate.role !== "Admin" || p.targetActorId === this.descriptor.rootActorId)
      throw new AuthorizationError("Only pinned root may prepare an epoch manifest");
    await verifyEpochPage(this.descriptor.projectId, p);
  }
  assertItemDomain(itemId: string): void {
    const domain = this.descriptor.readDomain;
    if (domain && resolveReadDomain(domain.space, itemId).id !== domain.domainId) throw new AuthorizationError("Item belongs to a different read domain");
  }
  /** Shared admission rule for replay, item deltas and authenticated cursor exports. */
  async isEventEligible(event: IEvent, revocations: readonly IEvent[], epochs: ProjectEvaluation["epochs"] = new Map()): Promise<boolean> {
    for (const rev of revocations) if (rev.type === "MEMBER_REVOKED" && certificateActors(event.certificate).includes(rev.revocation.targetActorId)) {
      const digest = rev.revocation.epoch ? epochs.get(rev.id)?.history.get(event.id) : rev.revocation.allowedHistory.find(entry => entry.id === event.id)?.digest;
      if (event.lamport > rev.lamport || !digest || !await matchesPayloadDigest(event, digest)) return false;
    }
    return true;
  }
  async evaluate(input: readonly IEvent[], binary = false, rememberedCertificates: readonly Certificate[] = []): Promise<ProjectEvaluation> {
    const events: IEvent[] = [];
    const certificates = new Map<string, Certificate>([[this.descriptor.rootActorId, this.descriptor.rootCertificate], [this.certificate.subject, this.certificate]]);
    const remember = (c: Certificate) => {
      const previous = certificates.get(c.subject);
      if (!previous || c.issuedLamport > previous.issuedLamport || (c.issuedLamport === previous.issuedLamport && certificateText(c) > certificateText(previous))) certificates.set(c.subject, c);
    };
    for (const c of rememberedCertificates) remember(await this.verified(c));
    // Verify the whole history first; arrival order cannot confer authority.
    for (const value of input) {
      const e = await requireValidEvent(value, this.descriptor.projectId);
      const c = await this.verified(e.certificate);
      if (c.subject !== e.actorId || e.lamport < c.issuedLamport) throw new AuthorizationError("Event certificate/actor or issuance clock mismatch");
      if (isDataType(e.type) && "itemId" in e) this.assertItemDomain(e.itemId);
      if (e.type === "KEY_EPOCH_PAGE") await this.verifyPageEvent(e);
      remember(c);
      if (e.type === "MEMBER_INVITED") {
        const i = e.invitation, invited = await this.verified(i.certificate);
        await verifyInvitationSignature(i);
        if (c.role !== "Admin" || invited.subject === this.descriptor.rootActorId || !sameDescriptor(i.descriptor, this.descriptor) || invited.issuer !== e.actorId ||
            invited.issuedLamport !== e.lamport || !invited.parent || certificateText(invited.parent) !== certificateText(c) || invited.parent.signature !== c.signature ||
            i.keys.some(k => k.recipient !== invited.subject) || !i.keys.some(k => k.keyId === this.descriptor.genesisKeyId)) {
          throw new AuthorizationError("Invalid administrative invitation");
        }
        remember(invited);
      }
      if (e.type === "MEMBER_REVOKED") {
        if (e.actorId !== this.descriptor.rootActorId || c.role !== "Admin" || e.revocation.targetActorId === this.descriptor.rootActorId ||
            e.revocation.envelopes.some(k => k.keyId !== e.revocation.keyId || k.recipient === e.revocation.targetActorId) ||
            new Set(e.revocation.envelopes.map(k => k.recipient)).size !== e.revocation.envelopes.length ||
            (!e.revocation.epoch && !e.revocation.envelopes.some(k => k.recipient === this.descriptor.rootActorId))) throw new AuthorizationError("Only pinned root may revoke/rotate; invalid recipients");
      }
      events.push(e);
    }
    const revocations = events.filter(e => e.type === "MEMBER_REVOKED").sort((a, b) => a.lamport - b.lamport || a.sequence - b.sequence);
    const { epochs, pendingEpochs } = await this.resolveEpochs(events, revocations, certificates);
    const ids = new Set(this.initialKeys.keys());
    const rotationIds = new Set([this.descriptor.genesisKeyId]);
    const revokedActors = new Set<string>();
    for (const e of revocations) if (e.type === "MEMBER_REVOKED") {
      if (rotationIds.has(e.revocation.keyId)) throw new AuthorizationError("Rotation must use a fresh key");
      rotationIds.add(e.revocation.keyId);
      ids.add(e.revocation.keyId);
      revokedActors.add(e.revocation.targetActorId);
      for (const envelope of e.revocation.epoch ? epochs.get(e.id)?.envelopes ?? [] : e.revocation.envelopes) {
        const c = certificates.get(envelope.recipient);
        if (c && certificateActors(c).some(actor => revokedActors.has(actor))) throw new AuthorizationError("Rotation leaks key to revoked delegation");
      }
    }
    const eligible = new Set<string>();
    for (const e of events) {
      if (await this.isEventEligible(e, revocations, epochs)) eligible.add(e.id);
    }
    const keys = new Map(this.initialKeys);
    for (const pending of pendingEpochs) keys.delete(pending.keyId);
    const absorb = async (envelopes: ProjectInvitation["keys"]) => {
        for (const envelope of envelopes) if (envelope.recipient === this.identity.actorId && !keys.has(envelope.keyId) &&
            !pendingEpochs.some(p => p.keyId === envelope.keyId)) {
        keys.set(envelope.keyId, await unwrapProjectKey(envelope, this.descriptor.projectId, this.identity));
      }
    };
    for (const e of events) if (eligible.has(e.id)) {
      if (e.type === "MEMBER_INVITED") await absorb(e.invitation.keys);
      if (e.type === "MEMBER_REVOKED") await absorb(e.revocation.epoch ? epochs.get(e.id)?.envelopes ?? [] : e.revocation.envelopes);
    }
    const items: PlainItemEvent[] = [], blocks: Uint8Array<ArrayBuffer>[] = [], roles: Role[] = [];
    for (const e of events) if (eligible.has(e.id) && e.type !== "MEMBER_INVITED" && e.type !== "MEMBER_REVOKED" && e.type !== "KEY_EPOCH_PAGE") {
      if (!ids.has(e.keyId)) throw new AuthorizationError("Unknown project key epoch");
        if (pendingEpochs.some(p => p.keyId === e.keyId)) throw new EpochIncompleteError();
      const key = keys.get(e.keyId);
      if (!key) { if (pendingEpochs.some(p => p.keyId === e.keyId)) throw new EpochIncompleteError(); throw new AuthorizationError("This identity has no decryption key for the event epoch"); }
      if (binary) {
        blocks.push(await decryptCommand(e.encryptedFields, fieldsAAD(e, e.type, e.itemId, e.keyId), key));
        roles.push(e.certificate.role);
      } else {
        const fields = await decryptFields(e.encryptedFields, fieldsAAD(e, e.type, e.itemId, e.keyId), key);
        const command = normalizeCommand(e.type === "ITEM_DELETED" ? { type: e.type, itemId: e.itemId } : { type: e.type, itemId: e.itemId, fields });
        if (e.type === "ITEM_DELETED" && Object.keys(fields).length) throw new TypeError("Deleted item must have empty encrypted fields");
        items.push(Object.freeze({ ...command, id: e.id, actorId: e.actorId, sequence: e.sequence, lamport: e.lamport }));
      }
    }
    const last = revocations.at(-1);
    return { items, blocks, roles, eligible, keys, certificates, revocations, epochs, pendingEpochs, governance: events.filter(e => !isDataType(e.type)),
      currentKeyId: last?.type === "MEMBER_REVOKED" && last.lamport >= this.certificate.issuedLamport ? last.revocation.keyId : this.invitation.currentKeyId };
  }
  evaluateBinary(input: readonly IEvent[]): Promise<ProjectEvaluation> { return this.evaluate(input, true); }
  private async resolveEpochs(events: readonly IEvent[], revocations: readonly IEvent[], certificates: ReadonlyMap<string, Certificate>) {
    const groups = new Map<string, Map<string, Extract<IEvent, { type: "KEY_EPOCH_PAGE" }>>>();
    for (const e of events) if (e.type === "KEY_EPOCH_PAGE") {
      const group = groups.get(e.epochPage.epochId) ?? new Map();
      const slot = `${e.epochPage.kind}:${e.epochPage.index}`, previous = group.get(slot);
      if (previous && previous.id !== e.id) throw new AuthorizationError("Duplicate epoch page slot");
      group.set(slot, e); groups.set(e.epochPage.epochId, group);
    }
    const manifests = new Map<string, IEvent>();
    for (const rev of revocations) if (rev.type === "MEMBER_REVOKED" && rev.revocation.epoch) {
      if (manifests.has(rev.revocation.epoch.id)) throw new AuthorizationError("Epoch ID reused by multiple manifests");
      manifests.set(rev.revocation.epoch.id, rev);
    }
    if ([...groups.keys()].filter(id => !manifests.has(id)).length > 32) throw new AuthorizationError("Too many uncommitted epoch preparations");
    const epochs = new Map<string, { envelopes: readonly KeyEnvelope[]; history: ReadonlyMap<string, string> }>(), pendingEpochs: PendingEpoch[] = [];
    const revoked = new Set<string>();
    for (const rev of revocations) if (rev.type === "MEMBER_REVOKED") {
      revoked.add(rev.revocation.targetActorId);
      const commitment = rev.revocation.epoch, group = groups.get(commitment?.id ?? "") ?? new Map();
      if (!commitment) { if (group.size) throw new AuthorizationError("Pages attached to an inline rotation"); continue; }
      if (!commitment.historyCount && commitment.historyRoot !== await emptyEpochRoot(this.descriptor.projectId, rev.revocation.keyId, "history"))
        throw new AuthorizationError("Invalid empty witness commitment");
      const envelopes: KeyEnvelope[] = [], witnesses: HistoryWitness[] = [];
      let keyPages = 0, historyPages = 0;
      const sorted = [...group.values()].sort((a, b) => a.epochPage.kind < b.epochPage.kind ? -1 : a.epochPage.kind > b.epochPage.kind ? 1 : a.epochPage.index - b.epochPage.index);
      for (const e of sorted) {
        const p = e.epochPage;
        if (p.keyId !== rev.revocation.keyId || p.targetActorId !== rev.revocation.targetActorId || !sameEpochCommitment(p.commitment, commitment) ||
            e.sequence >= rev.sequence || e.lamport >= rev.lamport) throw new AuthorizationError("Epoch page does not match root manifest");
        if (p.kind === "keys") {
          keyPages++; envelopes.push(...p.entries);
          for (const envelope of p.entries) {
            const c = certificates.get(envelope.recipient);
            if (c && certificateActors(c).some(actor => revoked.has(actor))) throw new AuthorizationError("Paged rotation leaks key to revoked delegation");
          }
        } else { historyPages++; witnesses.push(...p.entries); }
      }
      if (envelopes.some((e, i) => i > 0 && e.recipient <= envelopes[i - 1]!.recipient) || witnesses.some((e, i) => i > 0 && e.id <= witnesses[i - 1]!.id))
        throw new AuthorizationError("Duplicate or unsorted cross-page entries");
      const missingKeyPages = epochPageCount(commitment.keyCount) - keyPages, missingHistoryPages = epochPageCount(commitment.historyCount) - historyPages;
      if (missingKeyPages || missingHistoryPages) pendingEpochs.push(Object.freeze({ manifestId: rev.id, keyId: rev.revocation.keyId, missingKeyPages, missingHistoryPages }));
      else {
        if (!envelopes.some(e => e.recipient === this.descriptor.rootActorId)) throw new AuthorizationError("Complete epoch omits root key envelope");
        epochs.set(rev.id, { envelopes: Object.freeze(envelopes), history: new Map(witnesses.map(w => [w.id, w.digest])) });
      }
    }
    // Orphans share one root-signed plan even before their manifest is received.
    for (const [id, group] of groups) if (!manifests.has(id)) {
      const first = group.values().next().value!.epochPage;
      for (const e of group.values()) {
        if (e.epochPage.keyId !== first.keyId || e.epochPage.targetActorId !== first.targetActorId ||
            !sameEpochCommitment(first.commitment, e.epochPage.commitment)) throw new AuthorizationError("Inconsistent epoch preparation");
        const excluded = new Set([first.targetActorId, ...revocations.flatMap(r => r.type === "MEMBER_REVOKED" && r.lamport < e.lamport ? [r.revocation.targetActorId] : [])]);
        if (e.epochPage.kind === "keys") for (const envelope of e.epochPage.entries) {
          const c = certificates.get(envelope.recipient);
          if (c && certificateActors(c).some(actor => excluded.has(actor))) throw new AuthorizationError("Preparation leaks key to revoked delegation");
        }
      }
    }
    return { epochs, pendingEpochs: Object.freeze(pendingEpochs) };
  }
  /** Prepared pages cannot affect plaintext, keys or revocation until a manifest exists. */
  async prepareEpochPages(state: ProjectEvaluation, events: readonly IEvent[]): Promise<ProjectEvaluation> {
    const governance = [...state.governance], known = new Set(governance.map(e => e.id));
    for (const event of events) {
      const e = await this.authenticateEvent(event);
      if (e.type !== "KEY_EPOCH_PAGE" || state.revocations.some(r => r.type === "MEMBER_REVOKED" && r.revocation.epoch?.id === e.epochPage.epochId)) throw new AuthorizationError("Not an uncommitted preparation page");
      if (!known.has(e.id)) { governance.push(e); known.add(e.id); }
    }
    await this.resolveEpochs(governance, state.revocations, state.certificates);
    return { ...state, items: [], blocks: [], roles: [], eligible: new Set(events.map(e => e.id)), governance };
  }
  /** Only item deltas use this path. Governance changes require authoritative history re-evaluation. */
  async extend(state: ProjectEvaluation, events: readonly IEvent[]): Promise<ProjectEvaluation> {
    const blocks: Uint8Array<ArrayBuffer>[] = [], roles: Role[] = [], eligible = new Set<string>(), certificates = new Map(state.certificates);
    try {
      for (const e of events) {
        if (!isDataType(e.type)) throw new Error("Governance delta requires full replay");
        await this.verifyEvent(e);
        if (!await this.isEventEligible(e, state.revocations, state.epochs)) throw new AuthorizationError("Event permission revoked");
        if (e.type === "MEMBER_INVITED" || e.type === "MEMBER_REVOKED" || e.type === "KEY_EPOCH_PAGE") throw new Error("Invalid item delta");
          if (state.pendingEpochs.some(p => p.keyId === e.keyId)) throw new EpochIncompleteError();
        const key = state.keys.get(e.keyId);
        if (!key) { if (state.pendingEpochs.some(p => p.keyId === e.keyId)) throw new EpochIncompleteError(); throw new AuthorizationError("Unknown project key epoch"); }
        blocks.push(await decryptCommand(e.encryptedFields, fieldsAAD(e, e.type, e.itemId, e.keyId), key));
        roles.push(e.certificate.role);
        eligible.add(e.id);
        const old = certificates.get(e.actorId);
        if (!old || e.certificate.issuedLamport > old.issuedLamport || (e.certificate.issuedLamport === old.issuedLamport && certificateText(e.certificate) > certificateText(old))) certificates.set(e.actorId, e.certificate);
      }
      return { ...state, items: [], blocks, roles, eligible, certificates };
    } catch (error) { for (const block of blocks) block.fill(0); throw error; }
  }
  async restorePolicy(controls: readonly IEvent[], certificates: readonly Certificate[]): Promise<ProjectEvaluation> {
    return this.evaluate(controls, true, certificates);
  }
  checkpointKey(): Promise<CryptoKey> {
    return this.cacheKey ??= (async () => {
      // Owner-only cache key: a revoked holder of the old project key must not read a new snapshot.
      const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(this.identity.actorId.slice(5), 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, this.identity.agreementKey, 256));
      try {
        const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
        const info = encodeBinary(["sovereign-local-core/owner-checkpoint-key/v1", this.descriptor.projectId, this.descriptor.rootActorId, this.descriptor.genesisKeyId, this.identity.actorId]);
        return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: await crypto.subtle.digest("SHA-256", info), info }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      } finally { shared.fill(0); }
    })();
  }
  async invite(subject: string, role: Role, lamport: number, state: ProjectEvaluation): Promise<ProjectInvitation> {
    if (this.certificate.role !== "Admin") throw new AuthorizationError("Only Admin can invite");
    if (this.descriptor.readDomain && !readDomainEntry(this.descriptor.readDomain).readRoles.includes(role)) throw new AuthorizationError("Role has no read access to this domain");
    if (subject === this.descriptor.rootActorId || state.revocations.some(e => e.type === "MEMBER_REVOKED" && e.revocation.targetActorId === subject)) throw new AuthorizationError("Root or revoked actor cannot be invited again");
    if (state.revocations.some(e => e.type === "MEMBER_REVOKED" && certificateActors(this.certificate).includes(e.revocation.targetActorId))) throw new AuthorizationError("Admin certificate revoked");
    const certificate = await issueCertificate(this.identity, this.descriptor.projectId, subject, role, lamport, this.certificate);
    const keys = [];
    for (const key of state.keys.values()) keys.push(await wrapProjectKey(key, this.descriptor.projectId, subject));
    return signInvitation({ version: 1, descriptor: this.descriptor, certificate, keys, currentKeyId: state.currentKeyId, signature: "A".repeat(86) }, this.identity);
  }
  close(): void { for (const key of this.initialKeys.values()) key.bytes.fill(0); this.initialKeys.clear(); this.certificateCache.clear(); }
}
