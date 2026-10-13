import { encodeBinary } from "./binary-codec.js";
import { normalizeProjectId, toBase64Url } from "./crypto-codec.js";
import { normalizePolicies } from "./policies.js";
import type { ReadDomainConfig, ReadDomainDefinition, ReadDomainEntry, ReadDomainSpace, Role } from "./types.js";

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new TypeError("Invalid read-domain object");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new TypeError("Invalid read-domain identifier");
  return value;
}
export function normalizeReadDomainDefinition(value: unknown): ReadDomainDefinition {
  const d = object(value, ["id", "prefixes", "readRoles", "policies"]);
  if (!Array.isArray(d.prefixes) || !d.prefixes.length || d.prefixes.length > 16 ||
      !Array.isArray(d.readRoles) || !d.readRoles.length || d.readRoles.length > 3) throw new TypeError("Invalid read-domain bounds");
  const prefixes = d.prefixes.map(identifier).sort();
  const roles: Role[] = ["Admin", "Member", "Kiosk"].filter(role => d.readRoles instanceof Array && d.readRoles.includes(role)) as Role[];
  if (new Set(prefixes).size !== prefixes.length || roles.length !== d.readRoles.length || !roles.includes("Admin")) throw new TypeError("Read roles must be unique, known and include Admin");
  return Object.freeze({ id: identifier(d.id), prefixes: Object.freeze(prefixes), readRoles: Object.freeze(roles), policies: normalizePolicies(d.policies) });
}
export function normalizeReadDomainSpace(value: unknown): ReadDomainSpace {
  const s = object(value, ["version", "spaceId", "domains"]);
  if (s.version !== 1 || !Array.isArray(s.domains) || !s.domains.length || s.domains.length > 16) throw new TypeError("Read space requires 1–16 domains");
  const domains: ReadDomainEntry[] = s.domains.map(value => {
    const d = object(value, ["id", "prefixes", "readRoles", "policies", "projectId"]);
    const { projectId, ...definition } = d;
    return Object.freeze({ ...normalizeReadDomainDefinition(definition), projectId: normalizeProjectId(projectId) });
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const prefixes = domains.flatMap(d => d.prefixes);
  if (new Set(domains.map(d => d.id)).size !== domains.length || new Set(domains.map(d => d.projectId)).size !== domains.length ||
      prefixes.length > 64 || new Set(prefixes).size !== prefixes.length) throw new TypeError("Duplicate domain, project or routing prefix");
  return Object.freeze({ version: 1, spaceId: identifier(s.spaceId), domains: Object.freeze(domains) });
}
export function normalizeReadDomainConfig(value: unknown): ReadDomainConfig {
  const d = object(value, ["domainId", "space"]), space = normalizeReadDomainSpace(d.space), domainId = identifier(d.domainId);
  if (!space.domains.some(d => d.id === domainId)) throw new TypeError("Domain is absent from the signed space");
  return Object.freeze({ domainId, space });
}
export function readDomainEntry(config: ReadDomainConfig): ReadDomainEntry { return config.space.domains.find(d => d.id === config.domainId)!; }
/** Longest immutable prefix wins; no implicit public fallback for missing domains. */
export function resolveReadDomain(space: ReadDomainSpace, itemId: string): ReadDomainEntry {
  let selected: ReadDomainEntry | undefined, length = -1;
  for (const domain of space.domains) for (const prefix of domain.prefixes) if (itemId.startsWith(prefix) && prefix.length > length) {
    selected = domain; length = prefix.length;
  }
  if (!selected) throw new Error("Item has no signed read domain");
  return selected;
}
export function sameReadDomainValue(a: unknown, b: unknown): boolean { return toBase64Url(encodeBinary(a)) === toBase64Url(encodeBinary(b)); }
