import { encodeBinary } from "./binary-codec.js";
import { fromBase64Url, normalizeActorId, normalizeProjectId, toBase64Url } from "./crypto-codec.js";
import type { Certificate, ProjectDescriptor, Role } from "./types.js";
import type { UnlockedIdentity } from "./identity.js";

const encoder = new TextEncoder();
const signing = { name: "ECDSA", hash: "SHA-256" };
export class AuthorizationError extends Error {
  constructor(message = "Actor has no valid project permission") { super(message); this.name = "AuthorizationError"; }
}
export function exactObject(value: unknown, expected: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Expected plain object");
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) throw new TypeError("Missing or unknown properties");
  return value as Record<string, unknown>;
}
export function normalizeCertificate(value: unknown, depth = 0): Certificate {
  if (depth > 8) throw new TypeError("Certificate chain exceeds eight delegations");
  const c = exactObject(value, ["version", "projectId", "subject", "issuer", "role", "issuedLamport", "parent", "signature"]);
  if (c.version !== 1 || !["Admin", "Member"].includes(c.role as string) ||
      !Number.isSafeInteger(c.issuedLamport) || (c.issuedLamport as number) < 0) throw new TypeError("Invalid certificate");
  fromBase64Url(c.signature, 64);
  return Object.freeze({ version: 1, projectId: normalizeProjectId(c.projectId), subject: normalizeActorId(c.subject),
    issuer: normalizeActorId(c.issuer), role: c.role as Role, issuedLamport: c.issuedLamport as number,
    parent: c.parent === null ? null : normalizeCertificate(c.parent, depth + 1), signature: c.signature as string });
}
function certificateTuple(c: Certificate): unknown[] {
  return ["sovereign-local-core/certificate/v1", c.version, c.projectId, c.subject, c.issuer, c.role,
    c.issuedLamport, c.parent === null ? null : [...certificateTuple(c.parent), c.parent.signature]];
}
export function certificateText(c: Certificate): string { return toBase64Url(encodeBinary(certificateTuple(c))); }
export async function issueCertificate(identity: UnlockedIdentity, projectId: string, subject: string,
  role: Role, issuedLamport: number, parent: Certificate | null): Promise<Certificate> {
  const unsigned = { version: 1 as const, projectId, subject, issuer: identity.actorId, role, issuedLamport, parent, signature: "A".repeat(86) };
  const normalized = normalizeCertificate(unsigned);
  const signature = await crypto.subtle.sign(signing, identity.privateKey, encodeBinary(certificateTuple(normalized)));
  return normalizeCertificate({ ...normalized, signature: toBase64Url(signature) });
}
export function normalizeDescriptor(value: unknown): ProjectDescriptor {
  const d = exactObject(value, ["version", "projectId", "rootActorId", "genesisKeyId", "rootCertificate", "signature"]);
  if (d.version !== 1 || typeof d.genesisKeyId !== "string" || !/^key_[A-Za-z0-9_-]{43}$/.test(d.genesisKeyId)) throw new TypeError("Invalid project descriptor");
  fromBase64Url(d.signature, 64);
  return Object.freeze({ version: 1, projectId: normalizeProjectId(d.projectId), rootActorId: normalizeActorId(d.rootActorId),
    genesisKeyId: d.genesisKeyId, rootCertificate: normalizeCertificate(d.rootCertificate), signature: d.signature as string });
}
function descriptorText(d: ProjectDescriptor): string { return toBase64Url(encodeBinary(["sovereign-local-core/project/v1", d.version, d.projectId, d.rootActorId, d.genesisKeyId, certificateTuple(d.rootCertificate), d.rootCertificate.signature])); }
export async function signDescriptor(value: ProjectDescriptor, identity: UnlockedIdentity): Promise<ProjectDescriptor> {
  if (value.rootActorId !== identity.actorId) throw new AuthorizationError();
  const signature = toBase64Url(await crypto.subtle.sign(signing, identity.privateKey, encoder.encode(descriptorText(value))));
  return normalizeDescriptor({ ...value, signature });
}
export async function verifyDescriptor(value: unknown): Promise<ProjectDescriptor> {
  const d = normalizeDescriptor(value);
  await verifyCertificate(d.rootCertificate, d);
  const key = await crypto.subtle.importKey("raw", fromBase64Url(d.rootActorId.slice(5), 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify(signing, key, fromBase64Url(d.signature, 64), encoder.encode(descriptorText(d))) &&
      !await crypto.subtle.verify(signing, key, fromBase64Url(d.signature, 64), encoder.encode(JSON.stringify(["sovereign-local-core/project/v1", d.version, d.projectId, d.rootActorId, d.genesisKeyId, certificateTuple(d.rootCertificate), d.rootCertificate.signature])))) throw new AuthorizationError("Invalid project descriptor signature");
  return d;
}
export async function verifyCertificate(value: unknown, descriptor: ProjectDescriptor): Promise<Certificate> {
  const c = normalizeCertificate(value);
  if (c.projectId !== descriptor.projectId) throw new AuthorizationError("Certificate belongs to another project");
  const key = await crypto.subtle.importKey("raw", fromBase64Url(c.issuer.slice(5), 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify(signing, key, fromBase64Url(c.signature, 64), encodeBinary(certificateTuple(c))) &&
      !await crypto.subtle.verify(signing, key, fromBase64Url(c.signature, 64), encoder.encode(JSON.stringify(certificateTuple(c))))) throw new AuthorizationError("Invalid certificate signature");
  if (c.parent === null) {
    if (c.subject !== descriptor.rootActorId || c.issuer !== c.subject || c.role !== "Admin" || c.issuedLamport !== 0 ||
        certificateText(c) !== certificateText(descriptor.rootCertificate) || c.signature !== descriptor.rootCertificate.signature) {
      throw new AuthorizationError("Certificate does not terminate at the pinned project root");
    }
  } else {
    const parent = await verifyCertificate(c.parent, descriptor);
    if (parent.subject !== c.issuer || parent.role !== "Admin" || c.issuedLamport < parent.issuedLamport) throw new AuthorizationError("Invalid certificate delegation");
    // Root controls admin delegation; delegated admins may issue Member certificates.
    if (c.role === "Admin" && c.issuer !== descriptor.rootActorId) throw new AuthorizationError("Only project root can delegate Admin");
  }
  return c;
}
export function certificateActors(c: Certificate): string[] {
  return [c.subject, ...(c.parent ? certificateActors(c.parent) : [])];
}
export function sameDescriptor(a: ProjectDescriptor, b: ProjectDescriptor): boolean { return toBase64Url(encodeBinary(a)) === toBase64Url(encodeBinary(b)); }
