/** Field values are atomic JSON scalars in v1. Nested values need their own CRDT. */
export type FieldValue = string | number | boolean | null;
export type Fields = Readonly<Record<string, FieldValue>>;

export type ItemCommand =
  | { readonly type: "CHECKOUT"; readonly itemId: string; readonly fields: { readonly borrowerId: string } }
  | { readonly type: "RETURN"; readonly itemId: string; readonly fields: { readonly checkoutId: string } }
  | { readonly type: "FILE_ADDED"; readonly itemId: string; readonly fields: Fields }
  | { readonly type: "ITEM_ADDED"; readonly itemId: string; readonly fields: Fields }
  | { readonly type: "ITEM_UPDATED"; readonly itemId: string; readonly fields: Fields }
  | { readonly type: "ITEM_DELETED"; readonly itemId: string };

/** File manifests are data deltas, never governance or file-byte payloads. */
export function isDataType(type: string): boolean {
  return type === "ITEM_ADDED" || type === "ITEM_UPDATED" || type === "ITEM_DELETED" || type === "FILE_ADDED" || type === "CHECKOUT" || type === "RETURN";
}

export interface Ciphertext { readonly iv: string; readonly ciphertext: string }
export type Role = "Admin" | "Member" | "Kiosk";
export interface RowPolicy {
  /** Immutable classification: longest matching item-ID prefix wins. */
  readonly prefix: string;
  readonly create: readonly Role[];
  readonly update: readonly Role[];
  readonly delete: readonly Role[];
  readonly checkout: readonly Role[];
  readonly return: readonly Role[];
  /** Non-admin writes require this row field to equal the authenticated ActorID. */
  readonly ownerField: string | null;
  readonly library: boolean;
}
export interface ReducerPolicies {
  readonly version: 1;
  readonly defaultAllow: boolean;
  readonly rules: readonly RowPolicy[];
}
/** One independently keyed project in a signed logical database namespace. */
export interface ReadDomainDefinition {
  readonly id: string;
  readonly prefixes: readonly string[];
  readonly readRoles: readonly Role[];
  readonly policies: ReducerPolicies;
}
export interface ReadDomainEntry extends ReadDomainDefinition { readonly projectId: string }
export interface ReadDomainSpace {
  readonly version: 1;
  readonly spaceId: string;
  readonly domains: readonly ReadDomainEntry[];
}
export interface ReadDomainConfig {
  readonly domainId: string;
  /** The complete immutable routing map is signed in every domain descriptor. */
  readonly space: ReadDomainSpace;
}
export interface EventDecision {
  readonly eventId: string;
  readonly itemId: string;
  readonly type: ItemCommand["type"];
  readonly status: "ACCEPTED" | "REJECTED_CONFLICT" | "REJECTED_POLICY";
}
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
  readonly version: 1 | 2 | 3;
  /** Required and root-signed in descriptor v2/v3; immutable for this project. */
  readonly policies?: ReducerPolicies;
  /** Descriptor v3 partitions reads into independent projects with role-restricted admission. */
  readonly readDomain?: ReadDomainConfig;
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
  /** Opt-in paged rotation. Inline arrays must be empty when this is present. */
  readonly epoch?: EpochCommitment;
}
export interface HistoryWitness { readonly id: string; readonly digest: string }
export interface EpochCommitment {
  readonly id: string; readonly version: 1; readonly pageSize: 128;
  readonly keyCount: number; readonly historyCount: number;
  readonly keyRoot: string; readonly historyRoot: string;
}
export type EpochPage = {
  readonly epochId: string; readonly keyId: string; readonly targetActorId: string;
  readonly commitment: EpochCommitment; readonly index: number; readonly proof: readonly string[];
} & ({ readonly kind: "keys"; readonly entries: readonly KeyEnvelope[] } |
  { readonly kind: "history"; readonly entries: readonly HistoryWitness[] });
export interface PendingEpoch {
  readonly manifestId: string; readonly keyId: string;
  readonly missingKeyPages: number; readonly missingHistoryPages: number;
}
export interface RevokeOptions { readonly paged?: boolean }
export interface RevokeResult { readonly event: IEvent; readonly snapshot: Snapshot; readonly pageCount?: number }
export interface EventMetadata {
  readonly schemaVersion: 3 | 4;
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
  | { readonly type: "MEMBER_REVOKED"; readonly revocation: Revocation }
  | { readonly type: "KEY_EPOCH_PAGE"; readonly epochPage: EpochPage };
export type UnsignedEvent = EventMetadata & EventBody;

export type IEvent = UnsignedEvent & { readonly signature: string };

export interface EmailIdentityOpenOptions {
  readonly mode?: never;
  readonly email: string;
  readonly password: string;
  readonly projectId: string;
  /** Required to bootstrap a member; thereafter read from local project metadata. */
  readonly invitation?: ProjectInvitation;
  /** Defaults to a hash of the normalized email; demos use explicit isolated vault names. */
  readonly vaultName?: string;
  readonly policies?: ReducerPolicies;
  readonly readDomain?: ReadDomainConfig;
}
export interface WalletOpenOptions {
  readonly mode: "wallet";
  readonly walletId: string;
  readonly passphrase: string;
  readonly projectId: string;
  readonly invitation?: ProjectInvitation;
  readonly vaultName?: string;
  readonly policies?: ReducerPolicies;
  readonly readDomain?: ReadDomainConfig;
}
export type IdentityOpenOptions = EmailIdentityOpenOptions | WalletOpenOptions;
export type IdentityCredentials = Omit<EmailIdentityOpenOptions, "projectId" | "invitation" | "policies" | "readDomain"> |
  Omit<WalletOpenOptions, "projectId" | "invitation" | "policies" | "readDomain">;

export interface ItemView {
  readonly id: string;
  readonly fields: Fields;
}

/** A query view, NOT a replay checkpoint: tombstones remain inside the reducer/log. */
export interface Snapshot {
  readonly schemaVersion: 1;
  readonly lamport: number;
  readonly items: readonly ItemView[];
  /** Present for policy projects; outcomes may change when older events arrive. */
  readonly decisions?: readonly EventDecision[];
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
  /** Optional bounded committed-log reads. endOffset must be an append boundary. */
  readonly endOffset?: number;
  readEventPage?(start: number, end: number): Promise<StoredEventPage>;
  /** Optional local-only indexed selection; never grants admission to returned events. */
  openMissingEventScan?(summary: SyncSummary, end: number): Promise<StoredEventScan>;
  close(): Promise<void>;
}

export interface StoredEventPage {
  readonly events: readonly IEvent[];
  readonly nextOffset: number;
  readonly scannedRecords: number;
  readonly scannedBytes: number;
}
export interface SyncCursorHandle { readonly id: string; readonly endOffset: number }
export interface StoredEventScan {
  readPage(): Promise<SyncEventPage>;
  close(): void;
}
export interface SyncEventPage {
  readonly events: readonly IEvent[];
  readonly done: boolean;
  readonly scannedRecords: number;
  readonly scannedBytes: number;
}
export interface ISyncCursorCore {
  /** null permits an explicit compatibility fallback for stores without bounded reads. */
  openSyncCursor(summary: SyncSummary): Promise<SyncCursorHandle | null>;
  readSyncCursor(cursorId: string): Promise<SyncEventPage>;
  /** Idempotent cleanup, including after completion/expiry/connection loss. */
  closeSyncCursor(cursorId: string): Promise<void>;
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
/** A durable event receipt is not final business acceptance or global finality. */
export interface CommitReceipt { readonly event: IEvent; readonly lamport: number; readonly revision: number }
export interface IngestReceipt { readonly applied: number; readonly summary: SyncSummary; readonly lamport: number; readonly revision: number }

/** Transport depends only on this boundary; validation, storage and merge stay in the core. */
export interface ISyncCore {
  getSyncSummary(): Promise<SyncSummary>;
  readMissingEvents(summary: SyncSummary): Promise<readonly IEvent[]>;
  /** Opt-in to paged-frontier-v1. The frontier is bounded on wire, not a partial replication view. */
  readMissingEventsPaged?(summary: SyncSummary): Promise<readonly IEvent[]>;
  openSyncCursor?: ISyncCursorCore["openSyncCursor"];
  readSyncCursor?: ISyncCursorCore["readSyncCursor"];
  closeSyncCursor?: ISyncCursorCore["closeSyncCursor"];
  ingestEvents(events: readonly unknown[]): Promise<IngestResult>;
  /** Optional small receipt path; full Snapshot materialization is skipped. */
  ingestCommitted?(events: readonly unknown[]): Promise<IngestReceipt>;
  onCommit(listener: (notification: CommitNotification) => void): () => void;
}
