import { createHash } from "node:crypto";
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import {
  P2P_LIMITS,
  type GrnPhotoKind,
  type ProcurementDocumentKind,
  type ProcurementDocumentType,
} from "@pm-buddy/types";
import { procurementDocumentResponseSchema } from "@pm-buddy/validation";
import { describeError } from "../../../common/errors.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { MalwareDetected, MalwareScanner } from "../../../infra/malware-scanner.js";
import { StorageService } from "../../../infra/storage.service.js";
import type { Scope } from "../../identity/access-policy.js";
import { AuthSecurity } from "../../identity/auth-security.service.js";
import { AuthService, type Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { nextId } from "../catalogue-store.js";
import { peopleOf, personOf, type People } from "../procurement-mappers.js";
import { p2pBadRequest, p2pConflict, p2pProblem, P2pAccess } from "./p2p-common.js";

type DocumentRow = Prisma.ProcurementDocumentGetPayload<object>;
export type UploadedDocument = { buffer: Buffer; originalname: string; size: number };

export const toDocument = (row: DocumentRow, people: People) => ({
  id: row.id,
  kind: row.kind as ProcurementDocumentKind,
  contentType: row.contentType as ProcurementDocumentType,
  sizeBytes: row.sizeBytes,
  scanStatus: row.scanStatus as "clean" | "not_scanned",
  uploadedAt: row.uploadedAt.toISOString(),
  uploadedBy: personOf(people, row.uploadedBy),
});

/** The content type from the file's signature (the name and declared type are never trusted). */
export function sniffDocument(content: Buffer): ProcurementDocumentType | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    return "image/jpeg";
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/**
 * Before the multipart body is read: refuse a declared size over the limit (413), require a
 * session (401) and rate-limit uploads per user (429), so abusive uploads are never buffered.
 */
@Injectable()
export class P2pUploadGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (Number(req.headers["content-length"] ?? 0) > P2P_LIMITS.documentMaxBytes + 64 * 1024)
      throw new PayloadTooLargeException({
        message: "Files may be at most 10 MB (photos 5 MB)",
        code: "payload-too-large",
      });
    const principal = await this.auth.principal(req);
    await this.security.limit(
      `procurement-upload:${principal.user.id}`,
      P2P_LIMITS.uploadsPerHour,
      3_600,
    );
    return true;
  }
}

type Target =
  | { kind: "quotation"; rfqId: string; quotationId: string }
  | { kind: GrnPhotoKind; grnId: string }
  | { kind: "invoice"; invoiceId: string };

/**
 * Files kept with procurement records (D5.2): a quotation's document, GRN photos of the delivery
 * note and the goods, a supplier invoice. The D2.2 pattern: content sniffed by signature (JPEG,
 * PNG or WebP photos; PDF also for quotations and invoices), size limits, SHA-256, the malware
 * hook, a private object under a generated tenant/project key, and an immutable row. EXIF data
 * (including any GPS position) is never read or trusted: a GRN's position comes only from the
 * Geolocation API at capture.
 */
@Injectable()
export class P2pDocumentsService {
  private readonly logger = new Logger(P2pDocumentsService.name);

  constructor(
    private readonly scope: TenantScope,
    private readonly access: P2pAccess,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
  ) {}

  /** The owning record's project, after the permission for attaching to it is checked. */
  private async authorise(scope: Scope, target: Target): Promise<string> {
    const { tx, access } = scope;
    if (target.kind === "quotation") {
      const quotation = await tx.quotation.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: target.quotationId } },
        include: { rfq: { select: { projectId: true, id: true } } },
      });
      if (!quotation || quotation.rfqId !== target.rfqId)
        throw new NotFoundException("Quotation not found");
      await this.access.require(scope, quotation.rfq.projectId, ["procurement.manage_suppliers"]);
      return quotation.rfq.projectId;
    }
    if (target.kind === "invoice") {
      const invoice = await tx.supplierInvoice.findUnique({
        where: { tenantId_id: { tenantId: access.tenantId, id: target.invoiceId } },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");
      await this.access.require(scope, invoice.projectId, [
        "finance.manage",
        "procurement.manage_suppliers",
      ]);
      return invoice.projectId;
    }
    const grn = await tx.grn.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: target.grnId } },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    await this.access.require(scope, grn.projectId, ["stores.manage", "procurement.requisition"]);
    if (grn.status !== "recorded") throw p2pConflict("invalid-transition", "This GRN was voided");
    const photos = await tx.procurementDocument.count({
      where: { tenantId: access.tenantId, grnId: grn.id },
    });
    if (photos >= P2P_LIMITS.photosPerGrn)
      throw p2pConflict("too-many-photos", `A GRN keeps at most ${P2P_LIMITS.photosPerGrn} photos`);
    return grn.projectId;
  }

  async upload(
    principal: Principal,
    target: Target,
    file: UploadedDocument | undefined,
    req: Request,
  ) {
    if (!file?.buffer?.length) throw p2pBadRequest("file-required", "Attach the file as `file`");
    const projectId = await this.scope.run(principal, req, (scope) =>
      this.authorise(scope, target),
    );
    const contentType = sniffDocument(file.buffer);
    const photo = target.kind === "delivery_note" || target.kind === "goods";
    if (!contentType || (photo && contentType === "application/pdf"))
      throw p2pProblem(
        415,
        "unsupported-file-type",
        photo ? "Photos must be JPEG, PNG or WebP" : "Files must be JPEG, PNG, WebP or PDF",
      );
    const limit =
      contentType === "application/pdf" ? P2P_LIMITS.documentMaxBytes : P2P_LIMITS.imageMaxBytes;
    if (file.buffer.length > limit)
      throw p2pProblem(413, "payload-too-large", "The file is too large");
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    let scan;
    try {
      scan = await this.scanner.scan(file.buffer, { sha256 });
    } catch (error) {
      if (error instanceof MalwareDetected)
        throw p2pProblem(422, "malware-detected", "The file was refused by the malware scanner");
      throw error;
    }
    const id = nextId();
    const tenantId = principal.session.activeTenantId!;
    const kind: ProcurementDocumentKind = target.kind;
    const objectKey = `tenants/${tenantId}/projects/${projectId}/procurement/${kind}/${id}`;
    await this.storage.put(objectKey, file.buffer, contentType, sha256);
    try {
      return await this.scope.run(
        principal,
        req,
        async (scope) => {
          await this.authorise(scope, target);
          const row = await scope.tx.procurementDocument.create({
            data: {
              id,
              tenantId: scope.access.tenantId,
              projectId,
              kind,
              quotationId: target.kind === "quotation" ? target.quotationId : null,
              grnId: "grnId" in target ? target.grnId : null,
              invoiceId: target.kind === "invoice" ? target.invoiceId : null,
              objectKey,
              contentType,
              sizeBytes: file.buffer.length,
              sha256,
              scanStatus: scan.status,
              scanEngine: scan.engine,
              scannedAt: scan.scannedAt,
              uploadedBy: scope.access.userId,
            },
          });
          await this.scope.audit(scope.tx, "procurement.document_added", id, {
            projectId,
            kind,
            contentType,
            sizeBytes: file.buffer.length,
            scan: scan.status,
          });
          return procurementDocumentResponseSchema.parse({
            document: toDocument(row, await peopleOf(scope.tx, [row.uploadedBy])),
          });
        },
        true,
      );
    } catch (error) {
      await this.storage
        .delete(objectKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(`Could not remove an orphaned upload: ${describeError(cleanup)}`),
        );
      throw error;
    }
  }

  /** Streams a document to someone who may see the record's project. */
  async download(principal: Principal, id: string, req: Request) {
    const row = await this.scope.run(principal, req, async (scope) => {
      const document = await scope.tx.procurementDocument.findUnique({
        where: { tenantId_id: { tenantId: scope.access.tenantId, id } },
      });
      if (!document) throw new NotFoundException("Document not found");
      const access = await this.access.on(scope, document.projectId);
      if (!this.access.canView(access))
        throw new ForbiddenException("No procurement permission on this project");
      return document;
    });
    const content = await this.storage.get(row.objectKey, P2P_LIMITS.documentMaxBytes);
    if (createHash("sha256").update(content).digest("hex") !== row.sha256)
      throw p2pConflict("invalid-transition", "The stored file does not match its checksum");
    const extension = row.contentType === "application/pdf" ? "pdf" : row.contentType.split("/")[1];
    return {
      content,
      contentType: row.contentType,
      fileName: `${row.kind}-${row.id}.${extension}`,
    };
  }
}
