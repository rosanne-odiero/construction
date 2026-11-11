import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectPermission, type Permission } from "@pm-buddy/types";
import type { LabourerMatch } from "@pm-buddy/validation";
import {
  hasDatabaseCode,
  isCheckViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import { AppConfig } from "../../config/app-config.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { AuthService, Principal } from "../identity/auth.service.js";
import { effectiveProjectPermissions } from "../identity/role-grants.js";
import {
  FieldCipher,
  parseFieldKeys,
  type BlindIndexPurpose,
  type FieldContext,
} from "./field-cipher.js";

/** Stable problem codes for the labour module (the web maps them to EN/SW messages). */
export type LabourProblem =
  | "version-conflict"
  | "under-minimum-age"
  | "duplicate-identity"
  | "kra-pin-taken"
  | "do-not-rehire-match"
  | "do-not-rehire-unchanged"
  | "notice-not-current"
  | "consent-current"
  | "consent-withdrawn"
  | "consent-not-active"
  | "trade-inactive"
  | "skill-level-inactive"
  | "trade-key-taken"
  | "skill-level-key-taken"
  | "already-engaged"
  | "not-engaged"
  | "engagement-ended"
  | "end-before-start"
  | "date-in-future"
  | "labourer-left"
  | "invalid-status-change"
  | "already-in-gang"
  | "gang-archived"
  | "gang-has-members"
  | "gang-name-taken"
  | "leader-not-member"
  | "leader-must-change"
  | "membership-ended"
  | "rate-backdated"
  | "rate-in-force"
  | "rate-exists"
  | "project-read-only"
  | "site-not-in-project"
  | "view-name-taken"
  | "view-limit"
  | "mfa-required"
  | "labour-rule";

export const labourConflict = (code: LabourProblem, message: string, match?: LabourerMatch) =>
  new ConflictException({ message, code, ...(match ? { match } : {}) });
export const labourBadRequest = (code: LabourProblem, message: string) =>
  new BadRequestException({ message, code });
export const versionConflict = () =>
  labourConflict(
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );

/**
 * Maps database refusals to problems without echoing the database message (a failing row could
 * contain ciphertext). Unknown errors are rethrown unchanged.
 */
export function rethrowLabourDbError(error: unknown, uniqueCode: LabourProblem): never {
  if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
  if (isUniqueViolation(error))
    throw labourConflict(uniqueCode, "This conflicts with an existing record.");
  if (isCheckViolation(error) || hasDatabaseCode(error, ["P2004", "23P01"]))
    throw labourConflict("labour-rule", "The change breaks a labour registry rule.");
  throw error;
}

/**
 * Sensitive labour actions (reveal, do-not-rehire) need MFA verified within five minutes. Someone
 * without any MFA factor cannot step up, so they get a distinct code telling them to enrol first.
 */
export function requireStepUp(auth: AuthService, principal: Principal) {
  if (!principal.user.mfaEnabled)
    throw new ForbiddenException({
      message: "Set up two-step verification before doing this.",
      code: "mfa-required",
    });
  auth.requireMfa(principal, true);
}

/** UUIDv7 (RFC 9562): time-ordered IDs chosen before insert, because ciphertexts bind the row ID. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type LabourerColumn =
  | "id_number_enc"
  | "phone_enc"
  | "kra_pin_enc"
  | "nssf_number_enc"
  | "sha_number_enc"
  | "next_of_kin_enc";

/** Field encryption and blind indexes for the labour tables (keys from configuration). */
@Injectable()
export class LabourCrypto {
  readonly cipher: FieldCipher;

  constructor(config: AppConfig) {
    this.cipher = new FieldCipher(
      parseFieldKeys(
        config.get("FIELD_ENCRYPTION_KEYS"),
        config.get("FIELD_ENCRYPTION_ACTIVE_KEY_VERSION"),
        config.get("FIELD_BLIND_INDEX_KEY"),
      ),
    );
  }

  private context(tenantId: string, labourerId: string, column: LabourerColumn): FieldContext {
    return { tenantId, table: "labourers", column, rowId: labourerId };
  }

  seal(tenantId: string, labourerId: string, column: LabourerColumn, value: string) {
    return this.cipher.encrypt(this.context(tenantId, labourerId, column), value);
  }

  open(tenantId: string, labourerId: string, column: LabourerColumn, value: Uint8Array): string {
    return this.cipher.decrypt(this.context(tenantId, labourerId, column), value);
  }

  sealReason(tenantId: string, eventId: string, reason: string) {
    return this.cipher.encrypt(
      { tenantId, table: "do_not_rehire_events", column: "reason_enc", rowId: eventId },
      reason,
    );
  }

  openReason(tenantId: string, eventId: string, value: Uint8Array): string {
    return this.cipher.decrypt(
      { tenantId, table: "do_not_rehire_events", column: "reason_enc", rowId: eventId },
      value,
    );
  }

  index(tenantId: string, purpose: BlindIndexPurpose, canonical: string): string {
    return this.cipher.blindIndex(tenantId, purpose, canonical);
  }

  idIndex(tenantId: string, idType: string, idNumber: string): string {
    return this.index(tenantId, "id", `${idType}:${idNumber}`);
  }
}

export type ProjectSet = "all" | readonly string[];
export const inProjects = (set: ProjectSet, projectId: string) =>
  set === "all" || set.includes(projectId);
export const isEmpty = (set: ProjectSet) => set !== "all" && set.length === 0;

/**
 * Project-scoped labour permissions (ARCHITECTURE §8): company-wide roles act on every labourer;
 * other roles act on labourers engaged (now or before) on projects where they hold the permission
 * (role ∩ assignment). A labourer the caller cannot view is "not found".
 */
@Injectable()
export class LabourAccess {
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

  async requireSomewhere(scope: Scope, permission: Permission): Promise<ProjectSet> {
    const projects = await this.projectsWith(scope, permission);
    if (isEmpty(projects)) throw new ForbiddenException(`Permission required: ${permission}`);
    return projects;
  }

  /** Requires `permission` on the project (404 outside the company, 403 without it). */
  requireOnProject(scope: Scope, permission: Permission, projectId: string, stepUp = false) {
    return this.policy.require(scope, permission, { projectId, stepUp });
  }

  /** A project-scoped permission used without a project: needs a company-wide role. */
  requireCompanyWide(scope: Scope, permission: Permission) {
    return this.policy.require(scope, permission);
  }

  /** Requires one of `permissions` on the project. */
  requireAnyOnProject(scope: Scope, permissions: readonly Permission[], projectId: string) {
    return this.policy.requireAny(scope, permissions, { projectId });
  }

  /** The caller's effective labour permissions on a labourer engaged on `projectIds`. */
  async effectiveOn(scope: Scope, projectIds: readonly string[]): Promise<Set<Permission>> {
    const { access, tx } = scope;
    if (access.tenantWide)
      return new Set(
        [...access.permissions].filter((permission) => isProjectPermission(permission)),
      );
    const effective = new Set<Permission>();
    if (!projectIds.length) return effective;
    const assignments = await tx.projectMembership.findMany({
      where: {
        tenantId: access.tenantId,
        userId: access.userId,
        projectId: { in: [...projectIds] },
      },
      select: { permissions: true },
    });
    for (const { permissions } of assignments)
      for (const permission of effectiveProjectPermissions(access, permissions))
        effective.add(permission);
    return effective;
  }

  /**
   * Loads a labourer the caller may view and their effective permissions on it (404 when the
   * labourer is not in the company or not visible to the caller). Relations are loaded separately
   * by callers: one transaction connection runs one query at a time.
   */
  async labourer(
    scope: Scope,
    labourerId: string,
  ): Promise<{
    row: Prisma.LabourerGetPayload<object>;
    effective: Set<Permission>;
    projectIds: string[];
  }> {
    const row = await scope.tx.labourer.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: labourerId } },
    });
    if (!row) throw new NotFoundException("Labourer not found");
    const engagements = await scope.tx.labourEngagement.findMany({
      where: { tenantId: scope.access.tenantId, labourerId },
      select: { projectId: true },
    });
    const projectIds = [...new Set(engagements.map((engagement) => engagement.projectId))];
    const effective = await this.effectiveOn(scope, projectIds);
    if (!effective.has("labour.view")) throw new NotFoundException("Labourer not found");
    return { row, effective, projectIds };
  }

  /** 403 unless the caller holds `permission` on the labourer. */
  demand(scope: Scope, effective: ReadonlySet<Permission>, permission: Permission) {
    if (!effective.has(permission))
      throw new ForbiddenException(`Permission required: ${permission}`);
  }
}
