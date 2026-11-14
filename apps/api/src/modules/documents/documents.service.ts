import { createHash } from "node:crypto";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  checkNextRevision,
  documentDownloadName,
  documentFileName,
  normaliseRevision,
  suggestNextRevision,
} from "@pm-buddy/domain";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_FILE_EXTENSIONS,
  DOCUMENT_LIMITS,
  DRAWING_DISCIPLINES,
  type DocumentCategory,
  type DocumentContentType,
} from "@pm-buddy/types";
import {
  documentListResponseSchema,
  documentResponseSchema,
  drawingRegisterResponseSchema,
  type CreateDocumentFields,
  type DocumentListQuery,
  type DrawingRegisterQuery,
  type NewVersionFields,
  type UpdateDocumentRequest,
  type WithdrawDocumentRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { describeError } from "../../common/errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { MalwareDetected, MalwareScanner, type ScanResult } from "../../infra/malware-scanner.js";
import { StorageService } from "../../infra/storage.service.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import {
  documentsProblem,
  DocumentsAccess,
  requirePermission,
  requireWritable,
  versionConflict,
  type DocumentsCaller,
} from "./documents-access.js";
import { DocumentRefused, inspectDocument, type UploadedDocumentFile } from "./document-files.js";
import {
  approvalsOf,
  changedFields,
  peopleOf,
  personOf,
  summariesOf,
  toVersion,
  withCurrent,
  type DocumentRow,
} from "./documents-mappers.js";

type Prepared = {
  buffer: Buffer;
  contentType: DocumentContentType;
  fileName: string;
  sha256: string;
  scan: ScanResult;
};

const objectKey = (tenantId: string, projectId: string, documentId: string, versionId: string) =>
  `tenants/${tenantId}/projects/${projectId}/documents/${documentId}/${versionId}`;

const confidentialMessage =
  "Contracts, BQs and insurance documents need finance.view or finance.manage on the project";

/**
 * The project's versioned documents (D8.4, decisions D-111–D-114). Every version is a private
 * object under a key the API generates, checked by content signature, size and the malware hook,
 * with its SHA-256; versions are append-only and exactly one is current (enforced by the
 * database). Contracts, BQs and insurance documents exist only for callers who may see commercial
 * terms (D-112): to everyone else they are not found. Downloads stream through the API after the
 * same checks and are audited.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly access: DocumentsAccess,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  /** Categories the caller may see on the project. */
  private visibleCategories(caller: DocumentsCaller, projectId: string): DocumentCategory[] {
    return DOCUMENT_CATEGORIES.filter((category) => caller.canSeeCategory(projectId, category));
  }

  /** A document of the project the caller may see (404 otherwise, never revealing it exists). */
  async documentRow(scope: Scope, caller: DocumentsCaller, projectId: string, documentId: string) {
    const row = await scope.tx.document.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: documentId },
    });
    if (!row || !caller.canSeeCategory(projectId, row.category as DocumentCategory))
      throw new NotFoundException("Document not found");
    return row;
  }

  list(principal: Principal, projectId: string, query: DocumentListQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const { tx, access } = scope;
      const visible = this.visibleCategories(caller, projectId);
      const search = query.search?.trim();
      const where: Prisma.DocumentWhereInput = {
        tenantId: access.tenantId,
        projectId,
        category: query.category
          ? { in: visible.includes(query.category) ? [query.category] : [] }
          : { in: visible },
        ...(query.status === "all" ? {} : { status: query.status }),
        ...(query.discipline ? { discipline: query.discipline } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { drawingNumber: { contains: search, mode: "insensitive" } },
                { reference: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const offset = query.cursor ?? 0;
      const [rows, total, groups] = await Promise.all([
        tx.document.findMany({
          where,
          include: withCurrent,
          orderBy: [{ category: "asc" }, { drawingNumber: "asc" }, { title: "asc" }, { id: "asc" }],
          skip: offset,
          take: query.limit + 1,
        }),
        tx.document.count({ where }),
        tx.document.groupBy({
          by: ["category"],
          where: {
            tenantId: access.tenantId,
            projectId,
            status: "active",
            category: { in: visible },
          },
          _count: { _all: true },
        }),
      ]);
      const page = rows.slice(0, query.limit);
      const counts = Object.fromEntries(DOCUMENT_CATEGORIES.map((category) => [category, 0]));
      for (const group of groups) counts[group.category] = group._count._all;
      return documentListResponseSchema.parse({
        documents: await summariesOf(tx, access.tenantId, page),
        counts,
        total,
        nextCursor: rows.length > query.limit ? offset + query.limit : null,
        permissions: {
          canUpload: caller.canManage(projectId),
          canSeeConfidential: caller.canSeeConfidential(projectId),
        },
      });
    });
  }

  /** The drawing register: active drawings with their current revision only (D-111). */
  drawings(principal: Principal, projectId: string, query: DrawingRegisterQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.access.reader(scope, projectId);
      const { tx, access } = scope;
      const search = query.search?.trim();
      const base: Prisma.DocumentWhereInput = {
        tenantId: access.tenantId,
        projectId,
        category: "drawing",
        status: "active",
      };
      const [rows, groups] = await Promise.all([
        tx.document.findMany({
          where: {
            ...base,
            ...(query.discipline ? { discipline: query.discipline } : {}),
            ...(search
              ? {
                  OR: [
                    { title: { contains: search, mode: "insensitive" } },
                    { drawingNumber: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {}),
          },
          include: withCurrent,
          orderBy: [{ drawingNumber: "asc" }, { id: "asc" }],
          take: DOCUMENT_LIMITS.maxDocumentsPerProject,
        }),
        tx.document.groupBy({ by: ["discipline"], where: base, _count: { _all: true } }),
      ]);
      const disciplines = Object.fromEntries(DRAWING_DISCIPLINES.map((key) => [key, 0]));
      for (const group of groups)
        if (group.discipline) disciplines[group.discipline] = group._count._all;
      return drawingRegisterResponseSchema.parse({
        drawings: await summariesOf(tx, access.tenantId, rows),
        disciplines,
      });
    });
  }

  detail(principal: Principal, projectId: string, documentId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      const row = await this.documentRow(scope, caller, projectId, documentId);
      return this.detailOf(scope, caller, row);
    });
  }

  private async detailOf(scope: Scope, caller: DocumentsCaller, row: DocumentRow) {
    const { tx, access } = scope;
    const versions = await tx.documentVersion.findMany({
      where: { tenantId: access.tenantId, documentId: row.id },
      orderBy: { versionNo: "desc" },
    });
    const current = versions.find((version) => version.isCurrent)!;
    const [people, approvals] = await Promise.all([
      peopleOf(tx, [
        row.createdBy,
        row.withdrawnBy,
        ...versions.map((version) => version.uploadedBy),
      ]),
      approvalsOf(
        tx,
        access.tenantId,
        versions.map((version) => version.id),
      ),
    ]);
    const revisions = new Map(versions.map((version) => [version.id, version.revision]));
    const projectId = row.projectId;
    const active = row.status === "active";
    const manage = caller.canManageCategory(projectId, row.category as DocumentCategory);
    const summary = (
      await summariesOf(tx, access.tenantId, [
        { ...row, versions: [current], _count: { versions: versions.length } },
      ])
    )[0]!;
    return documentResponseSchema.parse({
      document: {
        ...summary,
        versions: versions.map((version) => toVersion(version, people, approvals, revisions)),
        createdBy: personOf(people, row.createdBy),
        createdAt: row.createdAt.toISOString(),
        withdrawal:
          row.status === "withdrawn"
            ? {
                by: personOf(people, row.withdrawnBy!),
                at: row.withdrawnAt!.toISOString(),
                reason: row.withdrawReason!,
              }
            : null,
        nextRevision: suggestNextRevision(current.revision),
        permissions: {
          canUpload: manage && active && versions.length < DOCUMENT_LIMITS.maxVersionsPerDocument,
          canEdit: manage && active,
          canWithdraw: manage && active,
          canRaiseApproval: caller.canManage(projectId) && active,
        },
      },
    });
  }

  /** Content checks before anything is stored: type by signature, size, SHA-256, malware hook. */
  private async prepare(file: UploadedDocumentFile | undefined): Promise<Prepared> {
    if (!file?.buffer?.length)
      throw documentsProblem(400, "file-required", "Attach the file as `file`");
    if (file.buffer.length > DOCUMENT_LIMITS.maxFileBytes)
      throw documentsProblem(413, "payload-too-large", "Files may be at most 25 MB");
    let detected;
    try {
      detected = inspectDocument(file.buffer);
    } catch (error) {
      if (error instanceof DocumentRefused)
        throw documentsProblem(
          error.code === "file-required" ? 400 : error.code === "unsupported-file-type" ? 415 : 422,
          error.code,
          error.message,
        );
      throw error;
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    let scan: ScanResult;
    try {
      scan = await this.scanner.scan(file.buffer, { sha256 });
    } catch (error) {
      if (error instanceof MalwareDetected)
        throw documentsProblem(
          422,
          "malware-detected",
          "The file was refused by the malware scanner",
        );
      throw error;
    }
    return {
      buffer: file.buffer,
      contentType: detected.contentType,
      fileName: documentFileName(file.originalname ?? "", detected.extension),
      sha256,
      scan,
    };
  }

  /** Stores the object, runs the write, and removes the object again if the write fails. */
  private async stored<T>(key: string, prepared: Prepared, write: () => Promise<T>): Promise<T> {
    await this.storage.put(key, prepared.buffer, prepared.contentType, prepared.sha256);
    try {
      return await write();
    } catch (error) {
      await this.storage
        .delete(key)
        .catch((cleanup: unknown) =>
          this.logger.warn(`Could not remove an orphaned upload: ${describeError(cleanup)}`),
        );
      throw error;
    }
  }

  private checkNew(caller: DocumentsCaller, projectId: string, category: DocumentCategory) {
    if (!caller.canRead(projectId)) throw new NotFoundException("Project not found");
    requireWritable(caller, projectId);
    requirePermission(caller.canManage(projectId), "documents.manage is required on the project");
    if (!caller.canSeeCategory(projectId, category))
      throw documentsProblem(403, "confidential-category", confidentialMessage);
  }

  async create(
    principal: Principal,
    projectId: string,
    file: UploadedDocumentFile | undefined,
    fields: CreateDocumentFields,
    req: Request,
  ) {
    const revision = checkNextRevision([], null, fields.revision);
    if (!revision.ok)
      throw documentsProblem(422, revision.problem, "The revision label is not valid");
    // Permission first, so a refused caller never gets an upload scanned or stored.
    await this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      this.checkNew(caller, projectId, fields.category);
    });
    const prepared = await this.prepare(file);
    const tenantId = principal.session.activeTenantId!;
    const documentId = uuidv7();
    const versionId = uuidv7();
    const key = objectKey(tenantId, projectId, documentId, versionId);
    return this.stored(key, prepared, () =>
      this.scope
        .run(
          principal,
          req,
          async (scope) => {
            const caller = await this.access.reader(scope, projectId);
            this.checkNew(caller, projectId, fields.category);
            const { tx, access } = scope;
            const documents = await tx.document.count({ where: { tenantId, projectId } });
            if (documents >= DOCUMENT_LIMITS.maxDocumentsPerProject)
              throw documentsProblem(
                409,
                "document-limit",
                `A project keeps at most ${DOCUMENT_LIMITS.maxDocumentsPerProject} documents`,
              );
            if (fields.drawingNumber)
              await this.drawingNumberFree(scope, projectId, fields.drawingNumber, null);
            const row = await tx.document.create({
              data: {
                id: documentId,
                tenantId,
                projectId,
                category: fields.category,
                title: fields.title,
                drawingNumber: fields.drawingNumber ?? null,
                discipline: fields.discipline ?? null,
                reference: fields.reference ?? null,
                createdBy: access.userId,
                updatedBy: access.userId,
              },
            });
            await this.createVersion(scope, row, versionId, 1, key, prepared, {
              revision: fields.revision.trim(),
              issuePurpose: fields.issuePurpose ?? null,
              changeNote: fields.changeNote ?? null,
            });
            await this.scope.audit(tx, "document.created", documentId, {
              projectId,
              category: fields.category,
              versionId,
              contentType: prepared.contentType,
              sizeBytes: prepared.buffer.length,
              scan: prepared.scan.status,
            });
            return this.detailOf(scope, caller, row);
          },
          true,
        )
        .catch((error: unknown) => {
          if (isUniqueViolation(error) && fields.drawingNumber)
            throw documentsProblem(
              409,
              "drawing-number-taken",
              "Another drawing on this project has this number",
            );
          throw error;
        }),
    );
  }

  private async drawingNumberFree(
    scope: Scope,
    projectId: string,
    drawingNumber: string,
    except: string | null,
  ) {
    const clash = await scope.tx.document.findFirst({
      where: {
        tenantId: scope.access.tenantId,
        projectId,
        category: "drawing",
        drawingNumber: { equals: drawingNumber, mode: "insensitive" },
        ...(except ? { id: { not: except } } : {}),
      },
      select: { id: true },
    });
    if (clash)
      throw documentsProblem(
        409,
        "drawing-number-taken",
        "Another drawing on this project has this number",
      );
  }

  private async createVersion(
    scope: Scope,
    doc: DocumentRow,
    versionId: string,
    versionNo: number,
    key: string,
    prepared: Prepared,
    fields: { revision: string; issuePurpose: string | null; changeNote: string | null },
  ) {
    await scope.tx.documentVersion.create({
      data: {
        id: versionId,
        tenantId: doc.tenantId,
        projectId: doc.projectId,
        documentId: doc.id,
        versionNo,
        revision: fields.revision,
        issuePurpose: fields.issuePurpose,
        changeNote: fields.changeNote,
        fileName: prepared.fileName,
        contentType: prepared.contentType,
        sizeBytes: prepared.buffer.length,
        sha256: prepared.sha256,
        objectKey: key,
        scanStatus: prepared.scan.status,
        scanEngine: prepared.scan.engine,
        scannedAt: prepared.scan.scannedAt,
        uploadedBy: scope.access.userId,
      },
    });
  }

  /** The checks for a new version, against the document as it is now (locked when writing). */
  private async checkVersion(
    scope: Scope,
    caller: DocumentsCaller,
    projectId: string,
    documentId: string,
    fields: NewVersionFields,
    sha256: string | null,
  ) {
    const row = await this.documentRow(scope, caller, projectId, documentId);
    requireWritable(caller, projectId);
    requirePermission(caller.canManage(projectId), "documents.manage is required on the project");
    if (row.status !== "active")
      throw documentsProblem(
        409,
        "document-withdrawn",
        "A withdrawn document takes no new versions",
      );
    const versions = await scope.tx.documentVersion.findMany({
      where: { tenantId: scope.access.tenantId, documentId },
      select: { id: true, revision: true, isCurrent: true, versionNo: true, sha256: true },
      orderBy: { versionNo: "asc" },
    });
    const current = versions.find((version) => version.isCurrent)!;
    if (current.id !== fields.basedOnVersionId)
      throw documentsProblem(
        409,
        "version-stale",
        "A newer version was uploaded meanwhile. Reload and check it before uploading.",
      );
    if (versions.length >= DOCUMENT_LIMITS.maxVersionsPerDocument)
      throw documentsProblem(
        409,
        "version-limit",
        `A document keeps at most ${DOCUMENT_LIMITS.maxVersionsPerDocument} versions`,
      );
    const revision = checkNextRevision(
      versions.map((version) => version.revision),
      current.revision,
      fields.revision,
    );
    if (!revision.ok)
      throw documentsProblem(
        revision.problem === "revision-invalid" ? 422 : 409,
        revision.problem,
        revision.problem === "revision-exists"
          ? "This revision is already on the document"
          : revision.problem === "revision-not-after"
            ? `Revision ${normaliseRevision(fields.revision)} does not come after ${current.revision}`
            : "The revision label is not valid",
      );
    if (sha256 && versions.some((version) => version.sha256 === sha256))
      throw documentsProblem(
        409,
        "version-duplicate",
        "This file is already a version of the document",
      );
    return { row, versionNo: versions.length + 1, order: revision.order };
  }

  async addVersion(
    principal: Principal,
    projectId: string,
    documentId: string,
    file: UploadedDocumentFile | undefined,
    fields: NewVersionFields,
    req: Request,
  ) {
    await this.scope.run(principal, req, async (scope) => {
      const caller = await this.access.reader(scope, projectId);
      await this.checkVersion(scope, caller, projectId, documentId, fields, null);
    });
    const prepared = await this.prepare(file);
    const tenantId = principal.session.activeTenantId!;
    const versionId = uuidv7();
    const key = objectKey(tenantId, projectId, documentId, versionId);
    return this.stored(key, prepared, () =>
      this.scope.run(
        principal,
        req,
        async (scope) => {
          const caller = await this.access.reader(scope, projectId);
          await scope.tx
            .$queryRaw`SELECT id FROM documents WHERE tenant_id = ${tenantId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
          const { row, versionNo, order } = await this.checkVersion(
            scope,
            caller,
            projectId,
            documentId,
            fields,
            prepared.sha256,
          );
          await this.createVersion(scope, row, versionId, versionNo, key, prepared, {
            revision: fields.revision.trim(),
            issuePurpose: fields.issuePurpose ?? null,
            changeNote: fields.changeNote,
          });
          await this.scope.audit(scope.tx, "document.version_added", documentId, {
            projectId,
            category: row.category,
            versionId,
            versionNo,
            supersedes: fields.basedOnVersionId,
            newSeries: order === "new_series",
            contentType: prepared.contentType,
            sizeBytes: prepared.buffer.length,
            scan: prepared.scan.status,
          });
          return this.detailOf(scope, caller, row);
        },
        true,
      ),
    );
  }

  update(
    principal: Principal,
    projectId: string,
    documentId: string,
    input: UpdateDocumentRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const caller = await this.access.reader(scope, projectId);
          const row = await this.documentRow(scope, caller, projectId, documentId);
          requireWritable(caller, projectId);
          requirePermission(
            caller.canManage(projectId),
            "documents.manage is required on the project",
          );
          if (row.status !== "active")
            throw documentsProblem(409, "document-withdrawn", "A withdrawn document is final");
          if (row.version !== input.version) throw versionConflict();
          const drawing = row.category === "drawing";
          if (!drawing && (input.drawingNumber !== undefined || input.discipline !== undefined))
            throw documentsProblem(
              422,
              "invalid-transition",
              "Only drawings have a drawing number and discipline",
            );
          if (input.drawingNumber !== undefined)
            await this.drawingNumberFree(scope, projectId, input.drawingNumber, documentId);
          const { version, ...fields } = input;
          const updated = await scope.tx.document.updateMany({
            where: { tenantId: scope.access.tenantId, id: documentId, version },
            data: {
              ...(fields.title !== undefined ? { title: fields.title } : {}),
              ...(fields.drawingNumber !== undefined
                ? { drawingNumber: fields.drawingNumber }
                : {}),
              ...(fields.discipline !== undefined ? { discipline: fields.discipline } : {}),
              ...(fields.reference !== undefined ? { reference: fields.reference } : {}),
              version: { increment: 1 },
              updatedBy: scope.access.userId,
            },
          });
          if (!updated.count) throw versionConflict();
          await this.scope.audit(scope.tx, "document.updated", documentId, {
            projectId,
            category: row.category,
            fields: changedFields(fields),
          });
          const after = await this.documentRow(scope, caller, projectId, documentId);
          return this.detailOf(scope, caller, after);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw documentsProblem(
            409,
            "drawing-number-taken",
            "Another drawing on this project has this number",
          );
        throw error;
      });
  }

  withdraw(
    principal: Principal,
    projectId: string,
    documentId: string,
    input: WithdrawDocumentRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        const row = await this.documentRow(scope, caller, projectId, documentId);
        requireWritable(caller, projectId);
        requirePermission(
          caller.canManage(projectId),
          "documents.manage is required on the project",
        );
        if (row.status !== "active")
          throw documentsProblem(409, "document-withdrawn", "This document is already withdrawn");
        if (row.version !== input.version) throw versionConflict();
        const updated = await scope.tx.document.updateMany({
          where: { tenantId: scope.access.tenantId, id: documentId, version: input.version },
          data: {
            status: "withdrawn",
            withdrawnBy: scope.access.userId,
            withdrawnAt: new Date(),
            withdrawReason: input.reason,
            version: { increment: 1 },
            updatedBy: scope.access.userId,
          },
        });
        if (!updated.count) throw versionConflict();
        await this.scope.audit(scope.tx, "document.withdrawn", documentId, {
          projectId,
          category: row.category,
        });
        const after = await this.documentRow(scope, caller, projectId, documentId);
        return this.detailOf(scope, caller, after);
      },
      true,
    );
  }

  /**
   * A version's file, after the same checks as the detail (a confidential category is not found
   * for other readers); the download is audited and the stored SHA-256 is verified.
   */
  async download(
    principal: Principal,
    projectId: string,
    documentId: string,
    versionId: string,
    req: Request,
  ) {
    const version = await this.scope.run(
      principal,
      req,
      async (scope) => {
        const caller = await this.access.reader(scope, projectId);
        const row = await this.documentRow(scope, caller, projectId, documentId);
        const version = await scope.tx.documentVersion.findFirst({
          where: { tenantId: scope.access.tenantId, documentId: row.id, id: versionId },
        });
        if (!version) throw new NotFoundException("Version not found");
        await this.scope.audit(scope.tx, "document.downloaded", documentId, {
          projectId,
          category: row.category,
          versionId,
          versionNo: version.versionNo,
          state: version.isCurrent ? "current" : "superseded",
        });
        return version;
      },
      true,
    );
    const content = await this.storage.get(version.objectKey, DOCUMENT_LIMITS.maxFileBytes);
    if (createHash("sha256").update(content).digest("hex") !== version.sha256)
      throw documentsProblem(409, "file-integrity", "The stored file does not match its checksum");
    const contentType = version.contentType as DocumentContentType;
    return {
      content,
      contentType,
      state: version.isCurrent ? ("current" as const) : ("superseded" as const),
      fileName: documentDownloadName({
        storedName: version.fileName,
        revision: version.revision,
        superseded: !version.isCurrent,
        extension: DOCUMENT_FILE_EXTENSIONS[contentType],
      }),
    };
  }
}
