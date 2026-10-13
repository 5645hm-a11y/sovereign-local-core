import type { EventDecision, ItemView, FieldValue } from "./types.js";

export interface QueryFilter { readonly field: string; readonly op: "eq" | "gt" | "gte" | "lt" | "lte"; readonly value: FieldValue }
export interface QueryOrder { readonly field: string; readonly direction?: "asc" | "desc" }

export interface QueryOptions {
  readonly kind: "items" | "decisions";
  /** Ordinal item-ID prefix; only available for items. Not a confidentiality rule. */
  readonly prefix?: string;
  readonly limit?: number;
  readonly maxBytes?: number;
  /** At most four AND predicates over flat scalar fields. */
  readonly where?: readonly QueryFilter[];
  readonly orderBy?: QueryOrder | null;
  /** Scan preserves ID order and avoids field-index limits; cannot be combined with orderBy. */
  readonly index?: "auto" | "scan";
}
export interface QueryCursorHandle { readonly id: string; readonly revision: number }
export interface QueryPage {
  readonly kind: QueryOptions["kind"];
  readonly revision: number;
  readonly lamport: number;
  readonly items: readonly ItemView[];
  readonly decisions: readonly EventDecision[];
  readonly done: boolean;
  readonly scanned: number;
  /** Native binary page bytes; structured clone/string representation may cost more. */
  readonly encodedBytes: number;
  /** Optional cold index-build work, separate from the bounded page scan. */
  readonly indexBuildScanned?: number;
  readonly indexKeyBytes?: number;
}
export interface QueryPosition { readonly item: string; readonly lamport: number; readonly sequence: number; readonly actor: string; readonly indexValue?: FieldValue; readonly indexMissing?: boolean }
export const EMPTY_QUERY_POSITION: QueryPosition = Object.freeze({ item: "", lamport: 0, sequence: 0, actor: "" });
export class QueryCursorInvalidatedError extends Error {
  constructor() { super("Query revision changed; reopen the cursor"); this.name = "QueryCursorInvalidatedError"; }
}
export class QueryPageTooLargeError extends Error {
  constructor() { super("A query record exceeds this page budget; request a larger budget or store large content out of band"); this.name = "QueryPageTooLargeError"; }
}
export class QueryIndexLimitError extends Error {
  constructor() { super("Query index exceeds its row, key-size or memory bound; narrow the ID prefix or use bounded ID-order filtering"); this.name = "QueryIndexLimitError"; }
}
function fieldName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 128 || ["__proto__", "constructor", "prototype"].includes(value)) throw new TypeError("Invalid query field");
}
export function normalizeQueryOptions(value: QueryOptions): Required<QueryOptions> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !["kind", "prefix", "limit", "maxBytes", "where", "orderBy", "index"].includes(k)) ||
      !["items", "decisions"].includes(value.kind)) throw new TypeError("Invalid query options");
  const prefix = value.prefix ?? "", limit = value.limit ?? 128, maxBytes = value.maxBytes ?? 65536;
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_-]{0,128}$/.test(prefix) || (value.kind === "decisions" && prefix) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1048576) throw new RangeError("Invalid query page bounds");
  const input = value.where ?? [];
  if (!Array.isArray(input) || input.length > 4) throw new RangeError("At most four query predicates are allowed");
  const where = input.map(filter => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || Object.keys(filter).sort().join(",") !== "field,op,value" ||
        !["eq", "gt", "gte", "lt", "lte"].includes(filter.op)) throw new TypeError("Invalid query predicate");
    fieldName(filter.field); const scalar = filter.value;
    if (!(scalar === null || typeof scalar === "boolean" || (typeof scalar === "number" && Number.isFinite(scalar)) ||
        (typeof scalar === "string" && scalar.length <= 1024)) || (filter.op !== "eq" && typeof scalar !== "number" && typeof scalar !== "string")) throw new TypeError("Invalid query scalar/range");
    return Object.freeze({ field: filter.field, op: filter.op, value: typeof scalar === "number" && scalar === 0 ? 0 : scalar });
  });
  let orderBy: QueryOrder | null = null;
  if (value.orderBy != null) {
    const order = value.orderBy;
    if (typeof order !== "object" || Array.isArray(order) || Object.keys(order).some(k => k !== "field" && k !== "direction") ||
        (order.direction !== undefined && order.direction !== "asc" && order.direction !== "desc")) throw new TypeError("Invalid query ordering");
    fieldName(order.field); orderBy = Object.freeze({ field: order.field, direction: order.direction ?? "asc" });
  }
  const index = value.index ?? "auto";
  if (!["auto", "scan"].includes(index) || (index === "scan" && orderBy)) throw new TypeError("Invalid query index mode");
  if (value.kind === "decisions" && (where.length || orderBy || index !== "auto")) throw new TypeError("Field queries require item pages");
  return Object.freeze({ kind: value.kind, prefix, limit, maxBytes, where: Object.freeze(where), orderBy, index });
}

/** Small immutable descriptors, framed without JSON or ambiguous string concatenation. */
export function queryOptionsKey(value: Required<QueryOptions>): string {
  const text = (s: string) => `${s.length}:${s}`;
  const scalar = (v: FieldValue) => v === null ? "n" : typeof v === "string" ? `s${text(v)}` : typeof v === "boolean" ? (v ? "t" : "f") : `d${text(String(v))}`;
  return `${value.kind}|${text(value.prefix)}|${value.limit}|${value.maxBytes}|` +
    value.where.map(f => `${text(f.field)}${f.op}:${scalar(f.value)}`).join("|") +
    (value.orderBy ? `|o${text(value.orderBy.field)}${value.orderBy.direction}` : "|o-") + `|${value.index}`;
}
