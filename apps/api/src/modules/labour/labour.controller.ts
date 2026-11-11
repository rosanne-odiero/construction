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
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  accreditationAlertsQuerySchema,
  accreditationAlertsResponseSchema,
  addGangMemberRequestSchema,
  createAccreditationRequestSchema,
  createEngagementRequestSchema,
  createGangRequestSchema,
  createLabourRateRequestSchema,
  createLabourViewRequestSchema,
  createSkillLevelRequestSchema,
  createTradeRequestSchema,
  doNotRehireRequestSchema,
  endEngagementRequestSchema,
  gangDetailResponseSchema,
  gangListQuerySchema,
  gangsResponseSchema,
  labourerListQuerySchema,
  labourerResponseSchema,
  labourersResponseSchema,
  labourerStatusRequestSchema,
  labourRateListQuerySchema,
  labourRateResponseSchema,
  labourRatesResponseSchema,
  labourSetupResponseSchema,
  labourViewResponseSchema,
  labourViewsResponseSchema,
  leaveGangRequestSchema,
  messageResponseSchema,
  recordConsentRequestSchema,
  registerLabourerRequestSchema,
  resolvedRateQuerySchema,
  resolvedRateResponseSchema,
  revealRequestSchema,
  revealResponseSchema,
  skillLevelResponseSchema,
  tradeResponseSchema,
  updateAccreditationRequestSchema,
  updateGangRequestSchema,
  updateLabourerRequestSchema,
  updateLabourSettingsRequestSchema,
  updateSkillLevelRequestSchema,
  updateTradeRequestSchema,
  withdrawConsentRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { GangsService } from "./gangs.service.js";
import { LabourersService } from "./labourers.service.js";
import { LabourRatesService } from "./rates.service.js";
import { LabourRecordsService } from "./records.service.js";
import { LabourSetupService } from "./setup.service.js";
import { LabourViewsService } from "./views.service.js";

const onLabourer =
  "Requires the permission on a project the labourer is (or was) engaged on, or a company-wide role; labourers the caller cannot view are 404.";
const labourerResponse = { schema: openApi(labourerResponseSchema) };

@ApiTags("labour")
@UseGuards(BrowserGuard)
@Controller({ path: "labour", version: "1" })
export class LabourController {
  constructor(
    private readonly auth: AuthService,
    private readonly setup: LabourSetupService,
    private readonly rates: LabourRatesService,
    private readonly labourers: LabourersService,
    private readonly records: LabourRecordsService,
    private readonly views: LabourViewsService,
  ) {}

  // Configuration ---------------------------------------------------------------------------------

  @Get("setup")
  @ApiOperation({
    summary: "Trades, skill levels and labour settings of the company",
    description: "Requires labour.view somewhere or config.manage.",
    operationId: "getLabourSetup",
  })
  @ApiOkResponse({ schema: openApi(labourSetupResponseSchema) })
  async getSetup(@Req() req: Request) {
    return this.setup.get(await this.auth.principal(req), req);
  }

  @Post("setup/defaults")
  @HttpCode(200)
  @ApiOperation({
    summary: "Install the standard trades (brief §5.4) and NCA-aligned skill levels",
    description: "Requires config.manage. Adds only what is missing; existing entries are kept.",
    operationId: "installLabourDefaults",
  })
  @ApiOkResponse({ schema: openApi(labourSetupResponseSchema) })
  async installDefaults(@Req() req: Request) {
    return this.setup.installDefaults(await this.auth.principal(req), req);
  }

  @Post("trades")
  @ApiOperation({
    summary: "Add a trade",
    description: "Requires config.manage.",
    operationId: "createTrade",
  })
  @ApiBody({ schema: openApi(createTradeRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(tradeResponseSchema) })
  @ApiConflictResponse({ description: "trade-key-taken" })
  async createTrade(@Body() body: unknown, @Req() req: Request) {
    return this.setup.createTrade(
      await this.auth.principal(req),
      createTradeRequestSchema.parse(body),
      req,
    );
  }

  @Patch("trades/:id")
  @ApiOperation({
    summary: "Rename, reorder or (de)activate a trade",
    description: "Requires config.manage; send the version you read.",
    operationId: "updateTrade",
  })
  @ApiBody({ schema: openApi(updateTradeRequestSchema) })
  @ApiOkResponse({ schema: openApi(tradeResponseSchema) })
  async updateTrade(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.setup.updateTrade(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateTradeRequestSchema.parse(body),
      req,
    );
  }

  @Post("skill-levels")
  @ApiOperation({
    summary: "Add a skill level mapped to an NCA category",
    description: "Requires config.manage.",
    operationId: "createSkillLevel",
  })
  @ApiBody({ schema: openApi(createSkillLevelRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(skillLevelResponseSchema) })
  async createSkillLevel(@Body() body: unknown, @Req() req: Request) {
    return this.setup.createSkillLevel(
      await this.auth.principal(req),
      createSkillLevelRequestSchema.parse(body),
      req,
    );
  }

  @Patch("skill-levels/:id")
  @ApiOperation({
    summary: "Change a skill level",
    description: "Requires config.manage; send the version you read.",
    operationId: "updateSkillLevel",
  })
  @ApiBody({ schema: openApi(updateSkillLevelRequestSchema) })
  @ApiOkResponse({ schema: openApi(skillLevelResponseSchema) })
  async updateSkillLevel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.setup.updateSkillLevel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateSkillLevelRequestSchema.parse(body),
      req,
    );
  }

  @Put("settings")
  @ApiOperation({
    summary: "Change the NCA expiry alert lead time (labour.accreditation_alert_days)",
    description: "Requires config.manage; version 0 while the defaults apply.",
    operationId: "updateLabourSettings",
  })
  @ApiBody({ schema: openApi(updateLabourSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(labourSetupResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.setup.updateSettings(
      await this.auth.principal(req),
      updateLabourSettingsRequestSchema.parse(body),
      req,
    );
  }

  // Rates -----------------------------------------------------------------------------------------

  @Get("rates")
  @ApiOperation({
    summary: "Company rates, plus a project's rates with ?projectId=",
    description:
      "Requires labour.manage or finance.view (on the project when given). Includes effectiveTo, inForce and scheduled; the minimum-wage check is reported as not configured (COMPLIANCE-REVIEW CR-PAY-09).",
    operationId: "listLabourRates",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "labourerId", required: false })
  @ApiQuery({ name: "tradeId", required: false })
  @ApiOkResponse({ schema: openApi(labourRatesResponseSchema) })
  async listRates(@Query() query: unknown, @Req() req: Request) {
    return this.rates.list(
      await this.auth.principal(req),
      labourRateListQuerySchema.parse(query),
      req,
    );
  }

  @Post("rates")
  @ApiOperation({
    summary: "Add an effective-dated rate (never overwrites an earlier one)",
    description:
      "Company rates need config.manage; project and labourer rates labour.manage on the project. effectiveFrom must be today or later (400 rate-backdated).",
    operationId: "createLabourRate",
  })
  @ApiBody({ schema: openApi(createLabourRateRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(labourRateResponseSchema) })
  @ApiConflictResponse({ description: "rate-exists: a rate of this kind already starts that day" })
  async createRate(@Body() body: unknown, @Req() req: Request) {
    return this.rates.create(
      await this.auth.principal(req),
      createLabourRateRequestSchema.parse(body),
      req,
    );
  }

  @Delete("rates/:id")
  @ApiOperation({
    summary: "Cancel a rate that has not started yet",
    description:
      "Same permission as adding it; a rate in force cannot be removed (409 rate-in-force).",
    operationId: "cancelLabourRate",
  })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async cancelRate(@Param("id") id: string, @Req() req: Request) {
    return this.rates.cancel(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  // Labourers -------------------------------------------------------------------------------------

  @Get("labourers")
  @ApiOperation({
    summary: "The registry: labourers the caller can see, with masked identifiers",
    description:
      "Requires labour.view (company-wide roles see everyone; others see labourers engaged on their projects). Filters: status, tradeId, skillLevelId, projectId, gangId, accreditation (valid|expiring|expired|missing|attention), doNotRehire=true (managers), consent (withdrawn|outdated), search (name, worker number, or an exact full ID/phone/KRA PIN via blind index).",
    operationId: "listLabourers",
  })
  @ApiOkResponse({ schema: openApi(labourersResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.labourers.list(
      await this.auth.principal(req),
      labourerListQuerySchema.parse(query),
      req,
    );
  }

  @Post("labourers")
  @ApiOperation({
    summary: "Register a labourer with consent (under 18 refused)",
    description:
      "Requires labour.manage on projectId (or a company-wide role without one). 400 under-minimum-age; 409 duplicate-identity, kra-pin-taken or do-not-rehire-match (with `match`); a phone match with a flagged worker can be overridden with labour.do_not_rehire and doNotRehireOverride.reason.",
    operationId: "registerLabourer",
  })
  @ApiBody({ schema: openApi(registerLabourerRequestSchema) })
  @ApiCreatedResponse(labourerResponse)
  @ApiConflictResponse({ description: "duplicate-identity, kra-pin-taken, do-not-rehire-match" })
  async register(@Body() body: unknown, @Req() req: Request) {
    return this.labourers.register(
      await this.auth.principal(req),
      registerLabourerRequestSchema.parse(body),
      req,
    );
  }

  @Get("labourers/:id")
  @ApiOperation({
    summary: "A labourer's side panel: details, engagements, gangs, NCA cards, consent",
    description: `Requires labour.view. ${onLabourer} The do-not-rehire flag is shown to managers, its reason only with labour.do_not_rehire.`,
    operationId: "getLabourer",
  })
  @ApiOkResponse(labourerResponse)
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.labourers.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch("labourers/:id")
  @ApiOperation({
    summary: "Change a labourer's details or correct identifiers",
    description: `Requires labour.manage. ${onLabourer} Send the version you read.`,
    operationId: "updateLabourer",
  })
  @ApiBody({ schema: openApi(updateLabourerRequestSchema) })
  @ApiOkResponse(labourerResponse)
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.labourers.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateLabourerRequestSchema.parse(body),
      req,
    );
  }

  @Post("labourers/:id/status")
  @HttpCode(200)
  @ApiOperation({
    summary: "Set active, inactive or left",
    description: `Requires labour.manage. ${onLabourer} Leaving ends open engagements and gang memberships; reactivating a do-not-rehire worker needs labour.do_not_rehire and an override reason.`,
    operationId: "changeLabourerStatus",
  })
  @ApiBody({ schema: openApi(labourerStatusRequestSchema) })
  @ApiOkResponse(labourerResponse)
  async changeStatus(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.labourers.changeStatus(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      labourerStatusRequestSchema.parse(body),
      req,
    );
  }

  @Post("labourers/:id/reveal")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reveal one encrypted identifier in full (audited)",
    description: `Requires labour.view_sensitive and MFA verified within five minutes (403 step-up-required). ${onLabourer} The audit log records the field and purpose, never the value.`,
    operationId: "revealLabourerField",
  })
  @ApiBody({ schema: openApi(revealRequestSchema) })
  @ApiOkResponse({ schema: openApi(revealResponseSchema) })
  @ApiForbiddenResponse({ description: "Missing permission or stale MFA" })
  async reveal(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.labourers.reveal(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      revealRequestSchema.parse(body),
      req,
    );
  }

  @Put("labourers/:id/do-not-rehire")
  @ApiOperation({
    summary: "Set or clear the do-not-rehire flag with a reason",
    description: `Requires labour.do_not_rehire and MFA verified within five minutes. ${onLabourer} The reason is stored encrypted; the audit log notes only that one was given.`,
    operationId: "setDoNotRehire",
  })
  @ApiBody({ schema: openApi(doNotRehireRequestSchema) })
  @ApiOkResponse(labourerResponse)
  async setDoNotRehire(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.labourers.setDoNotRehire(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      doNotRehireRequestSchema.parse(body),
      req,
    );
  }

  @Get("labourers/:id/rate")
  @ApiOperation({
    summary: "The rate in force for a labourer on a project and date",
    description:
      "Requires labour.manage or finance.view on the project. Most specific scope wins: labourer on project, project trade + skill, project trade, company trade + skill, company trade; then the latest effectiveFrom on or before the date.",
    operationId: "resolveLabourerRate",
  })
  @ApiQuery({ name: "projectId", required: true })
  @ApiQuery({ name: "date", required: false })
  @ApiQuery({ name: "basis", required: false })
  @ApiOkResponse({ schema: openApi(resolvedRateResponseSchema) })
  async resolveRate(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    return this.rates.resolve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      resolvedRateQuerySchema.parse(query),
      req,
    );
  }

  @Post("labourers/:id/engagements")
  @ApiOperation({
    summary: "Engage an existing labourer on a project (rehire)",
    description:
      "Requires labour.manage on the project. Needs active consent and age 18 on the start date; a do-not-rehire worker needs labour.do_not_rehire and doNotRehireOverride.reason.",
    operationId: "engageLabourer",
  })
  @ApiBody({ schema: openApi(createEngagementRequestSchema) })
  @ApiCreatedResponse(labourerResponse)
  async engage(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.labourers.engage(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createEngagementRequestSchema.parse(body),
      req,
    );
  }

  @Post("labourers/:id/engagements/:engagementId/end")
  @HttpCode(200)
  @ApiOperation({
    summary: "End an engagement (and the gang memberships it supported)",
    description: "Requires labour.manage on the engagement's project.",
    operationId: "endEngagement",
  })
  @ApiBody({ schema: openApi(endEngagementRequestSchema) })
  @ApiOkResponse(labourerResponse)
  async endEngagement(
    @Param("id") id: string,
    @Param("engagementId") engagementId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.labourers.endEngagement(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(engagementId),
      endEngagementRequestSchema.parse(body),
      req,
    );
  }

  @Post("labourers/:id/accreditations")
  @ApiOperation({
    summary: "Add an NCA accreditation card",
    description: `Requires labour.manage. ${onLabourer}`,
    operationId: "addAccreditation",
  })
  @ApiBody({ schema: openApi(createAccreditationRequestSchema) })
  @ApiCreatedResponse(labourerResponse)
  async addAccreditation(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.records.addAccreditation(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createAccreditationRequestSchema.parse(body),
      req,
    );
  }

  @Patch("labourers/:id/accreditations/:accreditationId")
  @ApiOperation({
    summary: "Correct an NCA accreditation card",
    description: `Requires labour.manage. ${onLabourer}`,
    operationId: "updateAccreditation",
  })
  @ApiBody({ schema: openApi(updateAccreditationRequestSchema) })
  @ApiOkResponse(labourerResponse)
  async updateAccreditation(
    @Param("id") id: string,
    @Param("accreditationId") accreditationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.records.updateAccreditation(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(accreditationId),
      updateAccreditationRequestSchema.parse(body),
      req,
    );
  }

  @Delete("labourers/:id/accreditations/:accreditationId")
  @ApiOperation({
    summary: "Remove an NCA accreditation card entered by mistake",
    description: `Requires labour.manage. ${onLabourer}`,
    operationId: "removeAccreditation",
  })
  @ApiOkResponse(labourerResponse)
  async removeAccreditation(
    @Param("id") id: string,
    @Param("accreditationId") accreditationId: string,
    @Req() req: Request,
  ) {
    return this.records.removeAccreditation(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(accreditationId),
      req,
    );
  }

  @Post("labourers/:id/consents")
  @ApiOperation({
    summary: "Record consent to the current notice (EN/SW)",
    description: `Requires labour.consent. ${onLabourer} 409 consent-current when already recorded.`,
    operationId: "recordConsent",
  })
  @ApiBody({ schema: openApi(recordConsentRequestSchema) })
  @ApiCreatedResponse(labourerResponse)
  async recordConsent(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.records.recordConsent(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      recordConsentRequestSchema.parse(body),
      req,
    );
  }

  @Post("labourers/:id/consents/withdraw")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record the worker's withdrawal of consent",
    description: `Requires labour.consent. ${onLabourer} Records are kept; new engagements are refused until consent is recorded again.`,
    operationId: "withdrawConsent",
  })
  @ApiBody({ schema: openApi(withdrawConsentRequestSchema) })
  @ApiOkResponse(labourerResponse)
  async withdrawConsent(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.records.withdrawConsent(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      withdrawConsentRequestSchema.parse(body),
      req,
    );
  }

  @Get("accreditation-alerts")
  @ApiOperation({
    summary: "Expired, expiring and missing NCA accreditations of active labourers",
    description:
      "Requires labour.view; computed on read with the company's lead time (labour.accreditation_alert_days, default 30).",
    operationId: "listAccreditationAlerts",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiOkResponse({ schema: openApi(accreditationAlertsResponseSchema) })
  async alerts(@Query() query: unknown, @Req() req: Request) {
    return this.records.alerts(
      await this.auth.principal(req),
      accreditationAlertsQuerySchema.parse(query),
      req,
    );
  }

  // Saved views -----------------------------------------------------------------------------------

  @Get("views")
  @ApiOperation({
    summary: "Built-in registry views and the caller's saved views",
    description: "Requires labour.view. Saved views are private to the user in this company.",
    operationId: "listLabourViews",
  })
  @ApiOkResponse({ schema: openApi(labourViewsResponseSchema) })
  async listViews(@Req() req: Request) {
    return this.views.list(await this.auth.principal(req), req);
  }

  @Post("views")
  @ApiOperation({ summary: "Save the current filters as a view", operationId: "createLabourView" })
  @ApiBody({ schema: openApi(createLabourViewRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(labourViewResponseSchema) })
  async createView(@Body() body: unknown, @Req() req: Request) {
    return this.views.create(
      await this.auth.principal(req),
      createLabourViewRequestSchema.parse(body),
      req,
    );
  }

  @Delete("views/:id")
  @ApiOperation({ summary: "Delete one of your saved views", operationId: "deleteLabourView" })
  @ApiOkResponse({ schema: openApi(messageResponseSchema) })
  async deleteView(@Param("id") id: string, @Req() req: Request) {
    return this.views.remove(await this.auth.principal(req), uuidSchema.parse(id), req);
  }
}

@ApiTags("labour")
@UseGuards(BrowserGuard)
@Controller({ path: "labour/gangs", version: "1" })
export class GangsController {
  constructor(
    private readonly auth: AuthService,
    private readonly gangs: GangsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Gangs on projects where the caller holds labour.view",
    operationId: "listGangs",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiOkResponse({ schema: openApi(gangsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.gangs.list(await this.auth.principal(req), gangListQuerySchema.parse(query), req);
  }

  @Post()
  @ApiOperation({
    summary: "Create a gang on a project (optionally at one of its sites)",
    description: "Requires labour.manage on the project.",
    operationId: "createGang",
  })
  @ApiBody({ schema: openApi(createGangRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(gangDetailResponseSchema) })
  @ApiConflictResponse({ description: "gang-name-taken" })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.gangs.create(
      await this.auth.principal(req),
      createGangRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "A gang with its membership history", operationId: "getGang" })
  @ApiOkResponse({ schema: openApi(gangDetailResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.gangs.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Rename a gang, change its site or leader, or archive it",
    description: "Requires labour.manage on the project; the leader must be a current member.",
    operationId: "updateGang",
  })
  @ApiBody({ schema: openApi(updateGangRequestSchema) })
  @ApiOkResponse({ schema: openApi(gangDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.gangs.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateGangRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/members")
  @ApiOperation({
    summary: "Add an engaged labourer to the gang",
    description: "Requires labour.manage; one gang per labourer and project at a time.",
    operationId: "addGangMember",
  })
  @ApiBody({ schema: openApi(addGangMemberRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(gangDetailResponseSchema) })
  async addMember(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.gangs.addMember(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      addGangMemberRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/members/:membershipId/leave")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record that a member left the gang",
    description: "Requires labour.manage; the leader must be changed first.",
    operationId: "leaveGang",
  })
  @ApiBody({ schema: openApi(leaveGangRequestSchema) })
  @ApiOkResponse({ schema: openApi(gangDetailResponseSchema) })
  async leave(
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.gangs.leave(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(membershipId),
      leaveGangRequestSchema.parse(body ?? {}),
      req,
    );
  }
}
