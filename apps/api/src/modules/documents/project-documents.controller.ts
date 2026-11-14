import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { contentDisposition } from "@pm-buddy/domain";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_LIMITS,
  DOCUMENT_STATUSES,
  DRAWING_DISCIPLINES,
  ISSUE_PURPOSES,
} from "@pm-buddy/types";
import {
  createDocumentFieldsSchema,
  documentListQuerySchema,
  documentListResponseSchema,
  documentResponseSchema,
  drawingRegisterQuerySchema,
  drawingRegisterResponseSchema,
  newVersionFieldsSchema,
  projectDocumentsSummaryResponseSchema,
  updateDocumentRequestSchema,
  withdrawDocumentRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import {
  DOCUMENT_MULTER_LIMITS,
  DocumentUploadGuard,
  type UploadedDocumentFile,
} from "./document-files.js";
import { DocumentsDatabaseErrors } from "./documents-errors.js";
import { DocumentsOverviewService } from "./documents-overview.service.js";
import { DocumentsService } from "./documents.service.js";

export const READ_NOTE =
  "Requires projects.view plus one of documents.manage, projects.manage, site.diary, quality.manage, safety.manage, bq.edit, finance.view or finance.manage on the project (role ∩ assignment); clients, suppliers, storekeepers and labourers are refused (403); another company's project is 404. Contracts, BQs and insurance documents also need finance.view or finance.manage: for everyone else they do not exist (404, left out of lists).";
const MANAGE_NOTE =
  "Requires documents.manage on the project (and finance.view or finance.manage for contracts, BQs and insurance: 403 confidential-category); closed and cancelled projects are read-only (409 project-read-only).";
const FILE_NOTE =
  "One file of at most 25 MB, identified by its content (never its name or declared type): PDF (without scripts, launch actions or embedded files), JPEG, PNG, WebP, Word .docx or Excel .xlsx (zip limits; no macros, ActiveX or embedded programs). DWG/DXF, old Office files and anything else are 415 unsupported-file-type; 422 unsafe-archive, macro-document, pdf-active-content, malware-detected. Stored privately under a key the API generates, with its SHA-256; uploads are rate-limited (120 per hour).";

const versionFields = {
  revision: { type: "string", maxLength: 10, description: "As on the drawing: P1, A, C1, 02" },
  issuePurpose: { type: "string", enum: [...ISSUE_PURPOSES] },
  changeNote: { type: "string", maxLength: 1000 },
};

/**
 * A project's versioned documents (D8.4, ARCHITECTURE §4.13): the list and drawing register,
 * uploads of documents and new versions, metadata, withdrawal and downloads.
 */
@ApiTags("documents")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/documents", version: "1" })
@UseInterceptors(DocumentsDatabaseErrors)
export class ProjectDocumentsController {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
    private readonly documents: DocumentsService,
    private readonly overview: DocumentsOverviewService,
  ) {}

  private async args(req: Request, ...ids: string[]) {
    return [await this.auth.principal(req), ...ids.map((id) => uuidSchema.parse(id))] as const;
  }

  @Get()
  @ApiOperation({
    operationId: "listDocuments",
    summary: "The project's documents with their current version, filtered and paged",
    description: READ_NOTE,
  })
  @ApiQuery({ name: "category", required: false, enum: DOCUMENT_CATEGORIES })
  @ApiQuery({ name: "discipline", required: false, enum: DRAWING_DISCIPLINES })
  @ApiQuery({ name: "status", required: false, enum: [...DOCUMENT_STATUSES, "all"] })
  @ApiQuery({ name: "search", required: false, description: "Title, drawing number or reference" })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor (a row offset)" })
  @ApiQuery({ name: "limit", required: false, description: "1–100 rows; defaults to 30" })
  @ApiOkResponse({ schema: openApi(documentListResponseSchema) })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.documents.list(principal, project, documentListQuerySchema.parse(query), req);
  }

  @Get("drawings")
  @ApiOperation({
    operationId: "getDrawingRegister",
    summary: "The drawing register: active drawings with their current revision only",
    description: `${READ_NOTE} A superseded revision is never listed here (decision D-111).`,
  })
  @ApiQuery({ name: "discipline", required: false, enum: DRAWING_DISCIPLINES })
  @ApiQuery({ name: "search", required: false })
  @ApiOkResponse({ schema: openApi(drawingRegisterResponseSchema) })
  async drawings(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, project] = await this.args(req, projectId);
    return this.documents.drawings(
      principal,
      project,
      drawingRegisterQuerySchema.parse(query),
      req,
    );
  }

  @Get("summary")
  @ApiOperation({
    operationId: "getProjectDocumentsSummary",
    summary: "Documents, compliance reminders, open instructions and overdue approvals",
    description: `${READ_NOTE} Reminders are computed on read in Nairobi dates.`,
  })
  @ApiOkResponse({ schema: openApi(projectDocumentsSummaryResponseSchema) })
  async summary(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.overview.summary(principal, project, req);
  }

  @Post()
  @UseGuards(DocumentUploadGuard)
  @UseInterceptors(FileInterceptor("file", { limits: DOCUMENT_MULTER_LIMITS }))
  @ApiOperation({
    operationId: "createDocument",
    summary: "Upload a new document with its first version",
    description: `${MANAGE_NOTE} ${FILE_NOTE} Drawings need a drawing number (unique per project: 409 drawing-number-taken) and a discipline.`,
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "category", "title", "revision"],
      properties: {
        file: { type: "string", format: "binary" },
        category: { type: "string", enum: [...DOCUMENT_CATEGORIES] },
        title: { type: "string", maxLength: 200 },
        drawingNumber: { type: "string", maxLength: 40 },
        discipline: { type: "string", enum: [...DRAWING_DISCIPLINES] },
        reference: { type: "string", maxLength: 80 },
        ...versionFields,
      },
    },
  })
  @ApiCreatedResponse({ schema: openApi(documentResponseSchema) })
  async create(
    @Param("projectId") projectId: string,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project] = await this.args(req, projectId);
    return this.documents.create(
      principal,
      project,
      file,
      createDocumentFieldsSchema.parse({ ...(body as object) }),
      req,
    );
  }

  @Get(":documentId")
  @ApiOperation({
    operationId: "getDocument",
    summary: "A document with every version (newest first; earlier ones labelled superseded)",
    description: READ_NOTE,
  })
  @ApiOkResponse({ schema: openApi(documentResponseSchema) })
  async detail(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Req() req: Request,
  ) {
    const [principal, project, document] = await this.args(req, projectId, documentId);
    return this.documents.detail(principal, project, document, req);
  }

  @Patch(":documentId")
  @ApiOperation({
    operationId: "updateDocument",
    summary: "Change a document's title, drawing number, discipline or reference",
    description: `${MANAGE_NOTE} Send the version you read (409 version-conflict); withdrawn documents are final (409 document-withdrawn).`,
  })
  @ApiBody({ schema: openApi(updateDocumentRequestSchema) })
  @ApiOkResponse({ schema: openApi(documentResponseSchema) })
  async update(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, document] = await this.args(req, projectId, documentId);
    return this.documents.update(
      principal,
      project,
      document,
      updateDocumentRequestSchema.parse(body),
      req,
    );
  }

  @Post(":documentId/withdraw")
  @HttpCode(200)
  @ApiOperation({
    operationId: "withdrawDocument",
    summary: "Withdraw (archive) a document with a reason; nothing is deleted and it is final",
    description: `${MANAGE_NOTE} Its versions stay downloadable and labelled.`,
  })
  @ApiBody({ schema: openApi(withdrawDocumentRequestSchema) })
  @ApiOkResponse({ schema: openApi(documentResponseSchema) })
  async withdraw(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, document] = await this.args(req, projectId, documentId);
    return this.documents.withdraw(
      principal,
      project,
      document,
      withdrawDocumentRequestSchema.parse(body),
      req,
    );
  }

  @Post(":documentId/versions")
  @UseGuards(DocumentUploadGuard)
  @UseInterceptors(FileInterceptor("file", { limits: DOCUMENT_MULTER_LIMITS }))
  @ApiOperation({
    operationId: "addDocumentVersion",
    summary: "Upload a new version; it becomes current and supersedes the previous one",
    description: `${MANAGE_NOTE} ${FILE_NOTE} Send the current version you saw as basedOnVersionId (409 version-stale). The revision must be new to the document (409 revision-exists) and come after the current one unless it starts a new series (409 revision-not-after); a change note is required; at most 50 versions (409 version-limit); the same file twice is 409 version-duplicate.`,
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "revision", "changeNote", "basedOnVersionId"],
      properties: {
        file: { type: "string", format: "binary" },
        ...versionFields,
        basedOnVersionId: { type: "string", format: "uuid" },
      },
    },
  })
  @ApiCreatedResponse({ schema: openApi(documentResponseSchema) })
  async addVersion(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, document] = await this.args(req, projectId, documentId);
    return this.documents.addVersion(
      principal,
      project,
      document,
      file,
      newVersionFieldsSchema.parse({ ...(body as object) }),
      req,
    );
  }

  @Get(":documentId/versions/:versionId/content")
  @ApiOperation({
    operationId: "downloadDocumentVersion",
    summary: "Download a version (attachment; a superseded version's file name says SUPERSEDED)",
    description: `${READ_NOTE} Streamed through the API after the permission checks, never from a public URL; the stored SHA-256 is verified (409 file-integrity); every download is audited; 300 per 10 minutes per user. Headers: Content-Disposition attachment with a safe name, X-Content-Type-Options nosniff, X-Document-Version-State current|superseded.`,
  })
  @ApiProduces("application/octet-stream")
  async download(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Param("versionId") versionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const [principal, project, document, version] = await this.args(
      req,
      projectId,
      documentId,
      versionId,
    );
    await this.security.limit(
      `document-download:${principal.user.id}`,
      DOCUMENT_LIMITS.downloadsPer10Minutes,
      600,
    );
    const file = await this.documents.download(principal, project, document, version, req);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Document-Version-State", file.state);
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: contentDisposition(file.fileName),
      length: file.content.length,
    });
  }
}
