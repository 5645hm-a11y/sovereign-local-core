/** A blind provider sees an opaque topic and encrypted packets only. */
export interface IDiscoveryProvider {
  /** Optional routing extension. Both methods are required when this is true. */
  readonly supportsRouting?: boolean;
  /** The random instance ID is a routing hint, never a membership proof. */
  startRouted?(topic: string, instanceId: string, receive: (packet: Uint8Array<ArrayBuffer>) => void): Promise<void>;
  /** null advertises presence; a recipient targets an instance's stable inbox. */
  publishRouted?(packet: Uint8Array<ArrayBuffer>, recipient: string | null): Promise<void>;
  start(topic: string, receive: (packet: Uint8Array<ArrayBuffer>) => void): Promise<void>;
  publish(packet: Uint8Array<ArrayBuffer>): Promise<void>;
  stop(): void;
}
export type DiscoverySignalKind = "hello" | "challenge" | "proof" | "offer" | "answer" | "ice";
export interface DiscoverySignal {
  readonly kind: DiscoverySignalKind;
  readonly from: string;
  readonly to: string | null;
  readonly session: string | null;
  readonly challenge: string | null;
  readonly response: string | null;
  readonly description: RTCSessionDescriptionInit | null;
  readonly candidate: RTCIceCandidateInit | null;
}
export interface VerifiedDiscoverySignal { readonly actorId: string; readonly signal: DiscoverySignal }
/** Implemented by the core/Worker, not by the relay. No private keys cross this API. */
export interface IDiscoveryCore {
  getDiscoveryInfo(): Promise<{ topic: string; keyId: string; actorId: string }>;
  sealDiscovery(signal: DiscoverySignal): Promise<Uint8Array<ArrayBuffer>>;
  openDiscovery(packet: Uint8Array<ArrayBuffer>): Promise<VerifiedDiscoverySignal>;
  /** Optional lifecycle extension: close known revoked mesh edges on governance changes. */
  isDiscoveryPeerAuthorized?(actorId: string): Promise<boolean>;
}
export const MAX_DISCOVERY_PACKET = 32 * 1024;

/** Optional control-only recovery. Never accepts application events, SDP or ICE. */
export interface IDiscoveryRecoveryCore {
  getDiscoveryRecoveryInfo(): Promise<{ topic: string; instanceId?: string }>;
  createDiscoveryRecoveryRequest(): Promise<Uint8Array<ArrayBuffer>>;
  handleDiscoveryRecoveryRequest(packet: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null>;
  acceptDiscoveryRecoveryResponse(packet: Uint8Array<ArrayBuffer>): Promise<RecoveryProgress | null>;
  cancelDiscoveryRecovery(): Promise<void>;
  /** Optional routed extension. No automatic downgrade when a provider enables it. */
  createRoutedDiscoveryRecoveryRequest?(): Promise<Uint8Array<ArrayBuffer>>;
  handleRoutedDiscoveryRecoveryRequest?(packet: Uint8Array<ArrayBuffer>): Promise<RecoveryReply | null>;
}
export interface RecoveryReply { readonly packet: Uint8Array<ArrayBuffer>; readonly recipient: string | null }
export interface RecoveryProgress {
  readonly request: Uint8Array<ArrayBuffer> | null;
  readonly complete: boolean;
  readonly keyId: string | null;
  /** Verified responder inbox for the next routed pull; never a membership proof. */
  readonly recipient?: string | null;
}
