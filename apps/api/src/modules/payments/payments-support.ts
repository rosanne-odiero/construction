import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Permission, PaymentProblem } from "@pm-buddy/types";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import type { AccessPolicy, Scope } from "../identity/access-policy.js";
import type { AuthService, Principal } from "../identity/auth.service.js";

/**
 * The payments worker's identity in `app.user_id` and audit events: background work (outbox relay,
 * submissions, callback processing, watchdog) acts as this fixed system actor, never as a user,
 * always inside one company's transaction. It is not a user row and holds no permissions.
 */
export const PAYMENTS_SYSTEM_ACTOR = "00000000-0000-4000-8000-00000000d420";

export const paymentConflict = (code: PaymentProblem, message: string) =>
  new ConflictException({ message, code });
export const paymentBadRequest = (code: PaymentProblem, message: string) =>
  new BadRequestException({ message, code });
export const versionConflict = () =>
  paymentConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );

/**
 * Database refusals (guard triggers and CHECKs raise 23514) become problems without echoing the
 * database message, which could quote identifiers. Unknown errors are rethrown unchanged.
 */
export function rethrowPaymentDbError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (isUniqueViolation(error))
    throw paymentConflict("payment-rule", "This conflicts with an existing payment record.");
  if (isCheckViolation(error) || isForeignKeyViolation(error) || hasDatabaseCode(error, ["P2004"]))
    throw paymentConflict("payment-rule", "The change breaks a payment rule.");
  throw error;
}

/** Credential changes, enabling payouts and reversals need MFA verified within five minutes. */
export function requireStepUp(auth: AuthService, principal: Principal) {
  if (!principal.user.mfaEnabled)
    throw new ForbiddenException({
      message: "Set up two-step verification before doing this.",
      code: "mfa-required",
    });
  auth.requireMfa(principal, true);
}

export const notFound = (what: string) => new NotFoundException(`${what} not found`);
export const unavailable = (message: string) => new ServiceUnavailableException(message);

/** Stable JSON (sorted keys, undefined dropped) for fingerprints and request digests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/**
 * Idempotency fingerprint (brief §15 D): binds the operation, the caller and the request body.
 * The company is part of the stored key, so the same key in another company is unrelated.
 */
export const requestFingerprint = (operation: string, userId: string, payload: unknown) =>
  sha256(canonicalJson({ operation, userId, payload }));

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** "PAY-" and eight upper-case hex digits from the random part of the request's UUIDv7. */
export const paymentReference = (requestId: string) =>
  `PAY-${requestId.replace(/-/g, "").slice(-8).toUpperCase()}`;

/** Minor units from a BigInt column (all payment amounts are bounded well inside 2^53). */
export const minor = (value: bigint | number): number => Number(value);

/**
 * Payments are company-wide in D4.2: each `payments.*` permission is project-scoped but not
 * project-assignable, so AccessPolicy.require only accepts it from a company-wide role. Passes
 * when any one of `permissions` is held that way.
 */
export async function requireOne(
  policy: AccessPolicy,
  scope: Scope,
  permissions: readonly Permission[],
): Promise<void> {
  for (const permission of permissions) {
    try {
      await policy.require(scope, permission);
      return;
    } catch {
      // try the next one
    }
  }
  throw new ForbiddenException(`One of these permissions is required: ${permissions.join(", ")}`);
}

export async function holds(policy: AccessPolicy, scope: Scope, permission: Permission) {
  try {
    await policy.require(scope, permission);
    return true;
  } catch {
    return false;
  }
}
