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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import {
  conversionResponseSchema,
  conversionResultResponseSchema,
  convertQuerySchema,
  correctPriceRequestSchema,
  createConversionRequestSchema,
  createMaterialRequestSchema,
  createUnitRequestSchema,
  endConversionRequestSchema,
  loadDefaultsResponseSchema,
  materialDetailResponseSchema,
  materialListQuerySchema,
  materialResponseSchema,
  materialsResponseSchema,
  priceAlertsQuerySchema,
  priceAlertsResponseSchema,
  priceResponseSchema,
  procurementSettingsResponseSchema,
  recordPriceRequestSchema,
  unitResponseSchema,
  unitsResponseSchema,
  updateMaterialRequestSchema,
  updateProcurementSettingsRequestSchema,
  updateUnitRequestSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { CatalogueService } from "./catalogue.service.js";
import { ConversionsService } from "./conversions.service.js";
import { PricesService } from "./prices.service.js";

const viewNote =
  "Requires one of procurement.manage_suppliers, procurement.requisition, procurement.approve, stores.manage or finance.view (company-wide or on at least one project).";
const manageNote = "Requires procurement.manage_suppliers.";

/** The material catalogue, units, conversions, prices and alerts (D5.1, ARCHITECTURE §4.4). */
@ApiTags("procurement")
@UseGuards(BrowserGuard)
@Controller({ version: "1" })
export class CatalogueController {
  constructor(
    private readonly auth: AuthService,
    private readonly catalogue: CatalogueService,
    private readonly conversions: ConversionsService,
    private readonly prices: PricesService,
  ) {}

  @Get("materials")
  @ApiOperation({
    summary: "Materials, with search, category and status filters (cursor pagination)",
    description: viewNote,
    operationId: "listMaterials",
  })
  @ApiQuery({ name: "search", required: false, description: "Code, name, Kiswahili name or spec" })
  @ApiQuery({ name: "category", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({ schema: openApi(materialsResponseSchema) })
  async listMaterials(@Query() query: unknown, @Req() req: Request) {
    return this.catalogue.list(
      await this.auth.principal(req),
      materialListQuerySchema.parse(query),
      req,
    );
  }

  @Post("materials")
  @ApiOperation({
    summary: "Add a material (code MAT-NNNN assigned)",
    description: `${manageNote} The base unit is a standard or company unit; attributes must fit the category (400 attribute-not-allowed). 409 material-name-taken.`,
    operationId: "createMaterial",
  })
  @ApiBody({ schema: openApi(createMaterialRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(materialResponseSchema) })
  @ApiConflictResponse({ description: "Name taken or unit archived" })
  async createMaterial(@Body() body: unknown, @Req() req: Request) {
    return this.catalogue.create(
      await this.auth.principal(req),
      createMaterialRequestSchema.parse(body),
      req,
    );
  }

  @Post("materials/defaults")
  @HttpCode(200)
  @ApiOperation({
    summary: "Load the Kenyan starter catalogue (idempotent: existing names are kept)",
    description: `${manageNote} Factors are loaded as material conversions labelled as assumptions.`,
    operationId: "loadMaterialDefaults",
  })
  @ApiOkResponse({ schema: openApi(loadDefaultsResponseSchema) })
  async loadDefaults(@Req() req: Request) {
    return this.catalogue.loadDefaults(await this.auth.principal(req), req);
  }

  @Get("materials/:id")
  @ApiOperation({
    summary: "A material with its conversions (standard and explicit), price history and alerts",
    description: viewNote,
    operationId: "getMaterial",
  })
  @ApiOkResponse({ schema: openApi(materialDetailResponseSchema) })
  async getMaterial(@Param("id") id: string, @Req() req: Request) {
    return this.catalogue.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch("materials/:id")
  @ApiOperation({
    summary: "Change a material (or archive it with status)",
    description: `${manageNote} Send the version you read (409 version-conflict). The base unit is fixed once the material has prices (409 base-unit-fixed).`,
    operationId: "updateMaterial",
  })
  @ApiBody({ schema: openApi(updateMaterialRequestSchema) })
  @ApiOkResponse({ schema: openApi(materialResponseSchema) })
  async updateMaterial(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.catalogue.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateMaterialRequestSchema.parse(body),
      req,
    );
  }

  @Post("materials/:id/conversions")
  @ApiOperation({
    summary: "Add an explicit factor for the material, optionally for one supplier",
    description: `${manageNote} "fromQuantity fromUnit = toQuantity toUnit", effective from a date (default today). It ends the factor in force for the same units and scope. Refused between units of one dimension (409 standard-conversion-exists) and for overlapping dates (409 conversion-overlap).`,
    operationId: "createConversion",
  })
  @ApiBody({ schema: openApi(createConversionRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(conversionResponseSchema) })
  async createConversion(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.conversions.create(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      createConversionRequestSchema.parse(body),
      req,
    );
  }

  @Post("materials/:id/conversions/:conversionId/end")
  @HttpCode(200)
  @ApiOperation({
    summary: "End a factor on a date (it is never edited or deleted)",
    description: manageNote,
    operationId: "endConversion",
  })
  @ApiBody({ schema: openApi(endConversionRequestSchema) })
  @ApiOkResponse({ schema: openApi(conversionResponseSchema) })
  async endConversion(
    @Param("id") id: string,
    @Param("conversionId") conversionId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.conversions.end(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(conversionId),
      endConversionRequestSchema.parse(body).effectiveTo,
      req,
    );
  }

  @Post("materials/:id/prices")
  @ApiOperation({
    summary: "Record a supplier price (append-only; flags a change above the alert threshold)",
    description: `${manageNote} The price is compared, net of VAT and per base unit, with the previous comparable price of the same material and supplier.`,
    operationId: "recordPrice",
  })
  @ApiBody({ schema: openApi(recordPriceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(priceResponseSchema) })
  async recordPrice(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.prices.record(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      recordPriceRequestSchema.parse(body),
      req,
    );
  }

  @Post("materials/:id/prices/:priceId/corrections")
  @ApiOperation({
    summary: "Correct a price: a new row referencing it, with a reason (each price once)",
    description: `${manageNote} 409 price-already-corrected.`,
    operationId: "correctPrice",
  })
  @ApiBody({ schema: openApi(correctPriceRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(priceResponseSchema) })
  async correctPrice(
    @Param("id") id: string,
    @Param("priceId") priceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.prices.correct(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      uuidSchema.parse(priceId),
      correctPriceRequestSchema.parse(body),
      req,
    );
  }

  @Get("price-alerts")
  @ApiOperation({
    summary: "Prices that changed more than the company's threshold (not corrected), newest first",
    description: viewNote,
    operationId: "listPriceAlerts",
  })
  @ApiOkResponse({ schema: openApi(priceAlertsResponseSchema) })
  async priceAlerts(@Query() query: unknown, @Req() req: Request) {
    return this.prices.alerts(
      await this.auth.principal(req),
      priceAlertsQuerySchema.parse(query),
      req,
    );
  }

  @Get("conversions/calculate")
  @ApiOperation({
    summary: "Convert a quantity between units (exact; rounded half-up to six places)",
    description: `${viewNote} With materialId (and supplierId) the material's and supplier's factors apply, in force on \`on\` (default today). 422 with no-conversion, unit-unknown, negative-quantity, invalid-quantity or quantity-too-large.`,
    operationId: "calculateConversion",
  })
  @ApiQuery({ name: "from", required: true })
  @ApiQuery({ name: "to", required: true })
  @ApiQuery({ name: "quantity", required: true })
  @ApiQuery({ name: "materialId", required: false })
  @ApiQuery({ name: "supplierId", required: false })
  @ApiQuery({ name: "on", required: false })
  @ApiOkResponse({ schema: openApi(conversionResultResponseSchema) })
  @ApiUnprocessableEntityResponse({ description: "The quantity cannot be converted" })
  async calculate(@Query() query: unknown, @Req() req: Request) {
    return this.conversions.calculate(
      await this.auth.principal(req),
      convertQuerySchema.parse(query),
      req,
    );
  }

  @Get("units")
  @ApiOperation({
    summary: "Standard units and the company's own units",
    description: viewNote,
    operationId: "listUnits",
  })
  @ApiOkResponse({ schema: openApi(unitsResponseSchema) })
  async units(@Req() req: Request) {
    return this.catalogue.units(await this.auth.principal(req), req);
  }

  @Post("units")
  @ApiOperation({
    summary: "Add a company unit (a sized unit states its size in a standard unit)",
    description: `${manageNote} A unit never changes once created; archive it instead. 409 unit-code-taken.`,
    operationId: "createUnit",
  })
  @ApiBody({ schema: openApi(createUnitRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(unitResponseSchema) })
  async createUnit(@Body() body: unknown, @Req() req: Request) {
    return this.catalogue.createUnit(
      await this.auth.principal(req),
      createUnitRequestSchema.parse(body),
      req,
    );
  }

  @Patch("units/:id")
  @ApiOperation({
    summary: "Archive or restore a company unit",
    description: manageNote,
    operationId: "updateUnit",
  })
  @ApiBody({ schema: openApi(updateUnitRequestSchema) })
  @ApiOkResponse({ schema: openApi(unitResponseSchema) })
  async updateUnit(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.catalogue.updateUnit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateUnitRequestSchema.parse(body),
      req,
    );
  }

  @Get("procurement/settings")
  @ApiOperation({
    summary: "Company procurement settings (price-change alert threshold)",
    description: viewNote,
    operationId: "getProcurementSettings",
  })
  @ApiOkResponse({ schema: openApi(procurementSettingsResponseSchema) })
  async settings(@Req() req: Request) {
    return this.catalogue.settings(await this.auth.principal(req), req);
  }

  @Put("procurement/settings")
  @ApiOperation({
    summary: "Change the price-change alert threshold",
    description: "Requires config.manage. Send the version you read (0 before the first save).",
    operationId: "updateProcurementSettings",
  })
  @ApiBody({ schema: openApi(updateProcurementSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(procurementSettingsResponseSchema) })
  @ApiForbiddenResponse({ description: "config.manage is required" })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.catalogue.updateSettings(
      await this.auth.principal(req),
      updateProcurementSettingsRequestSchema.parse(body),
      req,
    );
  }
}
