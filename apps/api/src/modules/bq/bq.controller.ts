import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { contentDisposition } from "@pm-buddy/domain";
import { BQ_IMPORT_LIMITS } from "@pm-buddy/types";
import {
  applyBqTemplateRequestSchema,
  bqBillResponseSchema,
  bqExportQuerySchema,
  bqImportResponseSchema,
  bqImportsResponseSchema,
  bqImportVersionRequestSchema,
  bqPreviewResponseSchema,
  bqResponseSchema,
  bqSearchQuerySchema,
  bqSearchResponseSchema,
  bqSheetRowsQuerySchema,
  bqSheetRowsResponseSchema,
  bqTemplateResponseSchema,
  bqTemplatesResponseSchema,
  createBqTemplateRequestSchema,
  messageResponseSchema,
  saveBqMappingRequestSchema,
  saveBqResolutionsRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { z } from "zod";
import { openApi } from "../../common/openapi.js";
import { AuthSecurity } from "../identity/auth-security.service.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BqExportService } from "./bq-export.service.js";
import { BqImportsService, type UploadedWorkbook } from "./bq-imports.service.js";
import { CONTENT_TYPES } from "./bq-object-store.js";
import { BqTemplatesService } from "./bq-templates.service.js";
import { BqViewerService } from "./bq-viewer.service.js";

const viewNote = "Requires bq.view on the project (role ∩ assignment).";
const importNote =
  "Requires bq.import on the project; closed and cancelled projects are read-only (409).";
const versionNote = "Send the import's version; a newer one is a 409 version-conflict.";
const sheetIndexSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(BQ_IMPORT_LIMITS.maxSheets - 1);

/**
 * Before the multipart body is read: refuse a declared size over the limit (413), require a
 * valid session (401) and rate-limit uploads per user, so unauthenticated or abusive uploads are
 * never buffered.
 */
@Injectable()
export class BqUploadGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly security: AuthSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > BQ_IMPORT_LIMITS.maxFileBytes + 64 * 1024)
      throw new PayloadTooLargeException({
        message: "Workbooks may be at most 10 MB",
        code: "payload-too-large",
      });
    const principal = await this.auth.principal(req);
    await this.security.limit(`bq-upload:${principal.user.id}`, 60, 3_600);
    return true;
  }
}

@ApiTags("bq")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:id/bq", version: "1" })
export class BqController {
  constructor(
    private readonly auth: AuthService,
    private readonly viewer: BqViewerService,
    private readonly imports: BqImportsService,
    private readonly exports: BqExportService,
    private readonly templates: BqTemplatesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The project's current BQ version: bills, sections, summary, source import",
    description: `${viewNote} bq is null until a BQ has been imported. Items load per bill.`,
    operationId: "getBq",
  })
  @ApiOkResponse({ schema: openApi(bqResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.viewer.bq(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Get("bills/:billId")
  @ApiOperation({
    summary: "One bill of the current version with its sections and items",
    description: viewNote,
    operationId: "getBqBill",
  })
  @ApiOkResponse({ schema: openApi(bqBillResponseSchema) })
  @ApiNotFoundResponse({ description: "No such bill in the project's current BQ version" })
  async bill(@Param("id") id: string, @Param("billId") billId: string, @Req() req: Request) {
    return this.viewer.bill(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(billId),
      req,
    );
  }

  @Get("search")
  @ApiOperation({
    summary: "Items of the current version whose description or reference contains q",
    description: `${viewNote} At most 200 items (truncated: true when there are more).`,
    operationId: "searchBq",
  })
  @ApiQuery({ name: "q", required: true })
  @ApiOkResponse({ schema: openApi(bqSearchResponseSchema) })
  async search(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    return this.viewer.search(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      bqSearchQuerySchema.parse(query).q,
      req,
    );
  }

  @Get("export/xlsx")
  @ApiOperation({
    summary: "Download the current BQ version as Excel",
    description: `${viewNote} A summary sheet and one sheet per bill; text cells are neutralised against formula injection; amounts stay numeric.`,
    operationId: "exportBqExcel",
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces(CONTENT_TYPES.xlsx)
  async exportExcel(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    const { locale } = bqExportQuerySchema.parse(query);
    const file = await this.exports.xlsx(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get("export/pdf")
  @ApiOperation({
    summary: "Download the current BQ version as PDF (A4)",
    description: `${viewNote} Company and project header, KES amounts, page numbers, and a draft watermark while the version is a draft.`,
    operationId: "exportBqPdf",
  })
  @ApiQuery({ name: "locale", required: false, enum: ["en", "sw"] })
  @ApiProduces("application/pdf")
  async exportPdf(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    const { locale } = bqExportQuerySchema.parse(query);
    const file = await this.exports.pdf(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      locale,
      req,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.content.length,
    });
  }

  @Get("imports")
  @ApiOperation({
    summary: "Recent BQ imports of the project (newest first)",
    description: "Requires bq.import on the project.",
    operationId: "listBqImports",
  })
  @ApiOkResponse({ schema: openApi(bqImportsResponseSchema) })
  async list(@Param("id") id: string, @Req() req: Request) {
    return this.imports.list(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("imports")
  @UseGuards(BqUploadGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: BQ_IMPORT_LIMITS.maxFileBytes,
        files: 1,
        fields: 0,
        parts: 1,
        fieldNameSize: 50,
        headerPairs: 20,
      },
    }),
  )
  @ApiOperation({
    summary: "Upload an Excel BQ (.xlsx or .xls, at most 10 MB) and parse it",
    description: `${importNote} The type is checked from the content signature; zip packages are checked for bombs (over 100 MB uncompressed or 100:1) before parsing; the original is stored privately under a generated key with its SHA-256; the malware hook runs. Parsing happens in a sandboxed worker with time and memory limits. 201 with the import (status parsed, or failed with failureCode).`,
    operationId: "uploadBq",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiCreatedResponse({ schema: openApi(bqImportResponseSchema) })
  async upload(
    @Param("id") id: string,
    @UploadedFile() file: UploadedWorkbook | undefined,
    @Req() req: Request,
  ) {
    return this.imports.upload(await this.auth.principal(req), uuidSchema.parse(id), file, req);
  }

  @Get("imports/:importId")
  @ApiOperation({
    summary: "An import: source details, sheets, mapping, report, resolutions and status",
    description: "Requires bq.import on the project. While parsed, mapping is the proposal.",
    operationId: "getBqImport",
  })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async getImport(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Req() req: Request,
  ) {
    return this.imports.get(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      req,
    );
  }

  @Post("imports/:importId/parse")
  @HttpCode(200)
  @ApiOperation({
    summary: "Parse an uploaded workbook again (resumes an import left in uploaded)",
    description: `${importNote} Only from uploaded (409 invalid-import-state otherwise).`,
    operationId: "parseBqImport",
  })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async parse(@Param("id") id: string, @Param("importId") importId: string, @Req() req: Request) {
    return this.imports.parse(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      req,
    );
  }

  @Get("imports/:importId/sheets/:sheetIndex/rows")
  @ApiOperation({
    summary: "Raw rows of a parsed sheet for the mapping screen",
    description: "Requires bq.import. Cells are display text; formulas lists formula columns.",
    operationId: "getBqImportRows",
  })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "count", required: false })
  @ApiOkResponse({ schema: openApi(bqSheetRowsResponseSchema) })
  async rows(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Param("sheetIndex") sheetIndex: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.imports.rows(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      sheetIndexSchema.parse(sheetIndex),
      bqSheetRowsQuerySchema.parse(query),
      req,
    );
  }

  @Put("imports/:importId/mapping")
  @ApiOperation({
    summary: "Confirm the mapping: sheets, bill numbers and names, header and data rows, columns",
    description: `${importNote} ${versionNote} From parsed, mapped or validated; earlier validation and resolutions are discarded.`,
    operationId: "saveBqMapping",
  })
  @ApiBody({ schema: openApi(saveBqMappingRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  @ApiConflictResponse({ description: "Version conflict or invalid import state" })
  async saveMapping(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.imports.saveMapping(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      saveBqMappingRequestSchema.parse(body),
      req,
    );
  }

  @Post("imports/:importId/apply-template")
  @HttpCode(200)
  @ApiOperation({
    summary: "Apply a saved mapping template to every sheet with the same header signature",
    description: `${importNote} ${versionNote} 409 template-not-applicable when no sheet matches.`,
    operationId: "applyBqTemplate",
  })
  @ApiBody({ schema: openApi(applyBqTemplateRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async applyTemplate(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.imports.applyTemplate(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      applyBqTemplateRequestSchema.parse(body),
      req,
    );
  }

  @Post("imports/:importId/validate")
  @HttpCode(200)
  @ApiOperation({
    summary: "Build and validate the BQ from the mapping; store the validation report",
    description: `${importNote} ${versionNote} From mapped or validated.`,
    operationId: "validateBqImport",
  })
  @ApiBody({ schema: openApi(bqImportVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async validate(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.imports.validate(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      bqImportVersionRequestSchema.parse(body),
      req,
    );
  }

  @Put("imports/:importId/resolutions")
  @ApiOperation({
    summary: "Resolve findings per row and accept warnings (each with a reason); revalidates",
    description: `${importNote} ${versionNote} Row actions: computed, sheet (needs a reason), exclude.`,
    operationId: "resolveBqImport",
  })
  @ApiBody({ schema: openApi(saveBqResolutionsRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async resolve(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.imports.resolve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      saveBqResolutionsRequestSchema.parse(body),
      req,
    );
  }

  @Get("imports/:importId/preview")
  @ApiOperation({
    summary: "What a commit would create and how it differs from the current draft",
    description: "Requires bq.import. Changes nothing.",
    operationId: "previewBqImport",
  })
  @ApiOkResponse({ schema: openApi(bqPreviewResponseSchema) })
  async preview(@Param("id") id: string, @Param("importId") importId: string, @Req() req: Request) {
    return this.imports.preview(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      req,
    );
  }

  @Post("imports/:importId/commit")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Commit atomically: create the original-contract BQ (version 1, draft) or replace the draft",
    description: `${importNote} ${versionNote} 409 commit-blocked while errors are unresolved or warnings unaccepted; 409 validation-stale when the source, configuration or contract sum changed since validation; 409 bq-not-draft once approved.`,
    operationId: "commitBqImport",
  })
  @ApiBody({ schema: openApi(bqImportVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async commit(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.imports.commit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      bqImportVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("imports/:importId/abandon")
  @HttpCode(200)
  @ApiOperation({
    summary: "Abandon an unfinished import (its records and source are kept)",
    description: `Requires bq.import. ${versionNote}`,
    operationId: "abandonBqImport",
  })
  @ApiBody({ schema: openApi(bqImportVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqImportResponseSchema) })
  async abandon(
    @Param("id") id: string,
    @Param("importId") importId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.imports.abandon(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      bqImportVersionRequestSchema.parse(body),
      req,
    );
  }

  @Get("imports/:importId/source")
  @ApiOperation({
    summary: "Download the original uploaded workbook",
    description: "Requires bq.import. The SHA-256 is checked before the file is sent.",
    operationId: "downloadBqSource",
  })
  @ApiProduces(CONTENT_TYPES.xlsx, CONTENT_TYPES.xls)
  async source(@Param("id") id: string, @Param("importId") importId: string, @Req() req: Request) {
    const file = await this.imports.source(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(importId),
      req,
    );
    return new StreamableFile(file.content, {
      type: CONTENT_TYPES[file.fileType],
      disposition: contentDisposition(file.fileName),
      length: file.content.length,
    });
  }

  @Get("templates")
  @ApiOperation({
    summary: "The company's saved mapping templates",
    description: "Requires bq.import on the project.",
    operationId: "listBqTemplates",
  })
  @ApiOkResponse({ schema: openApi(bqTemplatesResponseSchema) })
  async listTemplates(@Param("id") id: string, @Req() req: Request) {
    return this.templates.list(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post("templates")
  @ApiOperation({
    summary: "Save a bill sheet's confirmed mapping as a company template",
    description:
      "Requires bq.import. The header signature and column offsets come from the import.",
    operationId: "createBqTemplate",
  })
  @ApiBody({ schema: openApi(createBqTemplateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(bqTemplateResponseSchema) })
  @ApiConflictResponse({ description: "Another template has this name" })
  async createTemplate(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.templates.create(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createBqTemplateRequestSchema.parse(body),
      req,
    );
  }

  @Delete("templates/:templateId")
  @ApiOperation({
    summary: "Delete a saved mapping template",
    description: "Requires bq.import on the project.",
    operationId: "deleteBqTemplate",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteTemplate(
    @Param("id") id: string,
    @Param("templateId") templateId: string,
    @Req() req: Request,
  ) {
    return this.templates.remove(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(templateId),
      req,
    );
  }
}
