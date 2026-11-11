import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly } from "@pm-buddy/domain";
import type { Permission, ProjectStatus } from "@pm-buddy/types";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import type { ProjectRow } from "./project-mappers.js";

/** Stable problem codes for the projects module (the web maps them to EN/SW messages). */
export type ProjectProblem =
  | "version-conflict"
  | "project-read-only"
  | "project-code-taken"
  | "project-code-fixed"
  | "invalid-transition"
  | "reason-required"
  | "activation-incomplete"
  | "activation-details-required"
  | "end-before-start"
  | "site-name-taken"
  | "wbs-code-taken"
  | "wbs-cycle"
  | "wbs-too-deep"
  | "wbs-has-children"
  | "wbs-in-use"
  | "wbs-order-mismatch"
  | "milestone-name-taken"
  | "milestone-not-planned"
  | "actual-date-required"
  | "actual-date-future";

export const conflict = (code: ProjectProblem, message: string) =>
  new ConflictException({ message, code });
export const badRequest = (code: ProjectProblem, message: string) =>
  new BadRequestException({ message, code });
export const versionConflict = () =>
  conflict("version-conflict", "This record was changed by someone else. Reload and try again.");

/**
 * Resolves a project in the caller's company and checks a permission on it through AccessPolicy:
 * 404 when the project is not in the company, 403 without the permission (role ∩ assignment).
 */
@Injectable()
export class ProjectAccess {
  constructor(private readonly policy: AccessPolicy) {}

  async load(
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

  /** For changes: projects.manage, and the project must not be closed or cancelled (409). */
  async editable(scope: Scope, projectId: string) {
    const result = await this.load(scope, projectId, "projects.manage");
    if (isProjectReadOnly(result.project.status as ProjectStatus))
      throw conflict("project-read-only", "Closed and cancelled projects are read-only");
    return result;
  }
}
