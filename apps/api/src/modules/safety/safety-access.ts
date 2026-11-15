import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly, nairobiDate, type PhotoPurpose } from "@pm-buddy/domain";
import {
  DEFAULT_PPE_REPLACEMENT_DAYS,
  DEFAULT_SAFETY_SETTINGS,
  PPE_ITEMS,
  SAFETY_READ_PERMISSIONS,
  SAFETY_RECORD_PERMISSIONS,
  STARTER_INDUCTION_TOPICS,
  type InductionTopic,
  type Permission,
  type PpeItem,
  type ProjectStatus,
} from "@pm-buddy/types";
import type { SafetyLabourer } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { customRoleColumns, type Scope } from "../identity/access-policy.js";
import { effectiveProjectPermissions, grantOf } from "../identity/role-grants.js";
import { ProjectAccess, versionConflict } from "../projects/project-access.js";
import type { ProjectRow } from "../projects/project-mappers.js";

type Tx = Prisma.TransactionClient;

/** Stable problem codes for the health and safety module (the web maps them to EN/SW messages). */
export type SafetyProblem =
  | "project-read-only"
  | "invalid-transition"
  | "safety-date-future"
  | "labourer-not-on-project"
  | "person-not-in-company"
  | "staff-not-on-project"
  | "photo-not-on-site"
  | "induction-topic-unknown"
  | "talk-no-attendees"
  | "gang-not-in-project"
  | "ppe-replacement-invalid"
  | "ppe-return-before-issue"
  | "incident-not-open"
  | "incident-close-blocked"
  | "incident-actions-outstanding"
  | "incident-follow-up-invalid"
  | "injured-person-required"
  | "near-miss-without-injury"
  | "action-owner-only"
  | "action-independent-verification"
  | "action-source-invalid"
  | "kit-label-taken"
  | "kit-retired"
  | "first-aider-exists"
  | "first-aider-not-on-site"
  | "treatment-linked"
  | "safety-rule";

export function safetyProblem(
  status: 403 | 404 | 409 | 422,
  code: SafetyProblem,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { code, message, ...extra };
  if (status === 403) return new ForbiddenException(body);
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  return new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY);
}

export { versionConflict };

/** The caller's view of a project's health and safety records (role ∩ assignment, project state). */
export type SafetyContext = {
  project: ProjectRow;
  effective: ReadonlySet<Permission>;
  readOnly: boolean;
  /** Record inductions, talks, PPE, incident reports, treatments and kit checks. */
  canRecord: boolean;
  /** safety.manage: investigate, raise and verify actions, close, void, manage first aid. */
  canManage: boolean;
  /** People and injury details on incidents and treatments (safety.manage, decision D-74). */
  canSeePersonal: boolean;
  userId: string;
};

export const hasAny = (effective: ReadonlySet<Permission>, permissions: readonly Permission[]) =>
  permissions.some((permission) => effective.has(permission));

/**
 * Health and safety access (ARCHITECTURE §4.9, decision D-70): reading needs projects.view plus a
 * site or project staff permission (SAFETY_READ_PERMISSIONS), so portal-only roles, labourers and
 * office roles without a site permission never see safety records; recording needs site.diary or
 * safety.manage; investigations, verification, closing, voiding and first-aid management need
 * safety.manage. Closed and cancelled projects are read-only.
 */
@Injectable()
export class SafetyAccess {
  constructor(private readonly access: ProjectAccess) {}

  async load(scope: Scope, projectId: string): Promise<SafetyContext> {
    const { project, effective } = await this.access.load(scope, projectId, "projects.view");
    if (!hasAny(effective, SAFETY_READ_PERMISSIONS))
      throw new ForbiddenException(
        `One of these permissions is required: ${SAFETY_READ_PERMISSIONS.join(", ")}`,
      );
    const readOnly = isProjectReadOnly(project.status as ProjectStatus);
    return {
      project,
      effective,
      readOnly,
      canRecord: !readOnly && hasAny(effective, SAFETY_RECORD_PERMISSIONS),
      canManage: !readOnly && effective.has("safety.manage"),
      canSeePersonal: effective.has("safety.manage"),
      userId: scope.access.userId,
    };
  }

  private static writable(context: SafetyContext, allowed: boolean, permission: string) {
    if (context.readOnly)
      throw safetyProblem(409, "project-read-only", "Closed and cancelled projects are read-only");
    if (!allowed) throw new ForbiddenException(`Permission required: ${permission}`);
    return context;
  }

  /** Any reader, on a writable project (the action's own rule decides, e.g. owners). */
  async participant(scope: Scope, projectId: string) {
    const context = await this.load(scope, projectId);
    return SafetyAccess.writable(context, true, "");
  }

  async recorder(scope: Scope, projectId: string) {
    const context = await this.load(scope, projectId);
    return SafetyAccess.writable(
      context,
      context.canRecord,
      SAFETY_RECORD_PERMISSIONS.join(" or "),
    );
  }

  async manager(scope: Scope, projectId: string) {
    const context = await this.load(scope, projectId);
    return SafetyAccess.writable(context, context.canManage, "safety.manage");
  }
}

/** Serialises numbering per project (the database triggers repeat the lock and the check). */
export const lockProject = (tx: Tx, tenantId: string, projectId: string) =>
  tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${tenantId}::uuid AND id = ${projectId}::uuid FOR UPDATE`;

/** Refuses a business date after today in Nairobi (409 safety-date-future). */
export const notFuture = (date: string) => {
  if (date > nairobiDate())
    throw safetyProblem(409, "safety-date-future", "This date cannot be later than today");
};
/** Refuses a moment more than five minutes ahead of the server clock. */
export const notFutureMoment = (iso: string) => {
  if (new Date(iso).getTime() > Date.now() + 5 * 60_000)
    throw safetyProblem(409, "safety-date-future", "This time cannot be in the future");
};

export async function siteNames(tx: Tx, tenantId: string, projectId: string) {
  const sites = await tx.site.findMany({
    where: { tenantId, projectId },
    select: { id: true, name: true },
  });
  return new Map(sites.map((site) => [site.id, site.name]));
}

export async function requireSite(tx: Tx, tenantId: string, projectId: string, siteId: string) {
  const site = await tx.site.findFirst({
    where: { tenantId, projectId, id: siteId },
    select: { id: true },
  });
  if (!site) throw new NotFoundException("Site not found in this project");
}

/** The company's safety settings, or the defaults (version 0). */
export async function safetySettings(tx: Tx, tenantId: string) {
  const row = await tx.safetySettings.findUnique({ where: { tenantId } });
  const stored = (row?.ppeReplacementDays ?? {}) as Partial<Record<PpeItem, number>>;
  return {
    inductionTopics:
      (row?.inductionTopics as InductionTopic[] | undefined) ??
      STARTER_INDUCTION_TOPICS.map((key) => ({ key, label: null })),
    inductionValidityDays: row
      ? row.inductionValidityDays
      : DEFAULT_SAFETY_SETTINGS.inductionValidityDays,
    inductionLookbackDays:
      row?.inductionLookbackDays ?? DEFAULT_SAFETY_SETTINGS.inductionLookbackDays,
    kitCheckIntervalDays: row?.kitCheckIntervalDays ?? DEFAULT_SAFETY_SETTINGS.kitCheckIntervalDays,
    ppeReplacementDays: Object.fromEntries(
      PPE_ITEMS.map((item) => [item, stored[item] ?? DEFAULT_PPE_REPLACEMENT_DAYS[item]]),
    ) as Record<PpeItem, number>,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
}
export type SafetySettingsValues = Awaited<ReturnType<typeof safetySettings>>;

/** Registry number and name of labourers (never identifiers or contact details). */
export async function labourerRefs(
  tx: Tx,
  tenantId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, SafetyLabourer>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = await tx.labourer.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, workerNo: true, fullName: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}
export const labourerOf = (refs: Map<string, SafetyLabourer>, id: string): SafetyLabourer =>
  refs.get(id) ?? { id, workerNo: "—", fullName: "—" };

/** Refuses labourers who were never engaged on the project (422 labourer-not-on-project). */
export async function requireProjectLabourers(
  tx: Tx,
  tenantId: string,
  projectId: string,
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const engaged = await tx.labourEngagement.findMany({
    where: { tenantId, projectId, labourerId: { in: unique } },
    select: { labourerId: true },
    distinct: ["labourerId"],
  });
  if (engaged.length !== unique.length)
    throw safetyProblem(
      422,
      "labourer-not-on-project",
      "A labourer is not engaged on this project",
    );
}

/** Refuses user IDs that are not members of the company (422 person-not-in-company). */
export async function requireCompanyUsers(tx: Tx, tenantId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await tx.membership.count({ where: { tenantId, userId: { in: unique } } });
  if (found !== unique.length)
    throw safetyProblem(422, "person-not-in-company", "A person is not a member of the company");
}

export type StaffMember = {
  id: string;
  displayName: string;
  effective: ReadonlySet<Permission>;
};

/**
 * Company members whose effective permissions on the project (role ∩ assignment) let them read
 * safety records: the people who can present a talk, induct, own an action or verify it.
 */
export async function projectStaff(scope: Scope, projectId: string): Promise<StaffMember[]> {
  const { tx, access } = scope;
  const [members, assignments] = await Promise.all([
    tx.membership.findMany({
      where: { tenantId: access.tenantId },
      select: { userId: true, ...customRoleColumns, user: { select: { displayName: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    tx.projectMembership.findMany({
      where: { tenantId: access.tenantId, projectId },
      select: { userId: true, permissions: true },
    }),
  ]);
  const assigned = new Map(assignments.map((row) => [row.userId, row.permissions]));
  return members
    .map((member) => ({
      id: member.userId,
      displayName: member.user.displayName,
      effective: effectiveProjectPermissions(grantOf(member), assigned.get(member.userId) ?? null),
    }))
    .filter(
      (member) =>
        member.effective.has("projects.view") && hasAny(member.effective, SAFETY_READ_PERMISSIONS),
    );
}

/** A staff member with one of `permissions` on the project (422 staff-not-on-project). */
export async function requireStaff(
  scope: Scope,
  projectId: string,
  userId: string,
  permissions: readonly Permission[],
) {
  const staff = await projectStaff(scope, projectId);
  const member = staff.find((entry) => entry.id === userId);
  if (!member || !hasAny(member.effective, permissions))
    throw safetyProblem(
      422,
      "staff-not-on-project",
      "This person cannot take that role on this project",
    );
  return member;
}

/**
 * Refuses photos that are not site photos of this site with the given purpose (422
 * photo-not-on-site): incident photos are uploaded as `safety_incident`, talk photos as `general`.
 */
export async function requireSitePhotos(
  tx: Tx,
  tenantId: string,
  projectId: string,
  siteId: string,
  ids: readonly string[],
  purpose: PhotoPurpose,
) {
  if (!ids.length) return;
  const found = await tx.sitePhoto.count({
    where: { tenantId, projectId, siteId, purpose, id: { in: [...ids] } },
  });
  if (found !== new Set(ids).size)
    throw safetyProblem(422, "photo-not-on-site", "A photo is not one of this site's photos");
}

/** IND-0001, TBT-0001, INC-0001, CA-0001, FA-0001. */
export const recordCode = (prefix: string, number: number) =>
  `${prefix}-${String(number).padStart(4, "0")}`;

/** "INC-12", "12" or "inc0012" → 12 for number searches. */
export const searchNumber = (search: string, prefix: string): number | null => {
  const match = new RegExp(`^(?:${prefix}-?)?0*(\\d{1,9})$`, "i").exec(search);
  return match ? Number(match[1]) : null;
};
