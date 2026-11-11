import { createHash } from "node:crypto";
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
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { AuthService, Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";

/** Stable problem codes for attendance and timesheets (the web maps them to EN/SW messages). */
export type AttendanceProblem =
  | "version-conflict"
  | "date-in-future"
  | "project-read-only"
  | "not-engaged"
  | "period-locked"
  | "period-overlap"
  | "day-not-draft"
  | "day-empty"
  | "invalid-transition"
  | "same-person"
  | "no-changes"
  | "correction-pending"
  | "correction-not-needed"
  | "correction-outdated"
  | "pending-corrections"
  | "period-not-due"
  | "unconfirmed-days"
  | "open-anomalies"
  | "rules-not-configured"
  | "rules-unverified"
  | "period-changed"
  | "period-not-approved"
  | "date-outside-period"
  | "adjustment-pending"
  | "no-target-period"
  | "use-correction"
  | "rule-exists"
  | "rule-in-force"
  | "holiday-exists"
  | "idempotency-key-reused"
  | "invalid-idempotency-key"
  | "mfa-required"
  | "site-not-in-project"
  | "attendance-rule";

export const attendanceConflict = (
  code: AttendanceProblem,
  message: string,
  match?: { labourerId: string },
) => new ConflictException({ message, code, ...(match ? { match } : {}) });
export const attendanceBadRequest = (code: AttendanceProblem, message: string) =>
  new BadRequestException({ message, code });
export const versionConflict = () =>
  attendanceConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );
export const samePerson = (message: string) => attendanceConflict("same-person", message);

/**
 * Maps database refusals (trigger and CHECK violations raise 23514) to problems without echoing the
 * database message. Unknown errors are rethrown unchanged.
 */
export function rethrowAttendanceDbError(error: unknown): never {
  if (
    error instanceof ConflictException ||
    error instanceof BadRequestException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  )
    throw error;
  if (isUniqueViolation(error))
    throw attendanceConflict("attendance-rule", "This conflicts with an existing record.");
  if (isCheckViolation(error) || isForeignKeyViolation(error) || hasDatabaseCode(error, ["P2004"]))
    throw attendanceConflict("attendance-rule", "The change breaks an attendance rule.");
  throw error;
}

/** Overrides need MFA verified within five minutes (`attendance.override.step_up`). */
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

/**
 * Attendance permissions are project-scoped (ARCHITECTURE §8): company-wide roles act on every
 * project; other roles act on assigned projects with role ∩ assignment. A project outside the
 * caller's company is 404.
 */
@Injectable()
export class AttendanceAccess {
  constructor(private readonly policy: AccessPolicy) {}

  /** Projects on which the caller holds `permission`; "all" for company-wide roles. */
  async projectsWith(scope: Scope, permission: Permission): Promise<ProjectSet> {
    const { access, tx } = scope;
    if (!access.permissions.has(permission)) return [];
    if (access.tenantWide) return "all";
    const rows = await tx.projectMembership.findMany({
      where: { tenantId: access.tenantId, userId: access.userId, permissions: { has: permission } },
      select: { projectId: true },
    });
    return rows.map((row) => row.projectId);
  }

  /** Project IDs (resolved) on which the caller holds `permission`. */
  async projectIds(scope: Scope, permission: Permission): Promise<string[]> {
    const set = await this.projectsWith(scope, permission);
    if (set !== "all") return [...set];
    const rows = await scope.tx.project.findMany({
      where: { tenantId: scope.access.tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** The project with `permission` on it (404 outside the company, 403 without it). */
  async project(
    scope: Scope,
    projectId: string,
    permission: Permission,
  ): Promise<{ project: ProjectRow; effective: ReadonlySet<Permission> }> {
    const effective = await this.policy.require(scope, permission, { projectId });
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
    });
    if (!project) throw new NotFoundException("Project not found");
    return { project, effective };
  }

  /** One of `permissions` on the project. */
  async projectAny(scope: Scope, projectId: string, permissions: readonly Permission[]) {
    const effective = await this.policy.requireAny(scope, permissions, { projectId });
    const project = await scope.tx.project.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
    });
    if (!project) throw new NotFoundException("Project not found");
    return { project, effective };
  }

  /** A company-level permission (config.manage). */
  requireCompany(scope: Scope, permission: Permission) {
    return this.policy.require(scope, permission);
  }

  assertWritable(project: ProjectRow) {
    if (isProjectReadOnly(project.status as ProjectStatus))
      throw attendanceConflict("project-read-only", "Closed and cancelled projects are read-only.");
  }
}

/** Stable JSON (sorted keys) for fingerprints and digests. */
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

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Commands that change attendance (WORKFLOWS shared rules): one serialised tenant transaction that
 * writes the change, its audit event, any outbox event and, when the client sent an
 * `Idempotency-Key`, the stored response. A retry with the same key and payload returns that
 * response (`Idempotent-Replayed: true`); the same key with another payload or user is a 409.
 */
@Injectable()
export class AttendanceCommands {
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
      throw attendanceBadRequest(
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
              throw attendanceConflict(
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
        30_000,
      )
      .catch((error: unknown) => rethrowAttendanceDbError(error));
  }

  /** Read-only work in the tenant transaction (no lock, no idempotency). */
  read<T>(principal: Principal, req: Request, query: (scope: Scope) => Promise<T>): Promise<T> {
    return this.scope.run(principal, req, query, false, 30_000);
  }

  audit(scope: Scope, action: string, resourceId: string, metadata: Prisma.InputJsonValue = {}) {
    return this.scope.audit(scope.tx, action, resourceId, metadata);
  }

  /** Writes a transactional outbox event (safe identifiers and counts only). */
  outbox(scope: Scope, topic: string, aggregateId: string, payload: Prisma.InputJsonValue = {}) {
    return scope.tx.outboxEvent.create({
      data: { tenantId: scope.access.tenantId, topic, aggregateId, payload },
    });
  }
}
