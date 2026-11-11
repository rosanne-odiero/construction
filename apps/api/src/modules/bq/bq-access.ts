import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly } from "@pm-buddy/domain";
import type { Permission, ProjectStatus } from "@pm-buddy/types";
import type { Scope } from "../identity/access-policy.js";
import { ProjectAccess } from "../projects/project-access.js";

/** Stable problem codes for the BQ module (the web maps them to EN/SW messages). */
export type BqProblem =
  | "version-conflict"
  | "project-read-only"
  | "invalid-import-state"
  | "file-required"
  | "empty-file"
  | "unsupported-file-type"
  | "unsafe-archive"
  | "macro-workbook"
  | "malware-detected"
  | "parser-busy"
  | "mapping-invalid"
  | "invalid-resolution"
  | "commit-blocked"
  | "validation-stale"
  | "bq-not-draft"
  | "template-name-taken"
  | "template-not-applicable"
  | "sheet-not-found"
  | "amount-out-of-range"
  | "export-too-large"
  | "source-integrity";

export const bqConflict = (code: BqProblem, message: string) =>
  new ConflictException({ message, code });
export const bqBadRequest = (code: BqProblem, message: string) =>
  new BadRequestException({ message, code });
export const bqProblem = (status: number, code: BqProblem, message: string) =>
  new HttpException({ message, code }, status);
export const bqVersionConflict = () =>
  bqConflict("version-conflict", "This import was changed by someone else. Reload and try again.");

/**
 * Project resolution and permission checks for the BQ module, through ProjectAccess and
 * AccessPolicy (role ∩ assignment): 404 when the project is not in the caller's company, 403
 * without the permission.
 */
@Injectable()
export class BqAccess {
  constructor(private readonly projects: ProjectAccess) {}

  load(scope: Scope, projectId: string, permission: Permission) {
    return this.projects.load(scope, projectId, permission);
  }

  /** bq.import on a project that is not closed or cancelled. */
  async importable(scope: Scope, projectId: string) {
    const result = await this.projects.load(scope, projectId, "bq.import");
    if (isProjectReadOnly(result.project.status as ProjectStatus))
      throw bqConflict("project-read-only", "Closed and cancelled projects are read-only");
    return result;
  }

  /** An import of this project in the caller's company (404 otherwise, also for other companies). */
  async importRow(scope: Scope, projectId: string, importId: string) {
    const row = await scope.tx.bqImport.findUnique({
      where: { tenantId_id: { tenantId: scope.access.tenantId, id: importId } },
    });
    if (!row || row.projectId !== projectId) throw new NotFoundException("Import not found");
    return row;
  }
}
