import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly } from "@pm-buddy/domain";
import type { Permission, ProjectStatus } from "@pm-buddy/types";
import type { Request } from "express";
import { AppConfig } from "../../config/app-config.js";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { canonicalJson, sha256 } from "../attendance/attendance-support.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { AuthService, Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";

/** Stable problem codes for payroll (the web maps them to EN/SW messages). */
export type PayrollProblem =
  | "version-conflict"
  | "idempotency-key-reused"
  | "invalid-idempotency-key"
  | "mfa-required"
  | "project-read-only"
  | "same-person"
  | "invalid-transition"
  | "date-in-future"
  | "rules-not-configured"
  | "rules-unverified"
  | "rule-exists"
  | "rule-in-closed-period"
  | "rule-in-use"
  | "rule-verified"
  | "minimum-wage-exists"
  | "not-engaged"
  | "gang-empty"
  | "bq-item-not-in-project"
  | "allowance-ended"
  | "advance-over-limit"
  | "advance-outstanding-limit"
  | "period-not-in-calendar"
  | "period-not-started"
  | "period-overlap"
  | "batch-exists"
  | "batch-stale"
  | "batch-empty"
  | "nothing-to-export"
  | "payroll-rule";

export const payrollConflict = (code: PayrollProblem, message: string) =>
  new ConflictException({ message, code });
export const payrollBadRequest = (code: PayrollProblem, message: string) =>
  new BadRequestException({ message, code });
export const versionConflict = () =>
  payrollConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const samePerson = (message: string) => payrollConflict("same-person", message);

/**
 * Maps database refusals (trigger and CHECK violations raise 23514) to problems without echoing the
 * database message. Unknown errors are rethrown unchanged.
 */
export function rethrowPayrollDbError(error: unknown): never {
  if (
    error instanceof ConflictException ||
    error instanceof BadRequestException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  )
    throw error;
  if (isUniqueViolation(error))
    throw payrollConflict("payroll-rule", "This conflicts with an existing payroll record.");
  if (isCheckViolation(error) || isForeignKeyViolation(error) || hasDatabaseCode(error, ["P2004"]))
    throw payrollConflict("payroll-rule", "The change breaks a payroll rule.");
  throw error;
}

/** Statutory rule verification, exports and advance payments need MFA verified within 5 minutes. */
export function requireStepUp(auth: AuthService, principal: Principal) {
  if (!principal.user.mfaEnabled)
    throw new ForbiddenException({
      message: "Set up two-step verification before doing this.",
      code: "mfa-required",
    });
  auth.requireMfa(principal, true);
}

export type ProjectSet = "all" | readonly string[];
export const inProjects = (set: ProjectSet, projectId: string) =>
  set === "all" || set.includes(projectId);

type ProjectRow = Prisma.ProjectGetPayload<object>;

/** Viewing payroll: payroll.view, or preparing it. */
export const PAYROLL_VIEW: readonly Permission[] = ["payroll.view", "payroll.prepare"];

/**
 * Payroll permissions are project-scoped like attendance (ARCHITECTURE §8): company-wide roles act
 * on every project; other roles on assigned projects with role ∩ assignment. Rule management,
 * verification and exports are company-level. A project outside the caller's company is 404.
 */
@Injectable()
export class PayrollAccess {
  constructor(
    private readonly policy: AccessPolicy,
    private readonly config: AppConfig,
  ) {}

  /** Production refuses unverified rules (COMPLIANCE-REVIEW, INVARIANTS); read at call time. */
  get production(): boolean {
    return this.config.isProduction;
  }

  /** Projects on which the caller holds any of `permissions`; "all" for company-wide roles. */
  async projectsWithAny(scope: Scope, permissions: readonly Permission[]): Promise<ProjectSet> {
    const { access, tx } = scope;
    const held = permissions.filter((permission) => access.permissions.has(permission));
    if (!held.length) return [];
    if (access.tenantWide) return "all";
    const rows = await tx.projectMembership.findMany({
      where: {
        tenantId: access.tenantId,
        userId: access.userId,
        permissions: { hasSome: [...held] },
      },
      select: { projectId: true },
    });
    return rows.map((row) => row.projectId);
  }

  /** The projects (rows) on which the caller holds any of `permissions`, by code. */
  async projects(scope: Scope, permissions: readonly Permission[]) {
    const set = await this.projectsWithAny(scope, permissions);
    if (set !== "all" && !set.length) return [];
    return scope.tx.project.findMany({
      where: {
        tenantId: scope.access.tenantId,
        ...(set === "all" ? {} : { id: { in: [...set] } }),
      },
      orderBy: { code: "asc" },
    });
  }

  /** The project with one of `permissions` on it (404 outside the company, 403 without them). */
  async project(
    scope: Scope,
    projectId: string,
    permissions: readonly Permission[],
  ): Promise<{ project: ProjectRow; effective: ReadonlySet<Permission> }> {
    const effective = await this.policy.requireAny(scope, permissions, { projectId });
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
    });
    if (!project) throw new NotFoundException("Project not found");
    return { project, effective };
  }

  /** Effective permissions on a project without requiring any. */
  async effectiveOn(scope: Scope, projectId: string): Promise<ReadonlySet<Permission>> {
    try {
      return await this.policy.requireAny(scope, [...scope.access.permissions], { projectId });
    } catch (error) {
      if (error instanceof ForbiddenException) return new Set();
      throw error;
    }
  }

  /** A company-level permission. */
  company(scope: Scope, permission: Permission) {
    return this.policy.require(scope, permission);
  }

  /** Any one of several company-level permissions. */
  companyAny(scope: Scope, permissions: readonly Permission[]) {
    return this.policy.requireAny(scope, permissions);
  }

  assertWritable(project: ProjectRow) {
    if (isProjectReadOnly(project.status as ProjectStatus))
      throw payrollConflict("project-read-only", "Closed and cancelled projects are read-only.");
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Payroll commands (WORKFLOWS shared rules): one serialised tenant transaction that writes the
 * change, its redacted audit event, any outbox event and, when the client sent an
 * `Idempotency-Key`, the stored response. The key binds company, operation, caller and a payload
 * fingerprint; the same key with another payload or caller is a 409.
 */
@Injectable()
export class PayrollCommands {
  constructor(private readonly scope: TenantScope) {}

  run<T>(
    principal: Principal,
    req: Request,
    operation: string,
    payload: unknown,
    command: (scope: Scope) => Promise<T>,
  ): Promise<T> {
    const header = req.headers["idempotency-key"];
    const key = typeof header === "string" ? header : undefined;
    if (header !== undefined && (!key || !IDEMPOTENCY_KEY.test(key)))
      throw payrollBadRequest(
        "invalid-idempotency-key",
        "Idempotency-Key must be 8–128 letters, digits, '-' or '_'.",
      );
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          if (!key) return command(scope);
          const { tx, access } = scope;
          const fingerprint = sha256(canonicalJson({ operation, userId: access.userId, payload }));
          const stored = await tx.idempotencyRecord.findUnique({
            where: {
              tenantId_operation_idempotencyKey: {
                tenantId: access.tenantId,
                operation,
                idempotencyKey: key,
              },
            },
          });
          if (stored) {
            if (stored.fingerprint !== fingerprint)
              throw payrollConflict(
                "idempotency-key-reused",
                "This Idempotency-Key was already used for a different request.",
              );
            req.res?.setHeader("Idempotent-Replayed", "true");
            return stored.response as T;
          }
          const result = await command(scope);
          await tx.idempotencyRecord.create({
            data: {
              tenantId: access.tenantId,
              operation,
              idempotencyKey: key,
              userId: access.userId,
              fingerprint,
              response: result as Prisma.InputJsonValue,
            },
          });
          return result;
        },
        true,
        60_000,
      )
      .catch((error: unknown) => rethrowPayrollDbError(error));
  }

  /** Read-only work in the tenant transaction (no lock, no idempotency). */
  read<T>(principal: Principal, req: Request, query: (scope: Scope) => Promise<T>): Promise<T> {
    return this.scope.run(principal, req, query, false, 30_000);
  }

  /** Redacted audit: identifiers, codes, counts and digests only (never amounts or notes). */
  audit(scope: Scope, action: string, resourceId: string, metadata: Prisma.InputJsonValue = {}) {
    return this.scope.audit(scope.tx, action, resourceId, metadata);
  }

  /** A transactional outbox event (safe identifiers and counts only). */
  outbox(scope: Scope, topic: string, aggregateId: string, payload: Prisma.InputJsonValue = {}) {
    return scope.tx.outboxEvent.create({
      data: { tenantId: scope.access.tenantId, topic, aggregateId, payload },
    });
  }
}

export { canonicalJson, sha256 };

/** BIGINT money columns as JSON-safe numbers (amounts stay far below 2^53). */
export const money = (value: bigint | number): number => {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(result)) throw new RangeError("Amount out of range");
  return result;
};
