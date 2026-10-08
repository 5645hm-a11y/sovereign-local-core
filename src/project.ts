import { AuthorizationError, certificateActors, certificateText, issueCertificate, sameDescriptor, signDescriptor, verifyCertificate, verifyDescriptor } from "./certificates.js";
import { toBase64Url, fromBase64Url, normalizeProjectId } from "./crypto-codec.js";
import { encodeBinary } from "./binary-codec.js";
import { requireValidEvent, type UnlockedIdentity } from "./identity.js";
import { decryptFields, decryptCommand, fieldsAAD, generateProjectKey, normalizeInvitation, signInvitation, verifyInvitationSignature, unwrapProjectKey, wrapProjectKey, type ProjectKey } from "./project-crypto.js";
import { eventText, canonicalEventBytes, legacyEventText, normalizeCommand } from "./validation.js";
import type { Certificate, IEvent, ItemCommand, ProjectDescriptor, ProjectInvitation, Role } from "./types.js";
import { isDataType } from "./types.js";

export type PlainItemEvent = ItemCommand & { readonly id: string; readonly actorId: string; readonly sequence: number; readonly lamport: number };
export interface ProjectEvaluation {
  readonly items: readonly PlainItemEvent[];
  readonly blocks: readonly Uint8Array<ArrayBuffer>[];
  readonly eligible: ReadonlySet<string>;
  readonly keys: ReadonlyMap<string, ProjectKey>;
  readonly currentKeyId: string;
  readonly certificates: ReadonlyMap<string, Certificate>;
  readonly revocations: readonly IEvent[];
  readonly governance: readonly IEvent[];
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

  static async create(identity: UnlockedIdentity, projectId: string): Promise<ProjectContext> {
    normalizeProjectId(projectId);
    const key = await generateProjectKey();
    const rootCertificate = await issueCertificate(identity, projectId, identity.actorId, "Admin", 0, null);
    const descriptor = await signDescriptor({ version: 1, projectId, rootActorId: identity.actorId,
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
    const e = await requireValidEvent(value, this.descriptor.projectId), c = await this.verified(e.certificate);
    if (c.subject !== e.actorId || e.lamport < c.issuedLamport) throw new AuthorizationError("Event certificate mismatch");
  }
  async evaluate(input: readonly IEvent[], binary = false): Promise<ProjectEvaluation> {
    const events: IEvent[] = [];
    const certificates = new Map<string, Certificate>([[this.descriptor.rootActorId, this.descriptor.rootCertificate], [this.certificate.subject, this.certificate]]);
    const remember = (c: Certificate) => {
      const previous = certificates.get(c.subject);
      if (!previous || c.issuedLamport > previous.issuedLamport || (c.issuedLamport === previous.issuedLamport && certificateText(c) > certificateText(previous))) certificates.set(c.subject, c);
    };
    // Verify the whole history first; arrival order cannot confer authority.
    for (const value of input) {
      const e = await requireValidEvent(value, this.descriptor.projectId);
      const c = await this.verified(e.certificate);
      if (c.subject !== e.actorId || e.lamport < c.issuedLamport) throw new AuthorizationError("Event certificate/actor or issuance clock mismatch");
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
            !e.revocation.envelopes.some(k => k.recipient === this.descriptor.rootActorId)) throw new AuthorizationError("Only pinned root may revoke/rotate; invalid recipients");
      }
      events.push(e);
    }
    const revocations = events.filter(e => e.type === "MEMBER_REVOKED").sort((a, b) => a.lamport - b.lamport || a.sequence - b.sequence);
    const ids = new Set(this.initialKeys.keys());
    const rotationIds = new Set([this.descriptor.genesisKeyId]);
    const revokedActors = new Set<string>();
    for (const e of revocations) if (e.type === "MEMBER_REVOKED") {
      if (rotationIds.has(e.revocation.keyId)) throw new AuthorizationError("Rotation must use a fresh key");
      rotationIds.add(e.revocation.keyId);
      ids.add(e.revocation.keyId);
      revokedActors.add(e.revocation.targetActorId);
      for (const envelope of e.revocation.envelopes) {
        const c = certificates.get(envelope.recipient);
        if (c && certificateActors(c).some(actor => revokedActors.has(actor))) throw new AuthorizationError("Rotation leaks key to revoked delegation");
      }
    }
    const eligible = new Set<string>();
    for (const e of events) {
      let allowed = true;
      for (const rev of revocations) if (rev.type === "MEMBER_REVOKED" && certificateActors(e.certificate).includes(rev.revocation.targetActorId)) {
        const known = rev.revocation.allowedHistory.find(entry => entry.id === e.id);
        if (e.lamport > rev.lamport || !known || !await matchesPayloadDigest(e, known.digest)) { allowed = false; break; }
      }
      if (allowed) eligible.add(e.id);
    }
    const keys = new Map(this.initialKeys);
    const absorb = async (envelopes: ProjectInvitation["keys"]) => {
      for (const envelope of envelopes) if (envelope.recipient === this.identity.actorId && !keys.has(envelope.keyId)) {
        keys.set(envelope.keyId, await unwrapProjectKey(envelope, this.descriptor.projectId, this.identity));
      }
    };
    for (const e of events) if (eligible.has(e.id)) {
      if (e.type === "MEMBER_INVITED") await absorb(e.invitation.keys);
      if (e.type === "MEMBER_REVOKED") await absorb(e.revocation.envelopes);
    }
    const items: PlainItemEvent[] = [], blocks: Uint8Array<ArrayBuffer>[] = [];
    for (const e of events) if (eligible.has(e.id) && e.type !== "MEMBER_INVITED" && e.type !== "MEMBER_REVOKED") {
      if (!ids.has(e.keyId)) throw new AuthorizationError("Unknown project key epoch");
      const key = keys.get(e.keyId);
      if (!key) throw new AuthorizationError("This identity has no decryption key for the event epoch");
      if (binary) {
        blocks.push(await decryptCommand(e.encryptedFields, fieldsAAD(e, e.type, e.itemId, e.keyId), key));
      } else {
        const fields = await decryptFields(e.encryptedFields, fieldsAAD(e, e.type, e.itemId, e.keyId), key);
        const command = normalizeCommand(e.type === "ITEM_DELETED" ? { type: e.type, itemId: e.itemId } : { type: e.type, itemId: e.itemId, fields });
        if (e.type === "ITEM_DELETED" && Object.keys(fields).length) throw new TypeError("Deleted item must have empty encrypted fields");
        items.push(Object.freeze({ ...command, id: e.id, actorId: e.actorId, sequence: e.sequence, lamport: e.lamport }));
      }
    }
    const last = revocations.at(-1);
    return { items, blocks, eligible, keys, certificates, revocations, governance: events.filter(e => !isDataType(e.type)),
      currentKeyId: last?.type === "MEMBER_REVOKED" && last.lamport >= this.certificate.issuedLamport ? last.revocation.keyId : this.invitation.currentKeyId };
  }
  evaluateBinary(input: readonly IEvent[]): Promise<ProjectEvaluation> { return this.evaluate(input, true); }
  /** Only item deltas use this path. Governance changes require authoritative history re-evaluation. */
  async extend(state: ProjectEvaluation, events: readonly IEvent[]): Promise<ProjectEvaluation> {
    const blocks: Uint8Array<ArrayBuffer>[] = [], eligible = new Set<string>(), certificates = new Map(state.certificates);
    try {
      for (const e of events) {
        if (!isDataType(e.type)) throw new Error("Governance delta requires full replay");
        await this.verifyEvent(e);
        for (const rev of state.revocations) if (rev.type === "MEMBER_REVOKED" && certificateActors(e.certificate).includes(rev.revocation.targetActorId)) {
          const known = rev.revocation.allowedHistory.find(entry => entry.id === e.id);
          if (e.lamport > rev.lamport || !known || !await matchesPayloadDigest(e, known.digest)) throw new AuthorizationError("Event permission revoked");
        }
        if (e.type === "MEMBER_INVITED" || e.type === "MEMBER_REVOKED") throw new Error("Invalid item delta");
        const key = state.keys.get(e.keyId);
        if (!key) throw new AuthorizationError("Unknown project key epoch");
        blocks.push(await decryptCommand(e.encryptedFields, fieldsAAD(e, e.type, e.itemId, e.keyId), key));
        eligible.add(e.id);
        const old = certificates.get(e.actorId);
        if (!old || e.certificate.issuedLamport > old.issuedLamport || (e.certificate.issuedLamport === old.issuedLamport && certificateText(e.certificate) > certificateText(old))) certificates.set(e.actorId, e.certificate);
      }
      return { ...state, items: [], blocks, eligible, certificates };
    } catch (error) { for (const block of blocks) block.fill(0); throw error; }
  }
  async restorePolicy(controls: readonly IEvent[], certificates: readonly Certificate[]): Promise<ProjectEvaluation> {
    const state = await this.evaluateBinary(controls), remembered = new Map(state.certificates);
    for (const c of certificates) { await this.verified(c); remembered.set(c.subject, c); }
    return { ...state, certificates: remembered };
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
    if (subject === this.descriptor.rootActorId || state.revocations.some(e => e.type === "MEMBER_REVOKED" && e.revocation.targetActorId === subject)) throw new AuthorizationError("Root or revoked actor cannot be invited again");
    if (state.revocations.some(e => e.type === "MEMBER_REVOKED" && certificateActors(this.certificate).includes(e.revocation.targetActorId))) throw new AuthorizationError("Admin certificate revoked");
    const certificate = await issueCertificate(this.identity, this.descriptor.projectId, subject, role, lamport, this.certificate);
    const keys = [];
    for (const key of state.keys.values()) keys.push(await wrapProjectKey(key, this.descriptor.projectId, subject));
    return signInvitation({ version: 1, descriptor: this.descriptor, certificate, keys, currentKeyId: state.currentKeyId, signature: "A".repeat(86) }, this.identity);
  }
  close(): void { for (const key of this.initialKeys.values()) key.bytes.fill(0); this.initialKeys.clear(); this.certificateCache.clear(); }
}
