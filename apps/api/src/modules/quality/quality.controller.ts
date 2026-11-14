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
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  completionActionRequestSchema,
  completionResponseSchema,
  correctCubeResultRequestSchema,
  correctSlumpTestRequestSchema,
  createCubeSetRequestSchema,
  createInspectionRequestSchema,
  createSlumpTestRequestSchema,
  createSnagRequestSchema,
  cubeSetResponseSchema,
  cubeSetsQuerySchema,
  cubeSetsResponseSchema,
  inspectionActionRequestSchema,
  inspectionDetailResponseSchema,
  inspectionsQuerySchema,
  inspectionsResponseSchema,
  proposeCompletionRequestSchema,
  qualitySummaryResponseSchema,
  recordCubeResultRequestSchema,
  slumpTestResponseSchema,
  slumpTestsQuerySchema,
  slumpTestsResponseSchema,
  snagActionRequestSchema,
  snagResponseSchema,
  snagsQuerySchema,
  snagsResponseSchema,
  updateInspectionRequestSchema,
  updateSnagRequestSchema,
  voidCubeSetRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { CompletionService } from "./completion.service.js";
import { ConcreteService } from "./concrete.service.js";
import { InspectionsService } from "./inspections.service.js";
import { QualitySettingsService } from "./quality-settings.service.js";
import { SnagsService } from "./snags.service.js";

const read =
  "Requires projects.view plus one of quality.manage, site.diary, site.photos, projects.manage, reports.view or safety.manage on the project (role ∩ assignment); clients and suppliers are refused.";
const record =
  "Requires site.diary or quality.manage on the project; closed and cancelled projects are read-only (409 project-read-only).";
const review =
  "Requires quality.manage on the project; closed and cancelled projects are read-only (409 project-read-only).";
const version = "Send the version you read; a newer one is a 409 version-conflict.";
const page = [
  { name: "cursor", description: "nextCursor from the preceding page (a record number)" },
  { name: "limit", description: "1–100 records; defaults to 30" },
  { name: "search", description: "Matches the number (for example 12 or SNG-0012) or the text" },
];

/** A project's quality records (D6.1): inspections, concrete tests, snags and completion. */
@ApiTags("quality")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/quality", version: "1" })
export class QualityController {
  constructor(
    private readonly auth: AuthService,
    private readonly inspections: InspectionsService,
    private readonly snags: SnagsService,
    private readonly concrete: ConcreteService,
    private readonly completion: CompletionService,
    private readonly settings: QualitySettingsService,
  ) {}

  private async args(req: Request, projectId: string) {
    return [await this.auth.principal(req), uuidSchema.parse(projectId)] as const;
  }

  @Get("summary")
  @ApiOperation({
    operationId: "getQualitySummary",
    summary:
      "Counts for the quality area: inspections, overdue and failed tests, snags, completion",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(qualitySummaryResponseSchema) })
  async summary(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, id] = await this.args(req, projectId);
    return this.settings.summary(principal, id, req);
  }

  // Inspections ---------------------------------------------------------------------------------

  @Get("inspections")
  @ApiOperation({
    operationId: "listInspections",
    summary: "Inspections, newest number first",
    description: read,
  })
  @ApiQuery({ name: "status", required: false, enum: ["draft", "submitted", "signed_off"] })
  @ApiQuery({ name: "result", required: false, enum: ["pass", "fail"] })
  @ApiQuery({ ...page[0]!, required: false })
  @ApiQuery({ ...page[1]!, required: false })
  @ApiQuery({ ...page[2]!, required: false })
  @ApiOkResponse({ schema: openApi(inspectionsResponseSchema) })
  async listInspections(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inspections.list(principal, id, inspectionsQuerySchema.parse(query), req);
  }

  @Post("inspections")
  @ApiOperation({
    operationId: "createInspection",
    summary: "Start an inspection from the current version of a checklist template",
    description: `${record} The items are copied from the template version (409 template-not-current or template-retired). Optional links: a WBS node, a schedule task, an item of the newest approved BQ (422 bq-item-not-found). The date cannot be in the future (409 quality-date-future).`,
  })
  @ApiBody({ schema: openApi(createInspectionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(inspectionDetailResponseSchema) })
  async createInspection(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inspections.create(principal, id, createInspectionRequestSchema.parse(body), req);
  }

  @Get("inspections/:inspectionId")
  @ApiOperation({
    operationId: "getInspection",
    summary: "An inspection with its checklist items, photos and the snags raised from it",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(inspectionDetailResponseSchema) })
  async getInspection(
    @Param("projectId") projectId: string,
    @Param("inspectionId") inspectionId: string,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inspections.get(principal, id, uuidSchema.parse(inspectionId), req);
  }

  @Patch("inspections/:inspectionId")
  @ApiOperation({
    operationId: "updateInspection",
    summary: "Edit a draft inspection and answer its items (pass, fail, N/A, note, photos)",
    description: `${record} Only the author, only while a draft (403 inspection-author-required, 409 inspection-not-draft). Photos are this project's site photos (422 photo-not-in-project), at most six per item. ${version}`,
  })
  @ApiBody({ schema: openApi(updateInspectionRequestSchema) })
  @ApiOkResponse({ schema: openApi(inspectionDetailResponseSchema) })
  async updateInspection(
    @Param("projectId") projectId: string,
    @Param("inspectionId") inspectionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inspections.update(
      principal,
      id,
      uuidSchema.parse(inspectionId),
      updateInspectionRequestSchema.parse(body),
      req,
    );
  }

  @Post("inspections/:inspectionId/actions")
  @HttpCode(200)
  @ApiOperation({
    operationId: "transitionInspection",
    summary: "Submit (author), or sign off / return with a reason (independent quality.manage)",
    description: `Submit: ${record} every item answered and every failed item explained (409 inspection-incomplete). Sign off or return: ${review} never the author or submitter (403 inspection-independent-review). A signed-off inspection is locked. ${version}`,
  })
  @ApiBody({ schema: openApi(inspectionActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(inspectionDetailResponseSchema) })
  async inspectionAction(
    @Param("projectId") projectId: string,
    @Param("inspectionId") inspectionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inspections.action(
      principal,
      id,
      uuidSchema.parse(inspectionId),
      inspectionActionRequestSchema.parse(body),
      req,
    );
  }

  // Snags ---------------------------------------------------------------------------------------

  @Get("snags")
  @ApiOperation({
    operationId: "listSnags",
    summary: "Snags and defects, newest number first, with project counts",
    description: read,
  })
  @ApiQuery({ name: "status", required: false, enum: ["open", "fixed", "closed", "active"] })
  @ApiQuery({ name: "severity", required: false, enum: ["critical", "major", "minor"] })
  @ApiQuery({ name: "phase", required: false, enum: ["construction", "dlp"] })
  @ApiQuery({ ...page[0]!, required: false })
  @ApiQuery({ ...page[1]!, required: false })
  @ApiQuery({ ...page[2]!, required: false })
  @ApiOkResponse({ schema: openApi(snagsResponseSchema) })
  async listSnags(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.snags.list(principal, id, snagsQuerySchema.parse(query), req);
  }

  @Post("snags")
  @ApiOperation({
    operationId: "createSnag",
    summary: "Raise a snag (optionally from a failed inspection item) with photos",
    description: `${record} From an inspection item: the item failed and its inspection was submitted (409 snag-item-not-failed). After practical completion is certified the snag is a defects liability period (dlp) defect.`,
  })
  @ApiBody({ schema: openApi(createSnagRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(snagResponseSchema) })
  async createSnag(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.snags.create(principal, id, createSnagRequestSchema.parse(body), req);
  }

  @Get("snags/:snagId")
  @ApiOperation({ operationId: "getSnag", summary: "A snag", description: read })
  @ApiOkResponse({ schema: openApi(snagResponseSchema) })
  async getSnag(
    @Param("projectId") projectId: string,
    @Param("snagId") snagId: string,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.snags.get(principal, id, uuidSchema.parse(snagId), req);
  }

  @Patch("snags/:snagId")
  @ApiOperation({
    operationId: "updateSnag",
    summary: "Edit an open snag (location, description, severity, responsible party, due date)",
    description: `${review} Severity decides whether completion is blocked, so edits need quality.manage. Only open snags (409 snag-not-open). ${version}`,
  })
  @ApiBody({ schema: openApi(updateSnagRequestSchema) })
  @ApiOkResponse({ schema: openApi(snagResponseSchema) })
  async updateSnag(
    @Param("projectId") projectId: string,
    @Param("snagId") snagId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.snags.update(
      principal,
      id,
      uuidSchema.parse(snagId),
      updateSnagRequestSchema.parse(body),
      req,
    );
  }

  @Post("snags/:snagId/actions")
  @HttpCode(200)
  @ApiOperation({
    operationId: "transitionSnag",
    summary: "Record a fix (with note and photos), or close / reopen it (independent verifier)",
    description: `Fix: ${record} Close or reopen (reason): ${review} never whoever recorded the fix (403 snag-independent-verification). Closed snags are final. ${version}`,
  })
  @ApiBody({ schema: openApi(snagActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(snagResponseSchema) })
  async snagAction(
    @Param("projectId") projectId: string,
    @Param("snagId") snagId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.snags.action(
      principal,
      id,
      uuidSchema.parse(snagId),
      snagActionRequestSchema.parse(body),
      req,
    );
  }

  // Concrete tests ------------------------------------------------------------------------------

  @Get("cubes")
  @ApiOperation({
    operationId: "listCubeSets",
    summary: "Concrete cube sets with their 7- and 28-day results, due and overdue flags",
    description: `${read} Rule KE-CUBE-1 (COMPLIANCE-REVIEW CR-QA-01): at 28 days a set passes when the mean is at least the class strength and no cube is below it by more than 3 N/mm²; 7-day results are indicative. A result is overdue after its due date plus the company's grace days (Africa/Nairobi).`,
  })
  @ApiQuery({ name: "filter", required: false, enum: ["all", "overdue", "failed"] })
  @ApiQuery({ ...page[0]!, required: false })
  @ApiQuery({ ...page[1]!, required: false })
  @ApiQuery({ ...page[2]!, required: false })
  @ApiOkResponse({ schema: openApi(cubeSetsResponseSchema) })
  async listCubes(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.listCubes(principal, id, cubeSetsQuerySchema.parse(query), req);
  }

  @Post("cubes")
  @ApiOperation({
    operationId: "createCubeSet",
    summary: "Record a set of cubes cast from a pour (element, class, cast date)",
    description: `${record} The cast date cannot be in the future (409 quality-date-future).`,
  })
  @ApiBody({ schema: openApi(createCubeSetRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(cubeSetResponseSchema) })
  async createCubes(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.createCubes(principal, id, createCubeSetRequestSchema.parse(body), req);
  }

  @Get("cubes/:cubeSetId")
  @ApiOperation({
    operationId: "getCubeSet",
    summary: "A cube set with every result version (corrections included)",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(cubeSetResponseSchema) })
  async getCubes(
    @Param("projectId") projectId: string,
    @Param("cubeSetId") cubeSetId: string,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.getCubes(principal, id, uuidSchema.parse(cubeSetId), req);
  }

  @Post("cubes/:cubeSetId/results")
  @ApiOperation({
    operationId: "recordCubeResult",
    summary: "Record the 7- or 28-day crushing results (N/mm² per cube)",
    description: `${record} Once per age (409 cube-result-exists: correct it instead); immutable once recorded. Tested on or after casting (422 cube-tested-before-cast), not in the future. The mean and outcome are computed by the server and re-checked by the database.`,
  })
  @ApiBody({ schema: openApi(recordCubeResultRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(cubeSetResponseSchema) })
  async recordResult(
    @Param("projectId") projectId: string,
    @Param("cubeSetId") cubeSetId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.recordResult(
      principal,
      id,
      uuidSchema.parse(cubeSetId),
      recordCubeResultRequestSchema.parse(body),
      req,
    );
  }

  @Post("cubes/:cubeSetId/results/:resultId/corrections")
  @ApiOperation({
    operationId: "correctCubeResult",
    summary: "Correct a result: a new version that references the original, with a reason",
    description: `${review} Only the current version can be corrected (409 cube-result-superseded); the original stays readable.`,
  })
  @ApiBody({ schema: openApi(correctCubeResultRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(cubeSetResponseSchema) })
  async correctResult(
    @Param("projectId") projectId: string,
    @Param("cubeSetId") cubeSetId: string,
    @Param("resultId") resultId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.correctResult(
      principal,
      id,
      uuidSchema.parse(cubeSetId),
      uuidSchema.parse(resultId),
      correctCubeResultRequestSchema.parse(body),
      req,
    );
  }

  @Post("cubes/:cubeSetId/void")
  @HttpCode(200)
  @ApiOperation({
    operationId: "voidCubeSet",
    summary: "Void a cube set entered in error, with a reason",
    description: `${review} A void set is never due and takes no more results (409 cube-set-void). ${version}`,
  })
  @ApiBody({ schema: openApi(voidCubeSetRequestSchema) })
  @ApiOkResponse({ schema: openApi(cubeSetResponseSchema) })
  async voidCubes(
    @Param("projectId") projectId: string,
    @Param("cubeSetId") cubeSetId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.voidCubes(
      principal,
      id,
      uuidSchema.parse(cubeSetId),
      voidCubeSetRequestSchema.parse(body),
      req,
    );
  }

  @Get("slump-tests")
  @ApiOperation({
    operationId: "listSlumpTests",
    summary: "Slump tests (current versions), newest number first",
    description: `${read} Rule KE-SLUMP-1 (COMPLIANCE-REVIEW CR-QA-02): a test passes when the measured slump is within the tolerance of the target.`,
  })
  @ApiQuery({ name: "outcome", required: false, enum: ["pass", "fail"] })
  @ApiQuery({ ...page[0]!, required: false })
  @ApiQuery({ ...page[1]!, required: false })
  @ApiQuery({ ...page[2]!, required: false })
  @ApiOkResponse({ schema: openApi(slumpTestsResponseSchema) })
  async listSlump(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.listSlump(principal, id, slumpTestsQuerySchema.parse(query), req);
  }

  @Post("slump-tests")
  @ApiOperation({
    operationId: "createSlumpTest",
    summary: "Record a slump test (target, tolerance and measured slump in mm)",
    description: `${record} Immutable once recorded; the outcome is computed by the server and checked by the database.`,
  })
  @ApiBody({ schema: openApi(createSlumpTestRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(slumpTestResponseSchema) })
  async createSlump(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.createSlump(principal, id, createSlumpTestRequestSchema.parse(body), req);
  }

  @Get("slump-tests/:slumpTestId")
  @ApiOperation({
    operationId: "getSlumpTest",
    summary: "A slump test's current version and its history",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(slumpTestResponseSchema) })
  async getSlump(
    @Param("projectId") projectId: string,
    @Param("slumpTestId") slumpTestId: string,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.getSlump(principal, id, uuidSchema.parse(slumpTestId), req);
  }

  @Post("slump-tests/:slumpTestId/corrections")
  @ApiOperation({
    operationId: "correctSlumpTest",
    summary: "Correct a slump test: a new version that references the original, with a reason",
    description: `${review} Only the current version (409 slump-test-superseded); number, site and cube set stay.`,
  })
  @ApiBody({ schema: openApi(correctSlumpTestRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(slumpTestResponseSchema) })
  async correctSlump(
    @Param("projectId") projectId: string,
    @Param("slumpTestId") slumpTestId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.concrete.correctSlump(
      principal,
      id,
      uuidSchema.parse(slumpTestId),
      correctSlumpTestRequestSchema.parse(body),
      req,
    );
  }

  // Completion and the defects liability period --------------------------------------------------

  @Get("completion")
  @ApiOperation({
    operationId: "getCompletion",
    summary: "Practical and final completion certificates, the DLP and what blocks completion",
    description: `${read} D6.3 releases retention against the certified practical and final certificates.`,
  })
  @ApiOkResponse({ schema: openApi(completionResponseSchema) })
  async getCompletion(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, id] = await this.args(req, projectId);
    return this.completion.get(principal, id, req);
  }

  @Post("completion")
  @ApiOperation({
    operationId: "proposeCompletion",
    summary: "Propose practical or final completion",
    description:
      "Requires projects.manage on the project; read-only projects refused. One live certificate per kind (409 completion-exists). Practical: refused while critical snags are open unless exceptionReason is given (409 completion-open-critical-snags); the DLP defaults to the company setting (1–24 months). Final: needs certified practical completion (409 completion-practical-required), a date on or after the DLP end (409 completion-dlp-not-ended) and no open snags unless excepted (409 completion-open-snags). Dates cannot be in the future.",
  })
  @ApiBody({ schema: openApi(proposeCompletionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(completionResponseSchema) })
  async proposeCompletion(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.completion.propose(principal, id, proposeCompletionRequestSchema.parse(body), req);
  }

  @Post("completion/:completionId/actions")
  @HttpCode(200)
  @ApiOperation({
    operationId: "transitionCompletion",
    summary: "Certify (independent quality.manage) or withdraw with a reason (projects.manage)",
    description: `Certify: ${review} never the proposer (403 completion-independent); the snag checks are repeated. A certified certificate is locked. ${version}`,
  })
  @ApiBody({ schema: openApi(completionActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(completionResponseSchema) })
  async completionAction(
    @Param("projectId") projectId: string,
    @Param("completionId") completionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.completion.action(
      principal,
      id,
      uuidSchema.parse(completionId),
      completionActionRequestSchema.parse(body),
      req,
    );
  }
}
