import type { ReducerPolicies, Role, RowPolicy } from "./types.js";
import { BinaryWriter } from "./binary-codec.js";

const roles: readonly Role[] = ["Admin", "Member", "Kiosk"];
const actions = ["create", "update", "delete", "checkout", "return"] as const;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new TypeError("Invalid policy object");
  return value as Record<string, unknown>;
}
export function normalizePolicies(value: unknown): ReducerPolicies {
  const p = object(value, ["version", "defaultAllow", "rules"]);
  if (p.version !== 1 || typeof p.defaultAllow !== "boolean" || !Array.isArray(p.rules) || p.rules.length > 32) throw new TypeError("Invalid policy bounds");
  const rules = p.rules.map(value => {
    const r = object(value, ["prefix", ...actions, "ownerField", "library"]);
    if (typeof r.prefix !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.prefix) || typeof r.library !== "boolean" ||
        (r.ownerField !== null && (typeof r.ownerField !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.ownerField) ||
        ["__proto__", "constructor", "prototype", "loanId", "borrowerId", "checkedOutBy"].includes(r.ownerField)))) throw new TypeError("Invalid row policy");
    const normalized: Record<string, unknown> = { prefix: r.prefix, library: r.library, ownerField: r.ownerField };
    for (const action of actions) {
      const list = r[action];
      if (!Array.isArray(list) || list.some(role => !roles.includes(role)) || new Set(list).size !== list.length) throw new TypeError("Invalid policy role list");
      normalized[action] = Object.freeze(roles.filter(role => list.includes(role)));
    }
    if (!r.library && ((normalized.checkout as Role[]).length || (normalized.return as Role[]).length)) throw new TypeError("Checkout/return require library state machine");
    return Object.freeze(normalized) as unknown as RowPolicy;
  }).sort((a, b) => a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0);
  if (new Set(rules.map(r => r.prefix)).size !== rules.length) throw new TypeError("Duplicate policy prefix");
  return Object.freeze({ version: 1, defaultAllow: p.defaultAllow, rules: Object.freeze(rules) });
}
export function roleCode(role: Role): number { const code = roles.indexOf(role) + 1; if (!code) throw new TypeError("Unknown role"); return code; }
/** Separate additive SCP1 policy ABI; SCW1 legacy commands remain unchanged. */
export function encodePolicies(value: ReducerPolicies): Uint8Array<ArrayBuffer> {
  const p = normalizePolicies(value), w = new BinaryWriter();
  w.u32(0x31504353); w.u32(1); w.u32(p.rules.length); w.u32(p.defaultAllow ? 1 : 0);
  for (const r of p.rules) {
    w.string(r.prefix); w.string(r.ownerField ?? ""); w.u32(r.library ? 1 : 0);
    for (const action of actions) w.u32(r[action].reduce((mask, role) => mask | (1 << (roleCode(role) - 1)), 0));
  }
  return w.finish();
}
/** Explicit opt-in preset: book IDs, role-limited writes and exclusive checkout view. */
export function libraryPolicies(prefix = "book_"): ReducerPolicies {
  return normalizePolicies({ version: 1, defaultAllow: false, rules: [{ prefix,
    create: ["Admin"], update: ["Admin"], delete: ["Admin"],
    checkout: ["Admin", "Kiosk"], return: ["Admin", "Kiosk"], ownerField: null, library: true }] });
}
