import {
  Body,
  Controller,
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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  addFirstAiderRequestSchema,
  addIncidentPhotosRequestSchema,
  closeIncidentRequestSchema,
  correctiveActionActionRequestSchema,
  correctiveActionResponseSchema,
  correctiveActionsQuerySchema,
  correctiveActionsResponseSchema,
  createCorrectiveActionRequestSchema,
  createFirstAidKitRequestSchema,
  createInductionRequestSchema,
  createToolboxTalkRequestSchema,
  firstAiderResponseSchema,
  firstAidKitResponseSchema,
  firstAidQuerySchema,
  firstAidResponseSchema,
  incidentDetailResponseSchema,
  incidentsQuerySchema,
  incidentsResponseSchema,
  inductionResponseSchema,
  inductionsQuerySchema,
  inductionsResponseSchema,
  inductionStatusQuerySchema,
  inductionStatusResponseSchema,
  investigateIncidentRequestSchema,
  issuePpeRequestSchema,
  linkTreatmentRequestSchema,
  ppeIssueResponseSchema,
  ppeIssuesResponseSchema,
  ppeQuerySchema,
  recordKitCheckRequestSchema,
  recordTreatmentRequestSchema,
  regulatorDecisionRequestSchema,
  reportIncidentRequestSchema,
  returnPpeRequestSchema,
  safetyOptionsResponseSchema,
  safetySummaryResponseSchema,
  toolboxTalkActionRequestSchema,
  toolboxTalkResponseSchema,
  toolboxTalksQuerySchema,
  toolboxTalksResponseSchema,
  treatmentResponseSchema,
  updateCorrectiveActionRequestSchema,
  updateIncidentRequestSchema,
  updateToolboxTalkRequestSchema,
  voidRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { CorrectiveActionsService } from "./corrective-actions.service.js";
import { FirstAidService } from "./first-aid.service.js";
import { IncidentsService } from "./incidents.service.js";
import { InductionsService } from "./inductions.service.js";
import { PpeService } from "./ppe.service.js";
import { SafetySettingsService } from "./safety-settings.service.js";
import { ToolboxTalksService } from "./toolbox-talks.service.js";

const read =
  "Requires projects.view plus one of safety.manage, site.diary or projects.manage on the project (role ∩ assignment); clients, suppliers, labourers and office roles without a site permission are refused (403).";
const record =
  "Requires site.diary or safety.manage on the project; closed and cancelled projects are read-only (409 project-read-only).";
const manage =
  "Requires safety.manage on the project; closed and cancelled projects are read-only (409 project-read-only).";
const version = "Send the version you read; a newer one is a 409 version-conflict.";
const personal =
  "People and injury details are null for callers without safety.manage, and are never written to the audit log.";
const keyset = { name: "cursor", required: false, description: "nextCursor (a record number)" };
const offset = { name: "cursor", required: false, description: "nextCursor (a row offset)" };
const limit = { name: "limit", required: false, description: "1–100 rows; defaults to 30" };
const search = { name: "search", required: false, description: "Number or text" };

/**
 * A project's health and safety records (D8.2, ARCHITECTURE §4.9): inductions and their status
 * against attendance, toolbox talks, the PPE register, incidents with investigation, the regulator
 * decision and closing, corrective actions, and first aid.
 */
@ApiTags("safety")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/safety", version: "1" })
export class SafetyController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: SafetySettingsService,
    private readonly inductions: InductionsService,
    private readonly talks: ToolboxTalksService,
    private readonly ppe: PpeService,
    private readonly incidents: IncidentsService,
    private readonly actions: CorrectiveActionsService,
    private readonly firstAid: FirstAidService,
  ) {}

  private async args(req: Request, projectId: string, ...ids: string[]) {
    return [
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      ...ids.map((id) => uuidSchema.parse(id)),
    ] as const;
  }

  @Get("summary")
  @ApiOperation({
    operationId: "getSafetySummary",
    summary: "Counts for the health and safety area and the caller's permissions",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(safetySummaryResponseSchema) })
  async summary(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, id] = await this.args(req, projectId);
    return this.settings.summary(principal, id, req);
  }

  @Get("options")
  @ApiOperation({
    operationId: "getSafetyOptions",
    summary: "Staff who can read safety records, active gangs and the induction checklist",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(safetyOptionsResponseSchema) })
  async options(@Param("projectId") projectId: string, @Req() req: Request) {
    const [principal, id] = await this.args(req, projectId);
    return this.settings.options(principal, id, req);
  }

  // Inductions ---------------------------------------------------------------------------------

  @Get("inductions")
  @ApiOperation({
    operationId: "listInductions",
    summary: "Inductions, newest first",
    description: read,
  })
  @ApiQuery({ name: "siteId", required: false })
  @ApiQuery({ name: "personKind", required: false, enum: ["labourer", "staff", "visitor"] })
  @ApiQuery({ name: "status", required: false, enum: ["recorded", "voided"] })
  @ApiQuery(search)
  @ApiQuery(keyset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(inductionsResponseSchema) })
  async listInductions(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inductions.list(principal, id, inductionsQuerySchema.parse(query), req);
  }

  @Post("inductions")
  @ApiOperation({
    operationId: "createInduction",
    summary: "Record that a labourer, staff member or named visitor was inducted at a site",
    description: `${record} The inductor needs site.diary or safety.manage on the project (422 staff-not-on-project); a labourer must be engaged on it (422 labourer-not-on-project); topics come from the company checklist and are copied (422 induction-topic-unknown). The date cannot be in the future (409 safety-date-future).`,
  })
  @ApiBody({ schema: openApi(createInductionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(inductionResponseSchema) })
  async createInduction(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inductions.create(principal, id, createInductionRequestSchema.parse(body), req);
  }

  @Post("inductions/:inductionId/void")
  @HttpCode(200)
  @ApiOperation({
    operationId: "voidInduction",
    summary: "Void an induction recorded in error (with a reason); it is never edited",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(voidRequestSchema) })
  @ApiOkResponse({ schema: openApi(inductionResponseSchema) })
  async voidInduction(
    @Param("projectId") projectId: string,
    @Param("inductionId") inductionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, induction] = await this.args(req, projectId, inductionId);
    return this.inductions.void(principal, id, induction, voidRequestSchema.parse(body), req);
  }

  @Get("induction-status")
  @ApiOperation({
    operationId: "getInductionStatus",
    summary: "Induction status per labourer at a site, flagging attendance without an induction",
    description: `${read} Labourers engaged on the project, or who worked at the site in the company's look-back window, with their newest induction there and the days in the window they worked there without a valid one (read from attendance, which is never blocked). Flagged first.`,
  })
  @ApiQuery({ name: "siteId", required: true })
  @ApiQuery({ name: "filter", required: false, enum: ["all", "not_inducted", "flagged"] })
  @ApiQuery(search)
  @ApiQuery(offset)
  @ApiQuery({ ...limit, description: "1–100 rows; defaults to 50" })
  @ApiOkResponse({ schema: openApi(inductionStatusResponseSchema) })
  async inductionStatus(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.inductions.status(principal, id, inductionStatusQuerySchema.parse(query), req);
  }

  // Toolbox talks ------------------------------------------------------------------------------

  @Get("talks")
  @ApiOperation({
    operationId: "listToolboxTalks",
    summary: "Toolbox talks, newest first",
    description: read,
  })
  @ApiQuery({ name: "siteId", required: false })
  @ApiQuery({ name: "status", required: false, enum: ["draft", "confirmed", "cancelled"] })
  @ApiQuery(search)
  @ApiQuery(keyset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(toolboxTalksResponseSchema) })
  async listTalks(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.talks.list(principal, id, toolboxTalksQuerySchema.parse(query), req);
  }

  @Post("talks")
  @ApiOperation({
    operationId: "createToolboxTalk",
    summary: "Record a toolbox talk with its attendees, as a draft or confirmed (locked) at once",
    description: `${record} Attendees: every member of the chosen gangs on the day plus the labourers picked (engaged on the project; 422 labourer-not-on-project, gang-not-in-project). The presenter needs site.diary or safety.manage; the optional photo must be from the talk's site (422 photo-not-on-site). Confirming needs at least one attendee (409 talk-no-attendees).`,
  })
  @ApiBody({ schema: openApi(createToolboxTalkRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(toolboxTalkResponseSchema) })
  async createTalk(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.talks.create(principal, id, createToolboxTalkRequestSchema.parse(body), req);
  }

  @Get("talks/:talkId")
  @ApiOperation({
    operationId: "getToolboxTalk",
    summary: "A toolbox talk with its attendees",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(toolboxTalkResponseSchema) })
  async getTalk(
    @Param("projectId") projectId: string,
    @Param("talkId") talkId: string,
    @Req() req: Request,
  ) {
    const [principal, id, talk] = await this.args(req, projectId, talkId);
    return this.talks.get(principal, id, talk, req);
  }

  @Put("talks/:talkId")
  @ApiOperation({
    operationId: "updateToolboxTalk",
    summary: "Replace a draft talk's details and attendees",
    description: `${record} Confirmed and cancelled talks are locked (409 invalid-transition). ${version}`,
  })
  @ApiBody({ schema: openApi(updateToolboxTalkRequestSchema) })
  @ApiOkResponse({ schema: openApi(toolboxTalkResponseSchema) })
  async updateTalk(
    @Param("projectId") projectId: string,
    @Param("talkId") talkId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, talk] = await this.args(req, projectId, talkId);
    return this.talks.update(principal, id, talk, updateToolboxTalkRequestSchema.parse(body), req);
  }

  @Post("talks/:talkId/actions")
  @HttpCode(200)
  @ApiOperation({
    operationId: "transitionToolboxTalk",
    summary: "Confirm (lock) a draft talk, or cancel it with a reason",
    description: `${record} ${version}`,
  })
  @ApiBody({ schema: openApi(toolboxTalkActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(toolboxTalkResponseSchema) })
  async talkAction(
    @Param("projectId") projectId: string,
    @Param("talkId") talkId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, talk] = await this.args(req, projectId, talkId);
    return this.talks.action(principal, id, talk, toolboxTalkActionRequestSchema.parse(body), req);
  }

  // PPE register -------------------------------------------------------------------------------

  @Get("ppe")
  @ApiOperation({
    operationId: "listPpeIssues",
    summary: "The PPE register: items still issued first, soonest replacement first",
    description: read,
  })
  @ApiQuery({ name: "siteId", required: false })
  @ApiQuery({ name: "labourerId", required: false })
  @ApiQuery({ name: "item", required: false })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["issued", "returned", "replaced", "voided", "due"],
  })
  @ApiQuery(search)
  @ApiQuery(offset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(ppeIssuesResponseSchema) })
  async listPpe(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.ppe.list(principal, id, ppeQuerySchema.parse(query), req);
  }

  @Post("ppe")
  @ApiOperation({
    operationId: "issuePpe",
    summary: "Issue PPE to a labourer (a register entry; no stock movement)",
    description: `${record} The replacement date is the issue date plus the company's period for the item, fixed at issue. A replacement names the issue it replaces, which must still be issued to the same labourer for the same item (409 ppe-replacement-invalid).`,
  })
  @ApiBody({ schema: openApi(issuePpeRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(ppeIssueResponseSchema) })
  async issuePpe(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.ppe.issue(principal, id, issuePpeRequestSchema.parse(body), req);
  }

  @Post("ppe/:issueId/return")
  @HttpCode(200)
  @ApiOperation({
    operationId: "returnPpe",
    summary: "Record an issued item's return and its condition",
    description: `${record} ${version}`,
  })
  @ApiBody({ schema: openApi(returnPpeRequestSchema) })
  @ApiOkResponse({ schema: openApi(ppeIssueResponseSchema) })
  async returnPpe(
    @Param("projectId") projectId: string,
    @Param("issueId") issueId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, issue] = await this.args(req, projectId, issueId);
    return this.ppe.returnIssue(principal, id, issue, returnPpeRequestSchema.parse(body), req);
  }

  @Post("ppe/:issueId/void")
  @HttpCode(200)
  @ApiOperation({
    operationId: "voidPpeIssue",
    summary: "Void a PPE issue recorded in error (with a reason)",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(voidRequestSchema) })
  @ApiOkResponse({ schema: openApi(ppeIssueResponseSchema) })
  async voidPpe(
    @Param("projectId") projectId: string,
    @Param("issueId") issueId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, issue] = await this.args(req, projectId, issueId);
    return this.ppe.void(principal, id, issue, voidRequestSchema.parse(body), req);
  }

  // Incidents ----------------------------------------------------------------------------------

  @Get("incidents")
  @ApiOperation({
    operationId: "listIncidents",
    summary: "Incidents and near misses, newest first",
    description: `${read} ${personal}`,
  })
  @ApiQuery({ name: "siteId", required: false })
  @ApiQuery({ name: "kind", required: false })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["reported", "investigated", "closed", "voided", "open"],
  })
  @ApiQuery(search)
  @ApiQuery(keyset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(incidentsResponseSchema) })
  async listIncidents(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.incidents.list(principal, id, incidentsQuerySchema.parse(query), req);
  }

  @Post("incidents")
  @ApiOperation({
    operationId: "reportIncident",
    summary: "Report an incident or near miss with the people involved and site photos",
    description: `${record} An injury names an injured person with two injury codes (type and body part); a near miss names none. People are labourers engaged on the project, company members or a name only. The time cannot be in the future (409 safety-date-future). ${personal}`,
  })
  @ApiBody({ schema: openApi(reportIncidentRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(incidentDetailResponseSchema) })
  async reportIncident(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.incidents.report(principal, id, reportIncidentRequestSchema.parse(body), req);
  }

  @Get("incidents/:incidentId")
  @ApiOperation({
    operationId: "getIncident",
    summary: "An incident with its corrective actions and first-aid treatments",
    description: `${read} ${personal}`,
  })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async getIncident(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.get(principal, id, incident, req);
  }

  @Patch("incidents/:incidentId")
  @ApiOperation({
    operationId: "updateIncident",
    summary: "Correct an open incident's details or people",
    description: `${manage} Closed and voided incidents are locked (409 incident-not-open). ${version}`,
  })
  @ApiBody({ schema: openApi(updateIncidentRequestSchema) })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async updateIncident(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.update(
      principal,
      id,
      incident,
      updateIncidentRequestSchema.parse(body),
      req,
    );
  }

  @Post("incidents/:incidentId/investigation")
  @HttpCode(200)
  @ApiOperation({
    operationId: "investigateIncident",
    summary: "Record (or revise) the investigation: root cause category and findings",
    description: `${manage} Moves a reported incident to investigated. ${version}`,
  })
  @ApiBody({ schema: openApi(investigateIncidentRequestSchema) })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async investigate(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.investigate(
      principal,
      id,
      incident,
      investigateIncidentRequestSchema.parse(body),
      req,
    );
  }

  @Post("incidents/:incidentId/regulator")
  @HttpCode(200)
  @ApiOperation({
    operationId: "recordRegulatorDecision",
    summary: "Record whether the regulator (DOSH) was notified, and when — COMPLIANCE-REVIEW",
    description: `${manage} Required before closing serious and fatal injuries and dangerous occurrences. The system files nothing; the legal thresholds and deadlines await review (CR-HS-01). ${version}`,
  })
  @ApiBody({ schema: openApi(regulatorDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async regulator(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.regulator(
      principal,
      id,
      incident,
      regulatorDecisionRequestSchema.parse(body),
      req,
    );
  }

  @Post("incidents/:incidentId/close")
  @HttpCode(200)
  @ApiOperation({
    operationId: "closeIncident",
    summary: "Close an investigated incident; it is then locked",
    description: `${manage} Every corrective action must be verified or cancelled, at least one verified unless a reason for none is given, and a required regulator decision recorded (409 incident-close-blocked, with the blockers). ${version}`,
  })
  @ApiBody({ schema: openApi(closeIncidentRequestSchema) })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async close(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.close(
      principal,
      id,
      incident,
      closeIncidentRequestSchema.parse(body),
      req,
    );
  }

  @Post("incidents/:incidentId/void")
  @HttpCode(200)
  @ApiOperation({
    operationId: "voidIncident",
    summary: "Void an incident reported in error (a duplicate) with a reason",
    description: `${manage} Open and done corrective actions must be cancelled first (409 incident-actions-outstanding). ${version}`,
  })
  @ApiBody({ schema: openApi(voidRequestSchema) })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async voidIncident(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.void(principal, id, incident, voidRequestSchema.parse(body), req);
  }

  @Post("incidents/:incidentId/photos")
  @HttpCode(200)
  @ApiOperation({
    operationId: "addIncidentPhotos",
    summary: "Add site photos of the incident's site (at most six)",
    description: `${record} ${version}`,
  })
  @ApiBody({ schema: openApi(addIncidentPhotosRequestSchema) })
  @ApiOkResponse({ schema: openApi(incidentDetailResponseSchema) })
  async addPhotos(
    @Param("projectId") projectId: string,
    @Param("incidentId") incidentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, incident] = await this.args(req, projectId, incidentId);
    return this.incidents.addPhotos(
      principal,
      id,
      incident,
      addIncidentPhotosRequestSchema.parse(body),
      req,
    );
  }

  // Corrective actions -------------------------------------------------------------------------

  @Get("corrective-actions")
  @ApiOperation({
    operationId: "listCorrectiveActions",
    summary: "Corrective actions: overdue first, then open by due date, done, verified",
    description: read,
  })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["open", "done", "verified", "cancelled", "active", "overdue"],
  })
  @ApiQuery({ name: "incidentId", required: false })
  @ApiQuery({ name: "mine", required: false, enum: ["true", "false"] })
  @ApiQuery(search)
  @ApiQuery(offset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(correctiveActionsResponseSchema) })
  async listActions(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.actions.list(principal, id, correctiveActionsQuerySchema.parse(query), req);
  }

  @Post("corrective-actions")
  @ApiOperation({
    operationId: "createCorrectiveAction",
    summary: "Raise a corrective action from an incident, an inspection, a toolbox talk or other",
    description: `${manage} The owner must be able to read safety records on the project (422 staff-not-on-project). The incident must be open (409 incident-not-open); a talk must be confirmed (422 action-source-invalid).`,
  })
  @ApiBody({ schema: openApi(createCorrectiveActionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(correctiveActionResponseSchema) })
  async createAction(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.actions.create(principal, id, createCorrectiveActionRequestSchema.parse(body), req);
  }

  @Get("corrective-actions/:actionId")
  @ApiOperation({
    operationId: "getCorrectiveAction",
    summary: "A corrective action",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(correctiveActionResponseSchema) })
  async getAction(
    @Param("projectId") projectId: string,
    @Param("actionId") actionId: string,
    @Req() req: Request,
  ) {
    const [principal, id, action] = await this.args(req, projectId, actionId);
    return this.actions.get(principal, id, action, req);
  }

  @Patch("corrective-actions/:actionId")
  @ApiOperation({
    operationId: "updateCorrectiveAction",
    summary: "Change an open action's description, owner or due date",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(updateCorrectiveActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(correctiveActionResponseSchema) })
  async updateAction(
    @Param("projectId") projectId: string,
    @Param("actionId") actionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, action] = await this.args(req, projectId, actionId);
    return this.actions.update(
      principal,
      id,
      action,
      updateCorrectiveActionRequestSchema.parse(body),
      req,
    );
  }

  @Post("corrective-actions/:actionId/actions")
  @HttpCode(200)
  @ApiOperation({
    operationId: "transitionCorrectiveAction",
    summary: "Mark done (the owner), verify or reject (independently), or cancel",
    description: `done: only the action's owner, any safety reader (403 action-owner-only). verify and reject: safety.manage, never the owner or whoever marked it done (403 action-independent-verification); reject and cancel need a reason. Actions of closed incidents are locked (409 incident-not-open). ${version}`,
  })
  @ApiBody({ schema: openApi(correctiveActionActionRequestSchema) })
  @ApiOkResponse({ schema: openApi(correctiveActionResponseSchema) })
  async actionTransition(
    @Param("projectId") projectId: string,
    @Param("actionId") actionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, action] = await this.args(req, projectId, actionId);
    return this.actions.action(
      principal,
      id,
      action,
      correctiveActionActionRequestSchema.parse(body),
      req,
    );
  }

  // First aid ----------------------------------------------------------------------------------

  @Get("first-aid")
  @ApiOperation({
    operationId: "getFirstAid",
    summary: "First-aid kits with their state, active first-aiders, and treatments (paged)",
    description: `${read} ${personal}`,
  })
  @ApiQuery({ name: "siteId", required: false })
  @ApiQuery(keyset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(firstAidResponseSchema) })
  async getFirstAid(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.firstAid.overview(principal, id, firstAidQuerySchema.parse(query), req);
  }

  @Post("first-aid/kits")
  @ApiOperation({
    operationId: "createFirstAidKit",
    summary: "Add a first-aid kit at a site",
    description: `${manage} Kit names are unique per site (409 kit-label-taken).`,
  })
  @ApiBody({ schema: openApi(createFirstAidKitRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(firstAidKitResponseSchema) })
  async createKit(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.firstAid.createKit(principal, id, createFirstAidKitRequestSchema.parse(body), req);
  }

  @Post("first-aid/kits/:kitId/checks")
  @ApiOperation({
    operationId: "recordKitCheck",
    summary: "Record a kit check: outcome and the earliest expiry of its contents (append-only)",
    description: `${record} Retired kits are not checked (409 kit-retired).`,
  })
  @ApiBody({ schema: openApi(recordKitCheckRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(firstAidKitResponseSchema) })
  async checkKit(
    @Param("projectId") projectId: string,
    @Param("kitId") kitId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, kit] = await this.args(req, projectId, kitId);
    return this.firstAid.checkKit(principal, id, kit, recordKitCheckRequestSchema.parse(body), req);
  }

  @Post("first-aid/kits/:kitId/retire")
  @HttpCode(200)
  @ApiOperation({
    operationId: "retireFirstAidKit",
    summary: "Retire a kit with a reason",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(voidRequestSchema) })
  @ApiOkResponse({ schema: openApi(firstAidKitResponseSchema) })
  async retireKit(
    @Param("projectId") projectId: string,
    @Param("kitId") kitId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, kit] = await this.args(req, projectId, kitId);
    return this.firstAid.retireKit(principal, id, kit, voidRequestSchema.parse(body), req);
  }

  @Post("first-aid/first-aiders")
  @ApiOperation({
    operationId: "addFirstAider",
    summary: "Name a trained first-aider at a site with the certificate's expiry",
    description: `${manage} A labourer engaged on the project or a company member, once per site (409 first-aider-exists).`,
  })
  @ApiBody({ schema: openApi(addFirstAiderRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(firstAiderResponseSchema) })
  async addFirstAider(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.firstAid.addFirstAider(principal, id, addFirstAiderRequestSchema.parse(body), req);
  }

  @Post("first-aid/first-aiders/:firstAiderId/remove")
  @HttpCode(200)
  @ApiOperation({
    operationId: "removeFirstAider",
    summary: "Remove a first-aider from a site with a reason",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(voidRequestSchema) })
  @ApiOkResponse({ schema: openApi(firstAiderResponseSchema) })
  async removeFirstAider(
    @Param("projectId") projectId: string,
    @Param("firstAiderId") firstAiderId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, aider] = await this.args(req, projectId, firstAiderId);
    return this.firstAid.removeFirstAider(principal, id, aider, voidRequestSchema.parse(body), req);
  }

  @Post("first-aid/treatments")
  @ApiOperation({
    operationId: "recordTreatment",
    summary: "Log a first-aid treatment (coded), optionally linked to an open incident",
    description: `${record} ${personal}`,
  })
  @ApiBody({ schema: openApi(recordTreatmentRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(treatmentResponseSchema) })
  async recordTreatment(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, projectId);
    return this.firstAid.recordTreatment(
      principal,
      id,
      recordTreatmentRequestSchema.parse(body),
      req,
    );
  }

  @Post("first-aid/treatments/:treatmentId/void")
  @HttpCode(200)
  @ApiOperation({
    operationId: "voidTreatment",
    summary: "Void a treatment recorded in error (with a reason)",
    description: `${manage} Treatments of closed incidents are locked. ${version}`,
  })
  @ApiBody({ schema: openApi(voidRequestSchema) })
  @ApiOkResponse({ schema: openApi(treatmentResponseSchema) })
  async voidTreatment(
    @Param("projectId") projectId: string,
    @Param("treatmentId") treatmentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, treatment] = await this.args(req, projectId, treatmentId);
    return this.firstAid.voidTreatment(
      principal,
      id,
      treatment,
      voidRequestSchema.parse(body),
      req,
    );
  }

  @Post("first-aid/treatments/:treatmentId/link")
  @HttpCode(200)
  @ApiOperation({
    operationId: "linkTreatment",
    summary: "Link a treatment to an open incident (once)",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(linkTreatmentRequestSchema) })
  @ApiOkResponse({ schema: openApi(treatmentResponseSchema) })
  async linkTreatment(
    @Param("projectId") projectId: string,
    @Param("treatmentId") treatmentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, treatment] = await this.args(req, projectId, treatmentId);
    return this.firstAid.linkTreatment(
      principal,
      id,
      treatment,
      linkTreatmentRequestSchema.parse(body),
      req,
    );
  }
}
