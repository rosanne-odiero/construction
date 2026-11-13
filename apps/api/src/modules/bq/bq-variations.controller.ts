import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  approveBaselineRequestSchema,
  approveVariationRequestSchema,
  bqBillResponseSchema,
  bqCompareQuerySchema,
  bqCompareResponseSchema,
  bqContractSumResponseSchema,
  bqItemLinkResponseSchema,
  bqVersionResponseSchema,
  bqVersionsResponseSchema,
  cancelVariationRequestSchema,
  createInstructionRequestSchema,
  createVariationRequestSchema,
  instructionListQuerySchema,
  instructionResponseSchema,
  instructionsResponseSchema,
  linkBuildupRequestSchema,
  rejectVariationRequestSchema,
  saveVariationLinesRequestSchema,
  updateInstructionRequestSchema,
  updateVariationRequestSchema,
  variationListQuerySchema,
  variationResponseSchema,
  variationsResponseSchema,
  variationVersionRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BqVersionsService } from "./bq-versions.service.js";
import { BqViewerService } from "./bq-viewer.service.js";
import { BuildupsService } from "./buildups.service.js";
import { InstructionsService } from "./instructions.service.js";
import { VariationsService } from "./variations.service.js";

const viewNote = "Requires bq.view on the project (role ∩ assignment).";
const editNote =
  "Requires bq.edit on the project; closed and cancelled projects are read-only (409 project-read-only).";
const versionNote = "Send the record's version; a newer one is a 409 version-conflict.";
const approveNote =
  "Requires bq.approve_variation on the project and MFA verified within five minutes (403 step-up-required); the approver must not be the maker (403 maker-checker).";

/**
 * BQ versions, Architect's/Engineer's Instructions, Variation Orders and BQ item build-up links
 * (D2.3, ARCHITECTURE §4.3). The project comes from the URL and is resolved inside the caller's
 * company; another company's IDs behave like unknown IDs (404).
 */
@ApiTags("bq")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:id/bq", version: "1" })
export class BqVariationsController {
  constructor(
    private readonly auth: AuthService,
    private readonly versions: BqVersionsService,
    private readonly viewer: BqViewerService,
    private readonly instructions: InstructionsService,
    private readonly variations: VariationsService,
    private readonly buildups: BuildupsService,
  ) {}

  // Versions ----------------------------------------------------------------------------------

  @Get("versions")
  @ApiOperation({
    summary: "Every version of the project's BQ, newest first, with lineage and approval",
    description: viewNote,
    operationId: "listBqVersions",
  })
  @ApiOkResponse({ schema: openApi(bqVersionsResponseSchema) })
  async listVersions(@Param("id") id: string, @Req() req: Request) {
    return this.versions.list(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Get("versions/compare")
  @ApiOperation({
    summary: "Compare two versions: items added, removed and changed, bill subtotals, totals",
    description: `${viewNote} Items are matched by lineage, bills by bill lineage.`,
    operationId: "compareBqVersions",
  })
  @ApiQuery({ name: "from", required: true })
  @ApiQuery({ name: "to", required: true })
  @ApiOkResponse({ schema: openApi(bqCompareResponseSchema) })
  async compare(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    const { from, to } = bqCompareQuerySchema.parse(query);
    return this.versions.compare(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      from,
      to,
      req,
    );
  }

  @Get("versions/:versionId/bills/:billId")
  @ApiOperation({
    summary: "One bill of a given version (for example a variation's base) with its items",
    description: viewNote,
    operationId: "getBqVersionBill",
  })
  @ApiOkResponse({ schema: openApi(bqBillResponseSchema) })
  @ApiNotFoundResponse({ description: "No such bill in that version of this project's BQ" })
  async versionBill(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Param("billId") billId: string,
    @Req() req: Request,
  ) {
    return this.viewer.bill(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(billId),
      req,
      uuidSchema.parse(versionId),
    );
  }

  @Post("versions/:versionId/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve the imported draft (version 1) as the contract baseline",
    description: `${approveNote} Someone other than the uploader or committer of the import. ${versionNote} Afterwards the version never changes and re-import is refused (409 bq-not-draft).`,
    operationId: "approveBqBaseline",
  })
  @ApiBody({ schema: openApi(approveBaselineRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqVersionResponseSchema) })
  @ApiForbiddenResponse({ description: "Permission, step-up or maker-checker refusal" })
  @ApiConflictResponse({ description: "Already approved or version conflict" })
  async approveBaseline(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.versions.approveBaseline(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(versionId),
      approveBaselineRequestSchema.parse(body),
      req,
    );
  }

  @Get("contract-sum")
  @ApiOperation({
    summary: "Original vs revised contract sum, approved and pending variations (with VAT)",
    description: `${viewNote} Pending (submitted) variations are reported separately and never added into the revised sum.`,
    operationId: "getBqContractSum",
  })
  @ApiOkResponse({ schema: openApi(bqContractSumResponseSchema) })
  async contractSum(@Param("id") id: string, @Req() req: Request) {
    return this.versions.contractSum(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  // Instructions ------------------------------------------------------------------------------

  @Get("instructions")
  @ApiOperation({
    summary: "The project's Architect's/Engineer's Instructions register",
    description: viewNote,
    operationId: "listInstructions",
  })
  @ApiQuery({ name: "status", required: false, enum: ["open", "closed"] })
  @ApiOkResponse({ schema: openApi(instructionsResponseSchema) })
  async listInstructions(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    return this.instructions.list(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      instructionListQuerySchema.parse(query),
      req,
    );
  }

  @Post("instructions")
  @ApiOperation({
    summary: "Register an instruction (number unique per project)",
    description: `${editNote} 409 instruction-number-taken.`,
    operationId: "createInstruction",
  })
  @ApiBody({ schema: openApi(createInstructionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(instructionResponseSchema) })
  async createInstruction(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.instructions.create(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createInstructionRequestSchema.parse(body),
      req,
    );
  }

  @Get("instructions/:instructionId")
  @ApiOperation({
    summary: "One instruction",
    description: viewNote,
    operationId: "getInstruction",
  })
  @ApiOkResponse({ schema: openApi(instructionResponseSchema) })
  async getInstruction(
    @Param("id") id: string,
    @Param("instructionId") instructionId: string,
    @Req() req: Request,
  ) {
    return this.instructions.get(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(instructionId),
      req,
    );
  }

  @Patch("instructions/:instructionId")
  @ApiOperation({
    summary: "Change an instruction's details or close/reopen it",
    description: `${editNote} ${versionNote}`,
    operationId: "updateInstruction",
  })
  @ApiBody({ schema: openApi(updateInstructionRequestSchema) })
  @ApiOkResponse({ schema: openApi(instructionResponseSchema) })
  async updateInstruction(
    @Param("id") id: string,
    @Param("instructionId") instructionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.instructions.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(instructionId),
      updateInstructionRequestSchema.parse(body),
      req,
    );
  }

  // Variations --------------------------------------------------------------------------------

  @Get("variations")
  @ApiOperation({
    summary: "The project's variation orders, newest first, optionally by status",
    description: viewNote,
    operationId: "listVariations",
  })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["draft", "submitted", "approved", "rejected", "cancelled"],
  })
  @ApiOkResponse({ schema: openApi(variationsResponseSchema) })
  async listVariations(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    return this.variations.list(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      variationListQuerySchema.parse(query),
      req,
    );
  }

  @Post("variations")
  @ApiOperation({
    summary: "Raise a draft variation against an open instruction and the newest approved version",
    description: `${editNote} 409 baseline-not-approved until the original BQ is approved; 409 instruction-closed.`,
    operationId: "createVariation",
  })
  @ApiBody({ schema: openApi(createVariationRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(variationResponseSchema) })
  async createVariation(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.variations.create(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createVariationRequestSchema.parse(body),
      req,
    );
  }

  @Get("variations/:variationId")
  @ApiOperation({
    summary: "A variation with its lines, totals, projection, snapshot, decision and history",
    description: viewNote,
    operationId: "getVariation",
  })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async getVariation(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Req() req: Request,
  ) {
    return this.variations.get(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      req,
    );
  }

  @Patch("variations/:variationId")
  @ApiOperation({
    summary: "Change a draft variation's title, description or instruction",
    description: `${editNote} ${versionNote}`,
    operationId: "updateVariation",
  })
  @ApiBody({ schema: openApi(updateVariationRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async updateVariation(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      updateVariationRequestSchema.parse(body),
      req,
    );
  }

  @Put("variations/:variationId/lines")
  @ApiOperation({
    summary: "Replace a draft variation's lines (adjust, omit or add), priced against its base",
    description: `${editNote} ${versionNote} 400 variation-line-invalid names the line and the reason.`,
    operationId: "saveVariationLines",
  })
  @ApiBody({ schema: openApi(saveVariationLinesRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async saveLines(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.saveLines(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      saveVariationLinesRequestSchema.parse(body),
      req,
    );
  }

  @Post("variations/:variationId/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a draft: freezes the proposal and its snapshot digest",
    description: `${editNote} ${versionNote} 409 variation-empty, variation-stale (rebase first), line-no-change.`,
    operationId: "submitVariation",
  })
  @ApiBody({ schema: openApi(variationVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async submit(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.submit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      variationVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("variations/:variationId/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a submitted variation and create the next BQ version in one transaction",
    description: `${approveNote} Send the version and the snapshot digest you reviewed: a changed snapshot or a base that is no longer the newest approved version is 409 variation-stale. Approvals for one BQ run one at a time.`,
    operationId: "approveVariation",
  })
  @ApiBody({ schema: openApi(approveVariationRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async approve(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      approveVariationRequestSchema.parse(body),
      req,
    );
  }

  @Post("variations/:variationId/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a submitted variation with a reason",
    description:
      "Requires bq.approve_variation; not the maker (403 maker-checker); the reviewed snapshot digest and version; a reason of at least three characters.",
    operationId: "rejectVariation",
  })
  @ApiBody({ schema: openApi(rejectVariationRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async reject(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.reject(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      rejectVariationRequestSchema.parse(body),
      req,
    );
  }

  @Post("variations/:variationId/reopen")
  @HttpCode(200)
  @ApiOperation({
    summary: "Return a rejected variation to draft",
    description: `${editNote} ${versionNote}`,
    operationId: "reopenVariation",
  })
  @ApiBody({ schema: openApi(variationVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async reopen(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.reopen(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      variationVersionRequestSchema.parse(body),
      req,
    );
  }

  @Post("variations/:variationId/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel a draft variation with a reason",
    description: `${editNote} ${versionNote}`,
    operationId: "cancelVariation",
  })
  @ApiBody({ schema: openApi(cancelVariationRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async cancel(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      cancelVariationRequestSchema.parse(body),
      req,
    );
  }

  @Post("variations/:variationId/rebase")
  @HttpCode(200)
  @ApiOperation({
    summary: "Re-point a stale variation to the newest approved version and return it to draft",
    description: `${editNote} ${versionNote} 409 variation-not-stale when its base is already the newest.`,
    operationId: "rebaseVariation",
  })
  @ApiBody({ schema: openApi(variationVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(variationResponseSchema) })
  async rebase(
    @Param("id") id: string,
    @Param("variationId") variationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.variations.rebase(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(variationId),
      variationVersionRequestSchema.parse(body),
      req,
    );
  }

  // Item build-up links -----------------------------------------------------------------------

  @Get("items/:lineageId/rate-buildup")
  @ApiOperation({
    summary: "The build-up version an item (by lineage) is linked to, if any",
    description: viewNote,
    operationId: "getBqItemBuildup",
  })
  @ApiOkResponse({ schema: openApi(bqItemLinkResponseSchema) })
  async getLink(
    @Param("id") id: string,
    @Param("lineageId") lineageId: string,
    @Req() req: Request,
  ) {
    return this.buildups.getLink(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(lineageId),
      req,
    );
  }

  @Put("items/:lineageId/rate-buildup")
  @ApiOperation({
    summary: "Link an item of the current approved version to a build-up version",
    description: `${editNote} The build-up unit must equal the item's normalised unit (422 unit-mismatch, item-unit-missing, item-unit-unknown); 409 bq-not-approved while the baseline is a draft.`,
    operationId: "linkBqItemBuildup",
  })
  @ApiBody({ schema: openApi(linkBuildupRequestSchema) })
  @ApiOkResponse({ schema: openApi(bqItemLinkResponseSchema) })
  async link(
    @Param("id") id: string,
    @Param("lineageId") lineageId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.buildups.link(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(lineageId),
      linkBuildupRequestSchema.parse(body),
      req,
    );
  }

  @Delete("items/:lineageId/rate-buildup")
  @ApiOperation({
    summary: "Unlink an item from its build-up (the link is kept as history)",
    description: editNote,
    operationId: "unlinkBqItemBuildup",
  })
  @ApiOkResponse({ schema: openApi(bqItemLinkResponseSchema) })
  async unlink(
    @Param("id") id: string,
    @Param("lineageId") lineageId: string,
    @Req() req: Request,
  ) {
    return this.buildups.unlink(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(lineageId),
      req,
    );
  }
}
