import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import type { Permission, ProjectStatus } from "@pm-buddy/types";
import {
  hasDatabaseCode,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "../../common/database-errors.js";
import type { Scope } from "../identity/access-policy.js";
import { effectiveProjectPermissions } from "../identity/role-grants.js";

/** Stable problem codes for reports, the dashboard and subscriptions (the web maps them). */
export type ReportProblem =
  | "report-forbidden"
  | "report-not-available"
  | "report-parameter-invalid"
  | "project-required"
  | "site-required"
  | "batch-required"
  | "period-required"
  | "period-invalid"
  | "period-too-long"
  | "use-excel"
  | "report-too-large"
  | "subscription-exists"
  | "subscription-limit"
  | "email-required"
  | "version-conflict"
  | "invalid-transition"
  | "scheduler-busy"
  | "report-rule";

export function reportProblem(
  status: 400 | 403 | 404 | 409 | 422,
  code: ReportProblem,
  message: string,
): HttpException {
  const body = { code, message };
  if (status === 403) return new ForbiddenException(body);
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  return new HttpException(
    body,
    status === 400 ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * Who may run a report (INVARIANTS "Reports"): `reports.view` and one of `project` on the same
 * project (role ∩ assignment), or a company-level `companyAlso` permission that the source screen
 * also accepts (procurement.manage_suppliers for procure-to-pay); company reports need `company`
 * (company-level) and `reports.view` somewhere. `stepUp` repeats the source screen's MFA check.
 */
export type ReportRule = {
  project?: readonly Permission[];
  /** Every one of these on the project as well (the safety screens also need projects.view). */
  alsoProject?: readonly Permission[];
  companyAlso?: readonly Permission[];
  company?: Permission;
  stepUp?: boolean;
};

export type ReportProject = {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  effective: ReadonlySet<Permission>;
};

/**
 * The caller's permissions on every project of the company (role ∩ assignment), computed once per
 * request, with the report rules applied the same way for the list, the options, the report and
 * the scheduler's check.
 */
export class ReportCaller {
  constructor(
    readonly userId: string,
    readonly tenantWide: boolean,
    readonly role: ReadonlySet<Permission>,
    readonly projects: ReadonlyMap<string, ReportProject>,
  ) {}

  /** reports.view and the source permission on the project. */
  canOn(projectId: string, rule: ReportRule): boolean {
    const project = this.projects.get(projectId);
    if (!project || !rule.project) return false;
    if (!project.effective.has("reports.view")) return false;
    if (!(rule.alsoProject ?? []).every((permission) => project.effective.has(permission)))
      return false;
    return (
      rule.project.some((permission) => project.effective.has(permission)) ||
      (rule.companyAlso ?? []).some((permission) => this.role.has(permission))
    );
  }

  /** The projects the caller may run a project report for, by code. */
  projectsFor(rule: ReportRule): ReportProject[] {
    return [...this.projects.values()].filter((project) => this.canOn(project.id, rule));
  }

  /** reports.view on some project (or company-wide). */
  get reportsSomewhere(): boolean {
    if (this.tenantWide) return this.role.has("reports.view");
    return [...this.projects.values()].some((project) => project.effective.has("reports.view"));
  }

  /** A company report: its company-level permission and reports.view somewhere. */
  canCompany(rule: ReportRule): boolean {
    return !!rule.company && this.role.has(rule.company) && this.reportsSomewhere;
  }

  /** Any of `permissions` on the project (role ∩ assignment), without reports.view. */
  holdsOn(projectId: string, permissions: readonly Permission[]): boolean {
    const project = this.projects.get(projectId);
    return !!project && permissions.some((permission) => project.effective.has(permission));
  }
}

@Injectable()
export class ReportsAccess {
  /** Every project of the company the caller has any permission on (one query). */
  async caller(scope: Scope): Promise<ReportCaller> {
    const { tx, access } = scope;
    const rows = await tx.project.findMany({
      where: { tenantId: access.tenantId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        members: { where: { userId: access.userId }, select: { permissions: true } },
      },
      orderBy: { code: "asc" },
    });
    const projects = new Map<string, ReportProject>();
    for (const row of rows) {
      const assigned = row.members[0]?.permissions ?? null;
      if (!access.tenantWide && assigned === null) continue;
      projects.set(row.id, {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status as ProjectStatus,
        effective: effectiveProjectPermissions(access, assigned),
      });
    }
    return new ReportCaller(access.userId, access.tenantWide, access.permissions, projects);
  }
}

/**
 * A database refusal the API's own checks did not catch first (a trigger, a unique key, a
 * privilege) becomes a problem, never a 500; the database message is never echoed.
 */
export function reportsDatabaseProblem(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  if (isUniqueViolation(error))
    return reportProblem(409, "subscription-exists", "You already have this subscription.");
  if (isCheckViolation(error) || isForeignKeyViolation(error))
    return reportProblem(409, "report-rule", "The change breaks a reports rule.");
  if (hasDatabaseCode(error, ["42501"]))
    return reportProblem(403, "report-rule", "This record cannot be changed.");
  return null;
}

/** Applies reportsDatabaseProblem to every reports endpoint. */
@Injectable()
export class ReportsDatabaseErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) => throwError(() => reportsDatabaseProblem(error) ?? error)),
      );
  }
}
