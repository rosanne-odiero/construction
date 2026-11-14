import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly, nairobiDate } from "@pm-buddy/domain";
import {
  DEFAULT_QUALITY_SETTINGS,
  QUALITY_READ_PERMISSIONS,
  QUALITY_RECORD_PERMISSIONS,
  type Permission,
  type ProjectStatus,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { ProjectAccess, versionConflict } from "../projects/project-access.js";
import type { ProjectRow } from "../projects/project-mappers.js";

type Tx = Prisma.TransactionClient;

/** Stable problem codes for the quality module (the web maps them to EN/SW messages). */
export type QualityProblem =
  | "project-read-only"
  | "invalid-transition"
  | "reason-required"
  | "quality-date-future"
  | "template-not-current"
  | "template-retired"
  | "inspection-not-draft"
  | "inspection-incomplete"
  | "inspection-author-required"
  | "inspection-independent-review"
  | "inspection-item-unknown"
  | "photo-not-in-project"
  | "bq-item-not-found"
  | "snag-not-open"
  | "snag-item-not-failed"
  | "snag-independent-verification"
  | "cube-set-void"
  | "cube-result-exists"
  | "cube-result-superseded"
  | "cube-tested-before-cast"
  | "slump-test-superseded"
  | "completion-exists"
  | "completion-open-critical-snags"
  | "completion-open-snags"
  | "completion-practical-required"
  | "completion-dlp-not-ended"
  | "completion-independent";

export function qualityProblem(
  status: 403 | 404 | 409 | 422,
  code: QualityProblem,
  message: string,
): HttpException {
  if (status === 403) return new ForbiddenException({ code, message });
  if (status === 404) return new NotFoundException({ code, message });
  if (status === 409) return new ConflictException({ code, message });
  return new HttpException({ code, message }, HttpStatus.UNPROCESSABLE_ENTITY);
}

export { versionConflict };

/** The caller's view of a project's quality records (role ∩ assignment, project state). */
export type QualityContext = {
  project: ProjectRow;
  effective: ReadonlySet<Permission>;
  readOnly: boolean;
  /** Record inspections, tests, snags and fixes (site.diary or quality.manage). */
  canRecord: boolean;
  /** Sign off, verify snags, certify completion, correct results (quality.manage). */
  canReview: boolean;
  /** Propose completion (projects.manage). */
  canPropose: boolean;
  userId: string;
};

export const hasAny = (effective: ReadonlySet<Permission>, permissions: readonly Permission[]) =>
  permissions.some((permission) => effective.has(permission));

/**
 * Quality access (ARCHITECTURE §4.7, decision D-60): reading needs projects.view plus a working
 * permission (QUALITY_READ_PERMISSIONS), so portal-only roles never see internal quality records;
 * recording needs site.diary or quality.manage; independent sign-offs need quality.manage; proposing
 * completion needs projects.manage. Closed and cancelled projects are read-only.
 */
@Injectable()
export class QualityAccess {
  constructor(private readonly access: ProjectAccess) {}

  async load(scope: Scope, projectId: string): Promise<QualityContext> {
    const { project, effective } = await this.access.load(scope, projectId, "projects.view");
    if (!hasAny(effective, QUALITY_READ_PERMISSIONS))
      throw new ForbiddenException(
        `One of these permissions is required: ${QUALITY_READ_PERMISSIONS.join(", ")}`,
      );
    const readOnly = isProjectReadOnly(project.status as ProjectStatus);
    return {
      project,
      effective,
      readOnly,
      canRecord: !readOnly && hasAny(effective, QUALITY_RECORD_PERMISSIONS),
      canReview: !readOnly && effective.has("quality.manage"),
      canPropose: !readOnly && effective.has("projects.manage"),
      userId: scope.access.userId,
    };
  }

  private static writable(context: QualityContext, allowed: boolean, permission: string) {
    if (context.readOnly)
      throw qualityProblem(409, "project-read-only", "Closed and cancelled projects are read-only");
    if (!allowed) throw new ForbiddenException(`Permission required: ${permission}`);
    return context;
  }

  async recorder(scope: Scope, projectId: string) {
    const context = await this.load(scope, projectId);
    return QualityAccess.writable(
      context,
      context.canRecord,
      QUALITY_RECORD_PERMISSIONS.join(" or "),
    );
  }

  async reviewer(scope: Scope, projectId: string) {
    const context = await this.load(scope, projectId);
    return QualityAccess.writable(context, context.canReview, "quality.manage");
  }

  async proposer(scope: Scope, projectId: string) {
    const context = await this.load(scope, projectId);
    return QualityAccess.writable(context, context.canPropose, "projects.manage");
  }
}

/** Serialises numbering and completion checks per project (the database repeats the lock). */
export const lockProject = (tx: Tx, tenantId: string, projectId: string) =>
  tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${tenantId}::uuid AND id = ${projectId}::uuid FOR UPDATE`;

export const futureDate = (date: string) => {
  if (date > nairobiDate())
    throw qualityProblem(409, "quality-date-future", "This date cannot be later than today");
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

/** The company's quality settings, or the defaults. */
export async function qualitySettings(tx: Tx, tenantId: string) {
  const row = await tx.qualitySettings.findUnique({ where: { tenantId } });
  return {
    dlpMonths: row?.dlpMonths ?? DEFAULT_QUALITY_SETTINGS.dlpMonths,
    cubeOverdueGraceDays:
      row?.cubeOverdueGraceDays ?? DEFAULT_QUALITY_SETTINGS.cubeOverdueGraceDays,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Refuses a photo ID that is not one of this project's site photos (422). */
export async function requireProjectPhotos(
  tx: Tx,
  tenantId: string,
  projectId: string,
  ids: readonly string[],
) {
  if (!ids.length) return;
  const found = await tx.sitePhoto.count({
    where: { tenantId, projectId, purpose: "general", id: { in: [...ids] } },
  });
  if (found !== new Set(ids).size)
    throw qualityProblem(
      422,
      "photo-not-in-project",
      "A photo is not one of this project's photos",
    );
}

/** INS-0001, SNG-0001, CUBE-0001, SLP-0001. */
export const recordCode = (prefix: string, number: number) =>
  `${prefix}-${String(number).padStart(4, "0")}`;
