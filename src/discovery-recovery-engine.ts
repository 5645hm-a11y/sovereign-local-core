import { decodeWire, encodeWire } from "./binary-events.js";
import { AuthorizationError, verifyCertificate } from "./certificates.js";
import { discoveryToken, DiscoveryReplayWindow } from "./discovery-crypto.js";
import { normalizeEvent } from "./validation.js";
import { isDataType, type Certificate, type IEvent, type ProjectDescriptor } from "./types.js";
import type { UnlockedIdentity } from "./identity.js";
import type { ProjectEvaluation } from "./project.js";
import type { RecoveryProgress, RecoveryReply } from "./discovery-provider.js";
import { MAX_DISCOVERY_PACKET } from "./discovery-provider.js";
import { deriveRecoveryMaterial, MAX_RECOVERY_CONTROLS, RECOVERY_FRAGMENT_BYTES, recoveryProof, openRecoveryRequest,
  sealRecoveryRequest, sealRecoveryResponse, openRecoveryResponse, verifyRecoverySignature,
  type RecoveryMaterial, type RecoveryRequest } from "./discovery-recovery-crypto.js";

interface Hooks {
  state(): ProjectEvaluation;
  revision(): number;
  requireMember(certificate: Certificate): void;
  eligible(event: IEvent): Promise<boolean>;
  ingest(event: IEvent): Promise<void>;
}
interface Outgoing {
  request: RecoveryRequest; responder: string | null; cursor: string | null;
  count: number | null; keyId: string | null; bytes: Uint8Array<ArrayBuffer> | null;
  route: string | null;
}
interface Serving {
  actor: string; session: string; revision: number; keyId: string;
  controls: readonly IEvent[]; index: number; offset: number;
  encoded: Uint8Array<ArrayBuffer> | null; expiry: number;
  replyTo: string | null;
}
/** Called only inside LocalCore's serialized operation queue. No storage bypass. */
export class DiscoveryRecoveryEngine {
  private material: Promise<RecoveryMaterial> | undefined;
  private outgoing: Outgoing | null = null;
  private readonly serving = new Map<string, Serving>();
  private readonly requests = new DiscoveryReplayWindow();
  private readonly responses = new DiscoveryReplayWindow();
  private readonly instanceId = discoveryToken();
  constructor(private readonly descriptor: ProjectDescriptor, private readonly certificate: Certificate,
    private readonly identity: UnlockedIdentity, private readonly hooks: Hooks) {}
  private channel(): Promise<RecoveryMaterial> {
    const genesis = this.hooks.state().keys.get(this.descriptor.genesisKeyId);
    if (!genesis) throw new AuthorizationError("Missing recovery genesis key");
    return this.material ??= deriveRecoveryMaterial(this.descriptor, genesis);
  }
  async info(): Promise<{ topic: string; instanceId: string }> { this.hooks.requireMember(this.certificate); return { topic: (await this.channel()).topic, instanceId: this.instanceId }; }
  private async authenticate(kind: "request" | "response", payload: { certificate: Certificate; actorId: string }, signature: Uint8Array<ArrayBuffer>) {
    const c = await verifyCertificate(payload.certificate, this.descriptor);
    if (c.subject !== payload.actorId) throw new AuthorizationError("Recovery certificate/actor mismatch");
    this.hooks.requireMember(c); await verifyRecoverySignature(kind, payload, signature);
  }
  async begin(routed = false): Promise<Uint8Array<ArrayBuffer>> {
    this.cancelOutgoing(); this.hooks.requireMember(this.certificate);
    const state = this.hooks.state();
    const request: RecoveryRequest = { ...recoveryProof(this.identity.actorId, this.certificate), session: discoveryToken(),
      responder: null, cursor: null, index: 0, offset: 0,
      knownKeyId: !state.pendingEpochs.length && state.keys.has(state.currentKeyId) ? state.currentKeyId : null,
      ...(routed ? { replyTo: this.instanceId } : {}) };
    this.outgoing = { request, responder: null, cursor: null, count: null, keyId: null, bytes: null, route: null };
    return sealRecoveryRequest(request, await this.channel(), this.identity);
  }
  async serve(packet: Uint8Array<ArrayBuffer>, routed = false): Promise<RecoveryReply | null> {
    this.hooks.requireMember(this.certificate);
    const { payload: r, signature } = await openRecoveryRequest(packet, await this.channel());
    if (r.actorId === this.identity.actorId || (r.responder !== null && r.responder !== this.identity.actorId)) return null;
    if (routed !== (r.replyTo !== undefined)) throw new TypeError("Recovery routing mode mismatch");
    await this.authenticate("request", r, signature); this.requests.accept(r);
    const state = this.hooks.state();
    if (state.pendingEpochs.length || !state.keys.has(state.currentKeyId)) throw new AuthorizationError("Cannot serve an incomplete epoch");
    if (routed && r.responder === null) {
      // A probe creates no cursor and carries no governance bytes. Only the selected peer starts a transfer.
      const offer = await sealRecoveryResponse({ ...recoveryProof(this.identity.actorId, this.certificate), requestId: r.nonce,
        session: r.session, recipient: r.actorId, cursor: null, index: 0, offset: 0, totalBytes: 0, count: 0,
        bytes: new Uint8Array(0), keyId: state.currentKeyId, done: false, replyTo: this.instanceId, offer: true }, await this.channel(), this.identity);
      return { packet: offer, recipient: r.replyTo! };
    }
    for (const [id, cursor] of this.serving) if (cursor.expiry < Date.now()) this.drop(id);
    let id = r.cursor, cursor = id === null ? undefined : this.serving.get(id);
    if (id === null) {
      if (this.serving.size >= 8) throw new RangeError("Recovery serving cursor capacity exceeded");
      const controls: IEvent[] = [];
      if (r.knownKeyId !== state.currentKeyId) {
        for (const event of state.governance) if (await this.hooks.eligible(event)) {
          if (isDataType(event.type)) throw new Error("Data in recovery governance cache");
          if (controls.length >= MAX_RECOVERY_CONTROLS) throw new RangeError("Recovery governance exceeds record bound");
          controls.push(event);
        }
      }
      id = discoveryToken(); cursor = { actor: r.actorId, session: r.session, revision: this.hooks.revision(), keyId: state.currentKeyId,
        controls, index: 0, offset: 0, encoded: null, expiry: Date.now() + 60000, replyTo: r.replyTo ?? null };
      this.serving.set(id, cursor);
    }
    if (cursor && cursor.revision !== this.hooks.revision()) { this.drop(id!); throw new Error("Recovery cursor changed; restart"); }
    if (!cursor || cursor.actor !== r.actorId || cursor.session !== r.session || cursor.replyTo !== (r.replyTo ?? null) ||
        cursor.index !== r.index || cursor.offset !== r.offset) throw new Error("Recovery cursor changed or invalid range; restart");
    cursor.expiry = Date.now() + 60000;
    const done = cursor.index === cursor.controls.length;
    if (!done && !cursor.encoded) {
      cursor.encoded = encodeWire(cursor.controls[cursor.index]);
      if (cursor.encoded.length > 1024 * 1024) { this.drop(id!); throw new RangeError("Recovery record exceeds log bound"); }
    }
    const bytes = done ? new Uint8Array(0) : cursor.encoded!.slice(cursor.offset, cursor.offset + RECOVERY_FRAGMENT_BYTES);
    const reply = await sealRecoveryResponse({ ...recoveryProof(this.identity.actorId, this.certificate), requestId: r.nonce,
      session: r.session, recipient: r.actorId, cursor: id!, index: cursor.index, offset: cursor.offset,
      totalBytes: done ? 0 : cursor.encoded!.length, count: cursor.controls.length, bytes, keyId: cursor.keyId, done,
      ...(routed ? { replyTo: this.instanceId } : {}) }, await this.channel(), this.identity);
    if (done) this.drop(id!);
    else {
      cursor.offset += bytes.length;
      if (cursor.offset === cursor.encoded!.length) { cursor.encoded!.fill(0); cursor.encoded = null; cursor.index++; cursor.offset = 0; }
    }
    return { packet: reply, recipient: r.replyTo ?? null };
  }
  async accept(packet: Uint8Array<ArrayBuffer>): Promise<RecoveryProgress | null> {
    const client = this.outgoing; if (!client) return null;
    this.hooks.requireMember(this.certificate);
    const opened = await openRecoveryResponse(packet, await this.channel(), this.identity); if (!opened) return null;
    const r = opened.payload;
    if (r.requestId !== client.request.nonce || r.session !== client.request.session || r.recipient !== this.identity.actorId ||
        (client.responder !== null && r.actorId !== client.responder)) return null;
    await this.authenticate("response", r, opened.signature); this.responses.accept(r);
    if ((client.request.replyTo !== undefined) !== (r.replyTo !== undefined) ||
        (client.route !== null && client.route !== r.replyTo)) throw new Error("Recovery responder inbox changed or routing mode mismatch");
    if (client.request.replyTo !== undefined && client.responder === null && !r.offer) throw new Error("Routed recovery requires a signed offer before data");
    if (r.offer) {
      if (client.request.responder !== null || client.request.cursor !== null || client.request.index || client.request.offset) throw new Error("Unexpected recovery offer during transfer");
      const state = this.hooks.state();
      if (r.keyId !== state.currentKeyId && state.keys.has(r.keyId)) throw new AuthorizationError("Stale recovery offer cannot select an older known epoch");
      if (client.request.knownKeyId === r.keyId && state.currentKeyId === r.keyId && !state.pendingEpochs.length && state.keys.has(r.keyId)) {
        this.cancelOutgoing(); return { complete: true, request: null, keyId: r.keyId, recipient: null };
      }
      client.responder = r.actorId; client.route = r.replyTo!; client.keyId = r.keyId;
      const request: RecoveryRequest = { ...recoveryProof(this.identity.actorId, this.certificate), session: r.session,
        responder: r.actorId, cursor: null, index: 0, offset: 0, knownKeyId: client.request.knownKeyId, replyTo: client.request.replyTo! };
      client.request = request;
      return { complete: false, keyId: null, request: await sealRecoveryRequest(request, await this.channel(), this.identity), recipient: r.replyTo! };
    }
    if (r.index !== client.request.index || r.offset !== client.request.offset || (client.cursor !== null && r.cursor !== client.cursor) ||
        (client.count !== null && r.count !== client.count) || (client.keyId !== null && r.keyId !== client.keyId)) throw new Error("Recovery response changed placement or fence");
    client.responder = r.actorId; client.cursor = r.cursor; client.count = r.count; client.keyId = r.keyId;
    if (r.done) {
      const state = this.hooks.state(); this.hooks.requireMember(this.certificate); this.hooks.requireMember(r.certificate);
      if (client.bytes || state.currentKeyId !== r.keyId || state.pendingEpochs.length || !state.keys.has(r.keyId)) throw new AuthorizationError("Incomplete recovery cannot activate discovery");
      this.cancelOutgoing(); return { complete: true, request: null, keyId: r.keyId };
    }
    if (!client.bytes) client.bytes = new Uint8Array(r.totalBytes);
    if (client.bytes.length !== r.totalBytes) throw new Error("Recovery record size changed");
    client.bytes.set(r.bytes, r.offset);
    let index = r.index, offset = r.offset + r.bytes.length;
    if (offset === r.totalBytes) {
      const event = normalizeEvent(decodeWire(client.bytes));
      if (isDataType(event.type)) throw new AuthorizationError("Recovery rejects application events");
      await this.hooks.ingest(event); // Signature/policy/proof validation and flush-before-ACK.
      client.bytes.fill(0); client.bytes = null; index++; offset = 0;
    }
    const request: RecoveryRequest = { ...recoveryProof(this.identity.actorId, this.certificate), session: r.session,
      responder: r.actorId, cursor: r.cursor, index, offset, knownKeyId: client.request.knownKeyId,
      ...(client.request.replyTo !== undefined ? { replyTo: client.request.replyTo } : {}) };
    client.request = request;
    return { complete: false, keyId: null, request: await sealRecoveryRequest(request, await this.channel(), this.identity),
      ...(client.route !== null ? { recipient: client.route } : {}) };
  }
  private drop(id: string) { this.serving.get(id)?.encoded?.fill(0); this.serving.delete(id); }
  private cancelOutgoing() { this.outgoing?.bytes?.fill(0); this.outgoing = null; }
  cancel(): void { this.cancelOutgoing(); for (const id of this.serving.keys()) this.drop(id); }
}
export function copyRecoveryPacket(value: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.length > MAX_DISCOVERY_PACKET) throw new RangeError("Invalid recovery packet size"); return value.slice();
}
