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
import { PLANT_ALERT_KINDS, PLANT_CATEGORIES, PLANT_STATUSES } from "@pm-buddy/types";
import {
  assignOperatorRequestSchema,
  closePlantRequestSchema,
  correctFuelRequestSchema,
  correctUsageRequestSchema,
  createPlantRequestSchema,
  endOperatorRequestSchema,
  idempotencyKeySchema,
  movePlantRequestSchema,
  plantAlertsQuerySchema,
  plantAlertsResponseSchema,
  plantDetailResponseSchema,
  plantFuelListResponseSchema,
  plantFuelResponseSchema,
  plantListQuerySchema,
  plantListResponseSchema,
  plantOptionsResponseSchema,
  plantRecordsQuerySchema,
  plantSettingsResponseSchema,
  plantUsageListResponseSchema,
  plantUsageResponseSchema,
  recordFuelRequestSchema,
  recordMeterResetRequestSchema,
  recordServiceRequestSchema,
  recordUsageRequestSchema,
  reportBreakdownRequestSchema,
  resolveBreakdownRequestSchema,
  updatePlantRequestSchema,
  updatePlantSettingsRequestSchema,
  voidServiceRequestSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { plantProblem } from "./plant-access.js";
import { PlantDatabaseErrors } from "./plant-errors.js";
import { PlantMaintenanceService } from "./plant-maintenance.service.js";
import { PlantOperatorsService } from "./plant-operators.js";
import { PlantRecordsService } from "./plant-records.service.js";
import { PlantRegisterService } from "./plant-register.service.js";

const read =
  "Requires projects.view plus one of plant.manage, site.diary, projects.manage, stores.manage, finance.view or finance.manage on at least one project (role ∩ assignment); clients, suppliers, consultants and labourers are refused (403). Records of projects the caller cannot read are left out and an item's location there shows as restricted. Hire rates and estimates are null without plant.manage, finance.view or finance.manage.";
const manage =
  "Requires plant.manage on the item's project (or on any project while the item is in the yard). Off-hired and disposed items are final (409 plant-closed).";
const record =
  "Requires site.diary or plant.manage on the site's project, which must not be closed or cancelled (409 project-read-only); the item must have been at the site that day (409 plant-not-on-site).";
const version = "Send the version you read; a newer one is a 409 version-conflict.";
const meter =
  "Meter readings may never go backwards in time (409 meter-out-of-order with the neighbouring readings) unless a meter reset lies between; a day is at most 24.0 hours or 1,500 km (409 meter-day-limit).";
const idempotency = {
  name: "Idempotency-Key",
  required: true,
  description:
    "8–100 characters, generated once per entry on the device. A replay with the same key and payload returns the original (Idempotency-Replayed: true); a changed payload is 409 idempotency-key-reused.",
};
const offset = { name: "cursor", required: false, description: "nextCursor (a row offset)" };
const limit = { name: "limit", required: false, description: "1–100 rows; defaults to 30" };

function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw plantProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

/**
 * The company plant register and each item's records (D8.3, ARCHITECTURE §4.11): items, moves,
 * operators, daily usage, fuel issues with the fuel variance, meter resets, breakdowns, services,
 * the alerts list and the company settings.
 */
@ApiTags("plant")
@UseGuards(BrowserGuard)
@Controller({ path: "plant", version: "1" })
@UseInterceptors(PlantDatabaseErrors)
export class PlantController {
  constructor(
    private readonly auth: AuthService,
    private readonly register: PlantRegisterService,
    private readonly operators: PlantOperatorsService,
    private readonly records: PlantRecordsService,
    private readonly maintenance: PlantMaintenanceService,
  ) {}

  private async args(req: Request, ...ids: string[]) {
    return [await this.auth.principal(req), ...ids.map((id) => uuidSchema.parse(id))] as const;
  }

  @Get()
  @ApiOperation({
    operationId: "listPlant",
    summary: "The plant register with each item's location, meter, service, hire and alerts",
    description: read,
  })
  @ApiQuery({ name: "status", required: false, enum: [...PLANT_STATUSES, "active"] })
  @ApiQuery({ name: "category", required: false, enum: PLANT_CATEGORIES })
  @ApiQuery({ name: "ownership", required: false, enum: ["owned", "hired"] })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "attention", required: false, enum: ["true"] })
  @ApiQuery({ name: "search", required: false, description: "Code, name, make or registration" })
  @ApiQuery(offset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(plantListResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    const [principal] = await this.args(req);
    return this.register.list(principal, plantListQuerySchema.parse(query), req);
  }

  @Get("alerts")
  @ApiOperation({
    operationId: "listPlantAlerts",
    summary:
      "What needs attention, critical first (fuel alerts are estimates, never proof of theft)",
    description: read,
  })
  @ApiQuery({ name: "kind", required: false, enum: PLANT_ALERT_KINDS })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery(offset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(plantAlertsResponseSchema) })
  async alerts(@Query() query: unknown, @Req() req: Request) {
    const [principal] = await this.args(req);
    return this.register.alerts(principal, plantAlertsQuerySchema.parse(query), req);
  }

  @Get("settings")
  @ApiOperation({
    operationId: "getPlantSettings",
    summary: "The company's fuel variance tolerance, minimum sample, hire and service windows",
    description: `${read} config.manage holders may always read them.`,
  })
  @ApiOkResponse({ schema: openApi(plantSettingsResponseSchema) })
  async settings(@Req() req: Request) {
    const [principal] = await this.args(req);
    return this.register.getSettings(principal, req);
  }

  @Put("settings")
  @ApiOperation({
    operationId: "updatePlantSettings",
    summary: "Change the company's plant settings",
    description: `Requires config.manage (company-level). ${version}`,
  })
  @ApiBody({ schema: openApi(updatePlantSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantSettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    const [principal] = await this.args(req);
    return this.register.updateSettings(
      principal,
      updatePlantSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Get("options")
  @ApiOperation({
    operationId: "getPlantOptions",
    summary: "Suppliers, LPOs and the sites the caller may move plant to",
    description: "Requires plant.manage on at least one project.",
  })
  @ApiOkResponse({ schema: openApi(plantOptionsResponseSchema) })
  async options(@Req() req: Request) {
    const [principal] = await this.args(req);
    return this.register.options(principal, req);
  }

  @Post()
  @ApiOperation({
    operationId: "registerPlant",
    summary: "Register an owned or hired item (in the yard, or straight onto a site)",
    description:
      "Requires plant.manage on at least one project, and on the site's project when a site is given. The code is unique in the company (409 plant-code-taken); a hired item needs a supplier from the register (422 supplier-not-found), a rate and a hire start; an LPO must be that supplier's (422 lpo-not-found).",
  })
  @ApiBody({ schema: openApi(createPlantRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantDetailResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    const [principal] = await this.args(req);
    return this.register.create(principal, createPlantRequestSchema.parse(body), req);
  }

  @Get(":plantId")
  @ApiOperation({
    operationId: "getPlant",
    summary:
      "An item with its moves, operators, breakdowns, services, meter resets and permissions",
    description: read,
  })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async detail(@Param("plantId") plantId: string, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.register.detail(principal, id, req);
  }

  @Patch(":plantId")
  @ApiOperation({
    operationId: "updatePlant",
    summary: "Change an item's details, hire terms, standard consumption or service intervals",
    description: `${manage} The code, ownership, meter, fuel type and opening reading are fixed. ${version}`,
  })
  @ApiBody({ schema: openApi(updatePlantRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async update(@Param("plantId") plantId: string, @Body() body: unknown, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.register.update(principal, id, updatePlantRequestSchema.parse(body), req);
  }

  @Post(":plantId/moves")
  @HttpCode(200)
  @ApiOperation({
    operationId: "movePlant",
    summary: "Move an item to a project site or back to the yard (append-only history)",
    description: `${manage} Also plant.manage on the destination project, which must be writable. A move is dated on or after the previous one and never strands usage or fuel recorded at the site it leaves (409 move-strands-records). ${version}`,
  })
  @ApiBody({ schema: openApi(movePlantRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async move(@Param("plantId") plantId: string, @Body() body: unknown, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.register.move(principal, id, movePlantRequestSchema.parse(body), req);
  }

  @Post(":plantId/close")
  @HttpCode(200)
  @ApiOperation({
    operationId: "closePlant",
    summary: "Send hired plant off hire or dispose of owned plant (final, with a reason)",
    description: `${manage} Open breakdowns must be resolved first (409 plant-has-open-breakdowns). The item returns to the yard and its operator assignments end. ${version}`,
  })
  @ApiBody({ schema: openApi(closePlantRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async close(@Param("plantId") plantId: string, @Body() body: unknown, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.register.close(principal, id, closePlantRequestSchema.parse(body), req);
  }

  @Post(":plantId/operators")
  @ApiOperation({
    operationId: "assignPlantOperator",
    summary: "Assign a labourer engaged on the project or a staff member to operate the item",
    description:
      "Requires plant.manage on the project. Overlapping assignments of the same person are refused (409 operator-overlap). A missing or expired certificate where the category needs one is flagged, never blocked (COMPLIANCE-REVIEW CR-PLT-01).",
  })
  @ApiBody({ schema: openApi(assignOperatorRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantDetailResponseSchema) })
  async assignOperator(
    @Param("plantId") plantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, plantId);
    return this.operators.assign(principal, id, assignOperatorRequestSchema.parse(body), req);
  }

  @Post(":plantId/operators/:assignmentId/end")
  @HttpCode(200)
  @ApiOperation({
    operationId: "endPlantOperator",
    summary: "End an operator assignment on a date (once)",
    description: `Requires plant.manage on the assignment's project. ${version}`,
  })
  @ApiBody({ schema: openApi(endOperatorRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async endOperator(
    @Param("plantId") plantId: string,
    @Param("assignmentId") assignmentId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, assignment] = await this.args(req, plantId, assignmentId);
    return this.operators.end(principal, id, assignment, endOperatorRequestSchema.parse(body), req);
  }

  @Get(":plantId/usage")
  @ApiOperation({
    operationId: "listPlantUsage",
    summary: "Daily usage, newest first, with corrections and 30-day totals",
    description: read,
  })
  @ApiQuery(offset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(plantUsageListResponseSchema) })
  async listUsage(@Param("plantId") plantId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.records.listUsage(principal, id, plantRecordsQuerySchema.parse(query), req);
  }

  @Post(":plantId/usage")
  @ApiOperation({
    operationId: "recordPlantUsage",
    summary:
      "Log a day's usage at a site: readings, working/idle/breakdown, operator, BQ item or cost code",
    description: `${record} One entry per item and day (409 usage-day-exists: correct it instead). ${meter} No working day while an unsafe breakdown is open (409 plant-unsafe); the operator must be assigned that day (422 operator-not-assigned). Offline-ready: client ID + Idempotency-Key. Nothing posts to the cost ledger.`,
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(recordUsageRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantUsageResponseSchema) })
  async recordUsage(
    @Param("plantId") plantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const [principal, id] = await this.args(req, plantId);
    const result = await this.records.recordUsage(
      principal,
      id,
      recordUsageRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Post(":plantId/usage/:logId/corrections")
  @ApiOperation({
    operationId: "correctPlantUsage",
    summary: "Correct (new values, same day) or void a usage entry with a reason; never an edit",
    description: `${record} By plant.manage or whoever recorded the entry; only the newest entry of a chain (409 record-superseded). ${meter} Offline-ready like a new entry.`,
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(correctUsageRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantUsageResponseSchema) })
  async correctUsage(
    @Param("plantId") plantId: string,
    @Param("logId") logId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const [principal, id, log] = await this.args(req, plantId, logId);
    const result = await this.records.correctUsage(
      principal,
      id,
      log,
      correctUsageRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Get(":plantId/fuel")
  @ApiOperation({
    operationId: "listPlantFuel",
    summary: "Fuel issues and the full-tank windows compared with the standard consumption",
    description: `${read} A window is over standard when its litres exceed the expected litres (meter advance × standard) by more than the company tolerance, once it covers the minimum sample: an estimate for review, never proof of theft.`,
  })
  @ApiQuery(offset)
  @ApiQuery(limit)
  @ApiOkResponse({ schema: openApi(plantFuelListResponseSchema) })
  async listFuel(@Param("plantId") plantId: string, @Query() query: unknown, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.records.listFuel(principal, id, plantRecordsQuerySchema.parse(query), req);
  }

  @Post(":plantId/fuel")
  @ApiOperation({
    operationId: "recordPlantFuel",
    summary: "Record fuel issued to an item with the meter reading at fuelling",
    description: `Requires site.diary, plant.manage or stores.manage on the site's project; the item must use fuel (409 plant-no-fuel) and have been at the site that day. ${meter} The standard consumption in force is copied on. The response carries the window this fuelling closed, if any. Offline-ready: client ID + Idempotency-Key. No stores or cost-ledger posting (decision D-93).`,
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(recordFuelRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantFuelResponseSchema) })
  async recordFuel(
    @Param("plantId") plantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const [principal, id] = await this.args(req, plantId);
    const result = await this.records.recordFuel(
      principal,
      id,
      recordFuelRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Post(":plantId/fuel/:issueId/corrections")
  @ApiOperation({
    operationId: "correctPlantFuel",
    summary: "Correct or void a fuel issue with a reason; never an edit",
    description: `Requires site.diary, plant.manage or stores.manage on the project, and plant.manage or being whoever recorded it; only the newest entry of a chain (409 record-superseded). ${meter} Offline-ready like a new entry.`,
  })
  @ApiHeader(idempotency)
  @ApiBody({ schema: openApi(correctFuelRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantFuelResponseSchema) })
  async correctFuel(
    @Param("plantId") plantId: string,
    @Param("issueId") issueId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const [principal, id, issue] = await this.args(req, plantId, issueId);
    const result = await this.records.correctFuel(
      principal,
      id,
      issue,
      correctFuelRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Post(":plantId/meter-resets")
  @ApiOperation({
    operationId: "resetPlantMeter",
    summary: "Record a replaced or reset meter (with a reason) so readings may start again",
    description: `${manage} The reset comes after every reading already recorded (409 meter-reset-order) and its old reading is not below the last one (409 meter-out-of-order).`,
  })
  @ApiBody({ schema: openApi(recordMeterResetRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantDetailResponseSchema) })
  async resetMeter(@Param("plantId") plantId: string, @Body() body: unknown, @Req() req: Request) {
    const [principal, id] = await this.args(req, plantId);
    return this.records.resetMeter(principal, id, recordMeterResetRequestSchema.parse(body), req);
  }

  @Post(":plantId/breakdowns")
  @ApiOperation({
    operationId: "reportPlantBreakdown",
    summary: "Report a breakdown at a site (major and unsafe ones put the item under repair)",
    description: record,
  })
  @ApiBody({ schema: openApi(reportBreakdownRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantDetailResponseSchema) })
  async reportBreakdown(
    @Param("plantId") plantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, plantId);
    return this.maintenance.report(principal, id, reportBreakdownRequestSchema.parse(body), req);
  }

  @Post(":plantId/breakdowns/:breakdownId/resolve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "resolvePlantBreakdown",
    summary: "Record the repair, or send hired plant off hire, or write owned plant off",
    description: `A repair needs site.diary or plant.manage on the project (an unsafe breakdown: plant.manage); off hire and write-off need plant.manage and a reason, and close the item (409 breakdown-resolution-invalid for the wrong ownership). ${version}`,
  })
  @ApiBody({ schema: openApi(resolveBreakdownRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async resolveBreakdown(
    @Param("plantId") plantId: string,
    @Param("breakdownId") breakdownId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, breakdown] = await this.args(req, plantId, breakdownId);
    return this.maintenance.resolve(
      principal,
      id,
      breakdown,
      resolveBreakdownRequestSchema.parse(body),
      req,
    );
  }

  @Post(":plantId/services")
  @ApiOperation({
    operationId: "recordPlantService",
    summary: "Record a service, repair or inspection (a service restarts the interval)",
    description: `Requires site.diary or plant.manage on the item's project (plant.manage while it is in the yard). ${meter}`,
  })
  @ApiBody({ schema: openApi(recordServiceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(plantDetailResponseSchema) })
  async recordService(
    @Param("plantId") plantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id] = await this.args(req, plantId);
    return this.maintenance.recordService(
      principal,
      id,
      recordServiceRequestSchema.parse(body),
      req,
    );
  }

  @Post(":plantId/services/:serviceId/void")
  @HttpCode(200)
  @ApiOperation({
    operationId: "voidPlantService",
    summary: "Void a service record entered in error (with a reason); it is never edited",
    description: `${manage} ${version}`,
  })
  @ApiBody({ schema: openApi(voidServiceRequestSchema) })
  @ApiOkResponse({ schema: openApi(plantDetailResponseSchema) })
  async voidService(
    @Param("plantId") plantId: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const [principal, id, service] = await this.args(req, plantId, serviceId);
    return this.maintenance.voidService(
      principal,
      id,
      service,
      voidServiceRequestSchema.parse(body),
      req,
    );
  }
}
