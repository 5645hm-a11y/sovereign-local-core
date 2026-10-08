/** Field values are atomic JSON scalars in v1. Nested values need their own CRDT. */
export type FieldValue = string | number | boolean | null;
export type Fields = Readonly<Record<string, FieldValue>>;

export type ItemCommand =
  | { readonly type: "FILE_ADDED"; readonly itemId: string; readonly fields: Fields }
  | { readonly type: "ITEM_ADDED"; readonly itemId: string; readonly fields: Fields }
  | { readonly type: "ITEM_UPDATED"; readonly itemId: string; readonly fields: Fields }
  | { readonly type: "ITEM_DELETED"; readonly itemId: string };

/** File manifests are data deltas, never governance or file-byte payloads. */
export function isDataType(type: string): boolean {
  return type === "ITEM_ADDED" || type === "ITEM_UPDATED" || type === "ITEM_DELETED" || type === "FILE_ADDED";
}

export interface Ciphertext { readonly iv: string; readonly ciphertext: string }
export type Role = "Admin" | "Member";
export interface Certificate {
  readonly version: 1;
  readonly projectId: string;
  readonly subject: string;
  readonly issuer: string;
  readonly role: Role;
  readonly issuedLamport: number;
  readonly parent: Certificate | null;
  readonly signature: string;
}
export interface ProjectDescriptor {
  readonly version: 1;
  readonly projectId: string;
  readonly rootActorId: string;
  readonly genesisKeyId: string;
  readonly rootCertificate: Certificate;
  readonly signature: string;
}
export interface KeyEnvelope extends Ciphertext {
  readonly keyId: string;
  readonly recipient: string;
  readonly ephemeralPublicKey: string;
  readonly salt: string;
}
export interface ProjectInvitation {
  readonly version: 1;
  readonly descriptor: ProjectDescriptor;
  readonly certificate: Certificate;
  readonly keys: readonly KeyEnvelope[];
  readonly currentKeyId: string;
  readonly signature: string;
}
export interface Revocation {
  readonly targetActorId: string;
  /** Exact previously witnessed payload hashes, never an actor-chosen clock alone. */
  readonly allowedHistory: readonly { readonly id: string; readonly digest: string }[];
  readonly keyId: string;
  readonly envelopes: readonly KeyEnvelope[];
}
export interface EventMetadata {
  readonly schemaVersion: 3;
  readonly projectId: string;
  readonly id: string;
  readonly actorId: string;
  readonly sequence: number;
  readonly lamport: number;
  readonly certificate: Certificate;
}
export type EventBody =
  | { readonly type: ItemCommand["type"]; readonly itemId: string; readonly keyId: string; readonly encryptedFields: Ciphertext }
  | { readonly type: "MEMBER_INVITED"; readonly invitation: ProjectInvitation }
  | { readonly type: "MEMBER_REVOKED"; readonly revocation: Revocation };
export type UnsignedEvent = EventMetadata & EventBody;

export type IEvent = UnsignedEvent & { readonly signature: string };

export interface IdentityOpenOptions {
  readonly email: string;
  readonly password: string;
  readonly projectId: string;
  /** Required to bootstrap a member; thereafter read from local project metadata. */
  readonly invitation?: ProjectInvitation;
  /** Defaults to a hash of the normalized email; demos use explicit isolated vault names. */
  readonly vaultName?: string;
}

export interface ItemView {
  readonly id: string;
  readonly fields: Fields;
}

/** A query view, NOT a replay checkpoint: tombstones remain inside the reducer/log. */
export interface Snapshot {
  readonly schemaVersion: 1;
  readonly lamport: number;
  readonly items: readonly ItemView[];
}

export interface RecoveryReport {
  readonly eventCount: number;
  readonly discardedTailBytes: number;
  readonly checkpointEvents?: number;
  readonly replayedEvents?: number;
}

export interface AppendResult {
  readonly appended: boolean;
}

export interface ILocalStore {
  readonly actorId: string;
  readonly projectId: string;
  readonly recovery: RecoveryReport;
  readonly checkpoint?: import("./checkpoints.js").CoreCheckpoint | undefined;
  readonly checkpointEnabled?: boolean;
  readRecoveryEvents?(): Promise<readonly IEvent[]>;
  saveCheckpoint?(checkpoint: import("./checkpoints.js").CheckpointData): Promise<void>;
  /** Resolves only after the storage flush; rejection can mean an uncertain commit. */
  append(event: IEvent): Promise<AppendResult>;
  /** Reads and validates the actual file, rather than returning an in-memory cache. */
  readEvents(): Promise<readonly IEvent[]>;
  close(): Promise<void>;
}

export interface ICRDTMerge {
  materialize(events: Iterable<IEvent>): Promise<Snapshot>;
}

/** Highest CONTIGUOUS durable sequence per actor, never simply the maximum seen. */
export type SyncSummary = Readonly<Record<string, number>>;
export interface CommitNotification {
  readonly source: "local" | "remote";
  readonly event: IEvent;
}
export interface IngestResult {
  readonly applied: number;
  readonly summary: SyncSummary;
  readonly snapshot: Snapshot;
}

/** Transport depends only on this boundary; validation, storage and merge stay in the core. */
export interface ISyncCore {
  getSyncSummary(): Promise<SyncSummary>;
  readMissingEvents(summary: SyncSummary): Promise<readonly IEvent[]>;
  ingestEvents(events: readonly unknown[]): Promise<IngestResult>;
  onCommit(listener: (notification: CommitNotification) => void): () => void;
}
