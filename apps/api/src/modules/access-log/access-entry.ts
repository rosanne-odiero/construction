import { isIP } from "node:net";
import type { AccessIdentity } from "../../common/access-context.js";

/**
 * Access-log limits (CONFIGURATION "Access log"). The row bounds match the CHECK constraint and
 * the retention matches app.purge_access_events() in migration 20261210090000_access_log.
 */
export const ACCESS_LOG_LIMITS = {
  /** Path parameters and UUID query values kept per request. */
  maxParams: 10,
  /** Distinct record IDs per request, for the report's record filter. */
  maxRecordIds: 10,
  maxRouteLength: 200,
  /** Entries written per database round trip. */
  batchSize: 200,
  flushIntervalMs: 1_000,
  /** Entries held while the database is unreachable; more are dropped and counted. */
  maxQueued: 20_000,
  /** The longest pause between write attempts while the database is failing. */
  maxBackoffMs: 30_000,
  retentionDays: 365,
  /** Rows deleted per purge call, and calls per hourly purge. */
  purgeBatch: 5_000,
  purgeRounds: 20,
  purgeIntervalMs: 3_600_000,
} as const;

export type AccessEntry = {
  tenantId: string;
  userId: string;
  sessionId: string;
  authMethod: string;
  method: string;
  route: string;
  params: Record<string, string>;
  resourceIds: string[];
  status: number;
  durationMs: number;
  ipAddress: string | null;
  requestId: string;
  occurredAt: Date;
};

export type AccessRequest = {
  identity: AccessIdentity;
  method: string;
  status: number;
  durationMs: number;
  /** Only set when a trusted proxy reports the client (AuthSecurity.clientAddress). */
  clientAddress: string | undefined;
  requestId: unknown;
  occurredAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const AUTH_METHOD = /^[a-z]{1,10}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Company routes whose `:id` may name another company the person belongs to (switching). */
const COMPANY_ROUTE = /^\/api\/v1\/tenants\/:id(?:\/|$)/;
const MAX_INT = 2_147_483_647;
export const REDACTED = "[redacted]";

/**
 * The access-log entry of a signed-in request made in a company, or null when it is not one.
 * Keeps the route template and path parameters (values that are not simple IDs become
 * [redacted]) plus query values that are UUIDs (record IDs such as projectId) — never other query
 * values, which can hold search text, and never the body. A company's log never names another
 * company the person belongs to.
 */
export function accessEntry(input: AccessRequest): AccessEntry | null {
  const { identity } = input;
  const method = input.method.toUpperCase();
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (
    !identity.tenantId ||
    !METHODS.has(method) ||
    !REQUEST_ID.test(requestId) ||
    !AUTH_METHOD.test(identity.authMethod)
  )
    return null;
  const otherCompany = (key: string, value: string) =>
    key === "id" &&
    COMPANY_ROUTE.test(identity.route ?? "") &&
    value.toLowerCase() !== identity.tenantId;
  const params: Record<string, string> = {};
  const full = () => Object.keys(params).length >= ACCESS_LOG_LIMITS.maxParams;
  for (const [key, value] of Object.entries(identity.params)) {
    if (full()) break;
    if (!KEY.test(key)) continue;
    params[key] =
      typeof value === "string" && SAFE_VALUE.test(value) && !otherCompany(key, value)
        ? UUID.test(value)
          ? value.toLowerCase()
          : value
        : REDACTED;
  }
  for (const [key, value] of Object.entries(identity.query)) {
    if (full()) break;
    if (
      KEY.test(key) &&
      !Object.hasOwn(params, key) &&
      typeof value === "string" &&
      UUID.test(value)
    )
      params[key] = value.toLowerCase();
  }
  const resourceIds = [...new Set(Object.values(params).filter((value) => UUID.test(value)))];
  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
    authMethod: identity.authMethod,
    method,
    route: (identity.route ?? "(unknown)").slice(0, ACCESS_LOG_LIMITS.maxRouteLength),
    params,
    resourceIds: resourceIds.slice(0, ACCESS_LOG_LIMITS.maxRecordIds),
    status:
      Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
        ? input.status
        : 500,
    durationMs: Math.min(Math.max(0, Math.round(input.durationMs)), MAX_INT),
    ipAddress: clientIp(input.clientAddress),
    requestId,
    occurredAt: input.occurredAt,
  };
}

/** A valid IP address (an IPv4-mapped IPv6 address as plain IPv4), or null. */
export function clientIp(address: string | undefined): string | null {
  if (!address) return null;
  const ip = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1] ?? address;
  return isIP(ip) ? ip : null;
}
