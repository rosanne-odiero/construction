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
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { APPROVAL_REQUEST_KINDS, INSTRUCTION_KINDS, INSTRUCTION_LIFECYCLE } from "@pm-buddy/types";
import {
  approvalListQuerySchema,
  approvalListResponseSchema,
  approvalResponseRequestSchema,
  approvalResponseSchema,
  cancelApprovalRequestSchema,
  idempotencyKeySchema,
  instructionAttachmentRequestSchema,
  instructionLogListResponseSchema,
  instructionLogQuerySchema,
  instructionLogResponseSchema,
  instructionOptionsResponseSchema,
  instructionResponseRequestSchema,
  raiseApprovalRequestSchema,
  recordInstructionRequestSchema,
  updateInstructionLogRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { ApprovalsService } from "./approvals.service.js";
import { documentsProblem } from "./documents-access.js";
import { DocumentsDatabaseErrors } from "./documents-errors.js";
import { InstructionsLogService } from "./instructions-log.service.js";
import { READ_NOTE } from "./project-documents.controller.js";

const RECORD_NOTE =
  "Requires documents.manage, bq.edit or site.diary on the project (closed and cancelled projects: 409 project-read-only).";
const MANAGE_NOTE =
  "Requires documents.manage or bq.edit on the project (closed and cancelled projects: 409 project-read-only).";
const APPROVAL_MANAGE =
  "Requires documents.manage on the project (closed and cancelled projects: 409 project-read-only).";

function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw documentsProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

/**
 * The consultant instructions log (D8.4, ARCHITECTURE §4.13; D2.3's register extended): list,
 * options, record (offline-ready), details, responses that move the status, attachments.
 */
@ApiTags("documents")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/instructions", version: "1" })
@UseInterceptors(DocumentsDatabaseErrors)
export class ProjectInstructionsController {
  constructor(
    private readonly auth: AuthService,
    private readonly instructions: InstructionsLogService,
  ) {}

  private async args(req: Request, ...ids: string[]) {
    return [await this.auth.principal(req), ...ids.map((id) => uuidSchema.parse(id))] as const;
  }

  @Get()
  @ApiOperation({
    operationId: "listInstructionsLog",
    summary: "The instructions log: status, kind, cost/time flags, search; newest received first",
    description: READ_NOTE,
  })
  @ApiQuery({ name: "status", required: false, enum: [...INSTRUCTION_LIFECYCLE, "open"] })
  @ApiQuery({ name: "kind", required: false, enum: INSTRUCTION_KINDS })
  @ApiQuery({ name: "flag", required: false, enum: ["cost", "time"] })
  @ApiQuery({ name: "search", required: false, description: "Number, subject, issuer or firm" })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ schema: openApi(instructionLogListResponseSchema) })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.instructions.list(principal, project, instructionLogQuerySchema.parse(query), req);
  }

  @Get("options")
  @ApiOperation({
    operationId: "getInstructionOptions",
    summary:
      "Suggested numbers per kind, the project's delays, document versions and verified photos",
    description: READ_NOTE,
  })
  @ApiOkResponse({ schema: openApi(instructionOptionsResponseSchema) })
  async options(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.instructions.options(principal, project, req);
  }

  @Post()
  @ApiOperation({
    operationId: "recordInstruction",
    summary: "Record an instruction received (offline-ready)",
    description: `${RECORD_NOTE} Numbers are unique per project (409 instruction-number-taken); the date received is not in the future (422 instruction-date-future) nor before the date issued; a delay must be one of the project's (422 delay-not-found). A consultant may record an instruction as issued by themselves (issuedByMe), and then cannot acknowledge or action it. A replay with the same key and payload returns the original (Idempotency-Replayed: true); a changed payload is 409 idempotency-key-reused; the same ID with another key 409 instruction-id-conflict.`,
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "8–100 characters, generated once per instruction on the device.",
  })
  @ApiBody({ schema: openApi(recordInstructionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(instructionLogResponseSchema) })
  async record(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const [principal, project] = await this.args(req, projectId);
    const result = await this.instructions.record(
      principal,
      project,
      recordInstructionRequestSchema.parse(body),
      idempotencyKey(req),
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Get(":instructionId")
  @ApiOperation({
    operationId: "getInstructionLogEntry",
    summary: "An instruction with its responses, attachments, linked variations and delay",
    description: `${READ_NOTE} Attachments in a confidential category are shown as restricted.`,
  })
  @ApiOkResponse({ schema: openApi(instructionLogResponseSchema) })
  async detail(
    @Param("projectId") projectId: string,
    @Param("instructionId") instructionId: string,
    @Req() req: Request,
  ) {
    const [principal, project, instruction] = await this.args(req, projectId, instructionId);
    return this.instructions.detail(principal, project, instruction, req);
  }

  @Patch(":instructionId")
  @ApiOperation({
    operationId: "updateInstructionLogEntry",
    summary: "Correct an open instruction's details, flags or linked delay",
    description: `${MANAGE_NOTE} A closed instruction is locked (409 instruction-closed). Send the version you read (409 version-conflict).`,
  })
  @ApiBody({ schema: openApi(updateInstructionLogRequestSchema) })
  @ApiOkResponse({ schema: openApi(instructionLogResponseSchema) })
  async update(
    @Param("projectId") projectId: string,
    @Param("instructionId") instructionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, instruction] = await this.args(req, projectId, instructionId);
    return this.instructions.update(
      principal,
      project,
      instruction,
      updateInstructionLogRequestSchema.parse(body),
      req,
    );
  }

  @Post(":instructionId/responses")
  @HttpCode(200)
  @ApiOperation({
    operationId: "respondToInstruction",
    summary: "Add a note, or acknowledge, action, close or reopen an instruction (append-only)",
    description: `Notes, acknowledgements and actions: ${RECORD_NOTE} Closing and reopening: ${MANAGE_NOTE} received → acknowledged → actioned → closed; received or acknowledged → actioned (a note saying what was done) or closed (a note saying why); closed → received (reopen, with a reason); 409 invalid-transition otherwise, 422 note-required. Whoever recorded an instruction as its issuer cannot acknowledge or action it (409 instruction-issuer-cannot-respond). Send the version you read.`,
  })
  @ApiBody({ schema: openApi(instructionResponseRequestSchema) })
  @ApiOkResponse({ schema: openApi(instructionLogResponseSchema) })
  async respond(
    @Param("projectId") projectId: string,
    @Param("instructionId") instructionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, instruction] = await this.args(req, projectId, instructionId);
    return this.instructions.respond(
      principal,
      project,
      instruction,
      instructionResponseRequestSchema.parse(body),
      req,
    );
  }

  @Post(":instructionId/attachments")
  @HttpCode(200)
  @ApiOperation({
    operationId: "attachToInstruction",
    summary: "Attach a document version or a verified site photo of the project",
    description: `${RECORD_NOTE} At most 10 (409 attachment-limit), never twice (409 attachment-exists), not on a closed instruction (409 instruction-closed); photos must be verified general site photos (422 photo-not-verified).`,
  })
  @ApiBody({ schema: openApi(instructionAttachmentRequestSchema) })
  @ApiOkResponse({ schema: openApi(instructionLogResponseSchema) })
  async attach(
    @Param("projectId") projectId: string,
    @Param("instructionId") instructionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, instruction] = await this.args(req, projectId, instructionId);
    return this.instructions.attach(
      principal,
      project,
      instruction,
      instructionAttachmentRequestSchema.parse(body),
      req,
    );
  }
}

/** Approval requests sent to consultants (D8.4, ARCHITECTURE §4.13, decision D-117). */
@ApiTags("documents")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/approvals", version: "1" })
@UseInterceptors(DocumentsDatabaseErrors)
export class ProjectApprovalsController {
  constructor(
    private readonly auth: AuthService,
    private readonly approvals: ApprovalsService,
  ) {}

  private async args(req: Request, ...ids: string[]) {
    return [await this.auth.principal(req), ...ids.map((id) => uuidSchema.parse(id))] as const;
  }

  @Get()
  @ApiOperation({
    operationId: "listApprovalRequests",
    summary: "Approval requests, newest first, with overdue flags (Nairobi dates)",
    description: READ_NOTE,
  })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["pending", "overdue", "decided", "cancelled", "all"],
  })
  @ApiQuery({ name: "kind", required: false, enum: APPROVAL_REQUEST_KINDS })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ schema: openApi(approvalListResponseSchema) })
  async list(@Param("projectId") projectId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.approvals.list(principal, project, approvalListQuerySchema.parse(query), req);
  }

  @Post()
  @ApiOperation({
    operationId: "raiseApprovalRequest",
    summary: "Ask a consultant to approve a material sample, shop drawing or method statement",
    description: `${APPROVAL_MANAGE} The document version must be the current version of an active document of the project (409 approval-document-not-current); sent not in the future, due on or after it (422 approval-date-invalid). A resubmission names a rejected or "resubmit" request, once (409 approval-resubmission-invalid). Numbered APR-NNNN per project.`,
  })
  @ApiBody({ schema: openApi(raiseApprovalRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(approvalResponseSchema) })
  async raise(@Param("projectId") projectId: string, @Body() body: unknown, @Req() req: Request) {
    const [principal, project] = await this.args(req, projectId);
    return this.approvals.raise(principal, project, raiseApprovalRequestSchema.parse(body), req);
  }

  @Get(":approvalId")
  @ApiOperation({
    operationId: "getApprovalRequest",
    summary: "An approval request with its response or cancellation",
    description: READ_NOTE,
  })
  @ApiOkResponse({ schema: openApi(approvalResponseSchema) })
  async detail(
    @Param("projectId") projectId: string,
    @Param("approvalId") approvalId: string,
    @Req() req: Request,
  ) {
    const [principal, project, approval] = await this.args(req, projectId, approvalId);
    return this.approvals.detail(principal, project, approval, req);
  }

  @Post(":approvalId/response")
  @HttpCode(200)
  @ApiOperation({
    operationId: "respondToApprovalRequest",
    summary: "Record the one response: approved, approved with comments, rejected or resubmit",
    description: `${APPROVAL_MANAGE} In the app (channel in_app) the responder is the signed-in user, who must neither have raised the request (403 approval-raiser-cannot-respond) nor uploaded the version (403 approval-uploader-cannot-respond). A paper response (channel paper) records an external consultant's signed answer: their name and the scan as another document version of the project (422 approval-evidence-invalid); anyone with documents.manage may record it. documentSha256 must be the SHA-256 of the version sent (409 approval-digest-mismatch). Comments are required unless approved; the response date is between the date sent and today. Only a pending request is answered (409 approval-not-pending).`,
  })
  @ApiBody({ schema: openApi(approvalResponseRequestSchema) })
  @ApiOkResponse({ schema: openApi(approvalResponseSchema) })
  async respond(
    @Param("projectId") projectId: string,
    @Param("approvalId") approvalId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, approval] = await this.args(req, projectId, approvalId);
    return this.approvals.respond(
      principal,
      project,
      approval,
      approvalResponseRequestSchema.parse(body),
      req,
    );
  }

  @Post(":approvalId/cancel")
  @HttpCode(200)
  @ApiOperation({
    operationId: "cancelApprovalRequest",
    summary: "Cancel a pending request with a reason (its raiser only; final)",
    description: `${APPROVAL_MANAGE} Only the person who raised it (403 invalid-transition); only while pending (409 approval-not-pending).`,
  })
  @ApiBody({ schema: openApi(cancelApprovalRequestSchema) })
  @ApiOkResponse({ schema: openApi(approvalResponseSchema) })
  async cancel(
    @Param("projectId") projectId: string,
    @Param("approvalId") approvalId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, project, approval] = await this.args(req, projectId, approvalId);
    return this.approvals.cancel(
      principal,
      project,
      approval,
      cancelApprovalRequestSchema.parse(body),
      req,
    );
  }
}
