import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isProjectReadOnly } from "@pm-buddy/domain";
import {
  DOCUMENT_CONFIDENTIAL_PERMISSIONS,
  DOCUMENT_READ_PERMISSIONS,
  INSTRUCTION_MANAGE_PERMISSIONS,
  INSTRUCTION_RECORD_PERMISSIONS,
  isConfidentialCategory,
  type DocumentCategory,
  type Permission,
  type ProjectStatus,
} from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import { effectiveProjectPermissions } from "../identity/role-grants.js";

type Tx = Prisma.TransactionClient;

/** Stable problem codes for the documents module (the web maps them to EN/SW messages). */
export type DocumentsProblem =
  | "project-read-only"
  | "version-conflict"
  | "invalid-transition"
  | "file-required"
  | "unsupported-file-type"
  | "unsafe-archive"
  | "macro-document"
  | "pdf-active-content"
  | "payload-too-large"
  | "malware-detected"
  | "file-integrity"
  | "document-withdrawn"
  | "document-limit"
  | "version-limit"
  | "version-duplicate"
  | "version-stale"
  | "revision-invalid"
  | "revision-exists"
  | "revision-not-after"
  | "drawing-number-taken"
  | "confidential-category"
  | "compliance-type-retired"
  | "compliance-stale"
  | "compliance-issued-future"
  | "compliance-expiry-required"
  | "compliance-expiry-before-issue"
  | "compliance-type-limit"
  | "evidence-not-found"
  | "instruction-number-taken"
  | "instruction-closed"
  | "instruction-date-future"
  | "instruction-issuer-cannot-respond"
  | "note-required"
  | "delay-not-found"
  | "attachment-not-found"
  | "attachment-limit"
  | "attachment-exists"
  | "photo-not-verified"
  | "approval-document-not-current"
  | "approval-not-pending"
  | "approval-raiser-cannot-respond"
  | "approval-uploader-cannot-respond"
  | "approval-digest-mismatch"
  | "approval-date-invalid"
  | "approval-evidence-invalid"
  | "approval-resubmission-invalid"
  | "idempotency-key-required"
  | "idempotency-key-reused"
  | "instruction-id-conflict"
  | "documents-rule";

export function documentsProblem(
  status: 400 | 403 | 404 | 409 | 413 | 415 | 422,
  code: DocumentsProblem,
  message: string,
): HttpException {
  const body = { code, message };
  if (status === 403) return new ForbiddenException(body);
  if (status === 404) return new NotFoundException(body);
  if (status === 409) return new ConflictException(body);
  const statuses = {
    400: HttpStatus.BAD_REQUEST,
    413: HttpStatus.PAYLOAD_TOO_LARGE,
    415: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    422: HttpStatus.UNPROCESSABLE_ENTITY,
  } as const;
  return new HttpException(body, statuses[status]);
}

export const versionConflict = () =>
  documentsProblem(
    409,
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );

const hasAny = (effective: ReadonlySet<Permission>, permissions: readonly Permission[]) =>
  permissions.some((permission) => effective.has(permission));

export type DocumentsProject = {
  id: string;
  code: string;
  name: string;
  status: string;
  readOnly: boolean;
  effective: ReadonlySet<Permission>;
};

/**
 * The caller's document permissions on every project of the company (role ∩ assignment),
 * computed once per request with the same rules as the actions (decisions D-110, D-112).
 */
export class DocumentsCaller {
  constructor(
    readonly userId: string,
    readonly displayName: string,
    private readonly company: ReadonlySet<Permission>,
    readonly projects: ReadonlyMap<string, DocumentsProject>,
  ) {}

  private has(projectId: string, test: (effective: ReadonlySet<Permission>) => boolean) {
    const project = this.projects.get(projectId);
    return project ? test(project.effective) : false;
  }
  private writable(projectId: string) {
    return this.projects.get(projectId)?.readOnly === false;
  }

  /** projects.view plus one of DOCUMENT_READ_PERMISSIONS on the project. */
  canRead(projectId: string) {
    return this.has(
      projectId,
      (effective) => effective.has("projects.view") && hasAny(effective, DOCUMENT_READ_PERMISSIONS),
    );
  }
  /** Contracts, BQs and insurance (commercial terms) also need finance.view or finance.manage. */
  canSeeConfidential(projectId: string) {
    return (
      this.canRead(projectId) &&
      this.has(projectId, (effective) => hasAny(effective, DOCUMENT_CONFIDENTIAL_PERMISSIONS))
    );
  }
  canSeeCategory(projectId: string, category: DocumentCategory) {
    return isConfidentialCategory(category)
      ? this.canSeeConfidential(projectId)
      : this.canRead(projectId);
  }
  /** documents.manage on the project, whatever its status. */
  holdsManage(projectId: string) {
    return this.canRead(projectId) && this.has(projectId, (e) => e.has("documents.manage"));
  }
  /** documents.manage on a project that is not closed or cancelled. */
  canManage(projectId: string) {
    return this.holdsManage(projectId) && this.writable(projectId);
  }
  canManageCategory(projectId: string, category: DocumentCategory) {
    return this.canManage(projectId) && this.canSeeCategory(projectId, category);
  }
  canRecordInstruction(projectId: string) {
    return (
      this.canRead(projectId) &&
      this.writable(projectId) &&
      this.has(projectId, (effective) => hasAny(effective, INSTRUCTION_RECORD_PERMISSIONS))
    );
  }
  canManageInstruction(projectId: string) {
    return (
      this.canRead(projectId) &&
      this.writable(projectId) &&
      this.has(projectId, (effective) => hasAny(effective, INSTRUCTION_MANAGE_PERMISSIONS))
    );
  }
  /** A consultant: documents.manage without the contractor's project, BQ or site keys. */
  isConsultantOn(projectId: string) {
    return this.has(
      projectId,
      (effective) =>
        effective.has("documents.manage") &&
        !effective.has("projects.manage") &&
        !effective.has("bq.edit") &&
        !effective.has("site.diary"),
    );
  }
  /** Company items and item types: config.manage (company-level). */
  get canConfigure() {
    return this.company.has("config.manage");
  }
  readableProjects() {
    return [...this.projects.values()].filter((project) => this.canRead(project.id));
  }
  get readSomewhere() {
    return this.readableProjects().length > 0;
  }
}

/**
 * Documents access (ARCHITECTURE §4.13, decision D-110): project documents, the compliance
 * register, instructions and approval requests are read with projects.view + one of
 * DOCUMENT_READ_PERMISSIONS; confidential categories also need a finance key (D-112); changes need
 * documents.manage (instructions also bq.edit or site.diary); company items need config.manage.
 */
@Injectable()
export class DocumentsAccess {
  async caller(scope: Scope): Promise<DocumentsCaller> {
    const { tx, access } = scope;
    const [rows, user] = await Promise.all([
      tx.project.findMany({
        where: { tenantId: access.tenantId },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          members: { where: { userId: access.userId }, select: { permissions: true } },
        },
        orderBy: { code: "asc" },
      }),
      tx.user.findUnique({ where: { id: access.userId }, select: { displayName: true } }),
    ]);
    const projects = new Map<string, DocumentsProject>();
    for (const row of rows) {
      const assigned = row.members[0]?.permissions ?? null;
      if (!access.tenantWide && assigned === null) continue;
      projects.set(row.id, {
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        readOnly: isProjectReadOnly(row.status as ProjectStatus),
        effective: effectiveProjectPermissions(access, assigned),
      });
    }
    return new DocumentsCaller(
      access.userId,
      user?.displayName ?? "—",
      access.permissions,
      projects,
    );
  }

  /** The caller on a project they may read: 404 outside the company, 403 without permission. */
  async reader(scope: Scope, projectId: string): Promise<DocumentsCaller> {
    const caller = await this.caller(scope);
    if (!caller.canRead(projectId)) {
      const exists = await scope.tx.project.findUnique({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id: projectId } },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException("Project not found");
      throw new ForbiddenException(
        `projects.view and one of these permissions are required on the project: ${DOCUMENT_READ_PERMISSIONS.join(", ")}`,
      );
    }
    return caller;
  }

  /** Any document reader somewhere, or config.manage (403 otherwise). */
  async anyReader(scope: Scope): Promise<DocumentsCaller> {
    const caller = await this.caller(scope);
    if (!caller.readSomewhere && !caller.canConfigure)
      throw new ForbiddenException(
        `One of these permissions is required on a project: ${DOCUMENT_READ_PERMISSIONS.join(", ")}`,
      );
    return caller;
  }
}

/** Refuses a change on a closed or cancelled project (409 project-read-only). */
export function requireWritable(caller: DocumentsCaller, projectId: string) {
  if (caller.projects.get(projectId)?.readOnly)
    throw documentsProblem(409, "project-read-only", "Closed and cancelled projects are read-only");
}

/** 403 unless the test passes (after requireWritable, so a closed project is a 409). */
export function requirePermission(allowed: boolean, message: string) {
  if (!allowed) throw new ForbiddenException(message);
}

/** Locks the project row so per-project numbering is serialised. */
export const lockProject = (tx: Tx, tenantId: string, projectId: string) =>
  tx.$queryRaw`SELECT id FROM projects WHERE tenant_id = ${tenantId}::uuid AND id = ${projectId}::uuid FOR UPDATE`;
