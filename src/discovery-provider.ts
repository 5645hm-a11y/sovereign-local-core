/** A blind provider sees an opaque topic and encrypted packets only. */
export interface IDiscoveryProvider {
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
}
export const MAX_DISCOVERY_PACKET = 32 * 1024;
