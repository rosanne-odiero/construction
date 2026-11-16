import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { maskPhone } from "@pm-buddy/domain";
import {
  PAYOUT_ACTION_RULES,
  type Permission,
  type PayoutAction,
  type PayoutProblem,
  type ProblemFactKey,
} from "@pm-buddy/types";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthService } from "../identity/auth.service.js";
import { requireStepUp } from "../payroll/payroll-support.js";

type Tx = Prisma.TransactionClient;
export type Facts = Partial<Record<ProblemFactKey, number | string | boolean | null | string[]>>;

/**
 * A D4.3 problem with a stable code (packages/types PAYOUT_PROBLEMS) and, where it helps the
 * person decide, safe figures (`facts`, allowlisted again by the problem filter).
 */
export const payoutProblem = (status: number, code: PayoutProblem, message: string, facts?: Facts) =>
  new HttpException({ code, message, ...(facts ? { facts } : {}) }, status);
export const payoutConflict = (code: PayoutProblem, message: string, facts?: Facts) =>
  payoutProblem(409, code, message, facts);
export const payoutForbidden = (code: PayoutProblem, message: string, facts?: Facts) =>
  payoutProblem(403, code, message, facts);
export const makerChecker = (message: string) => payoutForbidden("maker-checker", message);
export const payoutVersionConflict = () =>
  payoutConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const notFound = (what: string) => new NotFoundException(`${what} not found`);

/**
 * Database refusals (guard triggers and CHECKs raise 23514) become problems without echoing the
 * database message; the live-payout index becomes `payout-in-flight`. Unknown errors rethrow.
 */
export function rethrowPayoutDbError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (isUniqueViolation(error)) {
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
    if (/payroll_payouts_one_live/.test(text))
      throw payoutConflict("payout-in-flight", "A payment towards this obligation is in progress.");
    throw payoutConflict("payout-rule", "This conflicts with an existing payout record.");
  }
  if (isCheckViolation(error) || isForeignKeyViolation(error) || hasDatabaseCode(error, ["P2004"]))
    throw payoutConflict("payout-rule", "The change breaks a payout rule.");
  throw error;
}

/** "KIL-001-20261109": the project code and the period start, never personal data (≤ 30). */
export const batchReference = (projectCode: string, periodStart: string) =>
  `${projectCode}-${periodStart.replace(/-/g, "")}`;

/** "2547•••••149" for a canonical number; "o•••@example.test" for an email address. */
export function maskRecipient(recipient: string): string {
  if (!recipient.includes("@")) return maskPhone(recipient);
  const [local, domain] = recipient.split("@");
  return `${(local ?? "").slice(0, 1)}•••@${domain ?? ""}`.slice(0, 40);
}

/** Money columns as JSON-safe numbers. */
export const minor = (value: bigint | number | null | undefined): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of range");
  return result;
};

/** The caller's system role is owner (custom roles never are). */
export const isOwner = (scope: Scope) =>
  scope.access.role === "owner" && scope.access.customRoleId === null;

/**
 * Who may do what in D4.3 (PAYOUT_ACTION_RULES: one of `anyOf`, a fresh step-up, the owner system
 * role). Payroll permissions are checked on the batch's project when one is given (company-wide
 * roles, or role ∩ assignment); payments and configuration permissions are company-wide (D4.2:
 * `payments.*` is not project-assignable).
 */
@Injectable()
export class PayoutAccess {
  constructor(
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
  ) {}

  /** The permissions of `anyOf` the caller holds (on the project, or company-wide). */
  async held(
    scope: Scope,
    anyOf: readonly Permission[],
    projectId?: string,
  ): Promise<Set<Permission>> {
    const held = new Set<Permission>();
    if (projectId) {
      try {
        const effective = await this.policy.requireAny(scope, anyOf, { projectId });
        for (const permission of anyOf) if (effective.has(permission)) held.add(permission);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
      return held;
    }
    for (const permission of anyOf) {
      try {
        await this.policy.require(scope, permission);
        held.add(permission);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    return held;
  }

  /** Whether the caller may do `action` (without the step-up). */
  async allows(scope: Scope, action: PayoutAction, projectId?: string): Promise<boolean> {
    const rule = PAYOUT_ACTION_RULES[action];
    if (rule.ownerOnly && !isOwner(scope)) return false;
    return (await this.held(scope, rule.anyOf, projectId)).size > 0;
  }

  /** MFA verified within five minutes (403 mfa-required / step-up-required otherwise). */
  stepUp(scope: Scope): void {
    requireStepUp(this.auth, scope.principal);
  }

  /** 403 unless the caller may do `action`, with the fresh step-up when the rule needs it. */
  async require(scope: Scope, action: PayoutAction, projectId?: string): Promise<void> {
    const rule = PAYOUT_ACTION_RULES[action];
    if ((await this.held(scope, rule.anyOf, projectId)).size === 0)
      throw new ForbiddenException(
        `One of these permissions is required: ${rule.anyOf.join(", ")}`,
      );
    if (rule.ownerOnly && !isOwner(scope))
      throw payoutForbidden("owner-only", "Only a member whose role is owner can do this.");
    if (rule.stepUp) requireStepUp(this.auth, scope.principal);
  }
}

/** Locks a batch's row first, so its derived status is recomputed one change at a time. */
export async function lockBatch(tx: Tx, tenantId: string, batchId: string) {
  await tx.$queryRaw`SELECT id FROM payroll_batches WHERE tenant_id = ${tenantId}::uuid
    AND id = ${batchId}::uuid FOR UPDATE`;
}
