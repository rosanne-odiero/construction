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
  Res,
  UseGuards,
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
import {
  buildupMaterialMappingRequestSchema,
  buildupMaterialsResponseSchema,
  createIssueRequestSchema,
  createReturnRequestSchema,
  createStockTakeRequestSchema,
  createStoreRequestSchema,
  createWastageRequestSchema,
  dispatchTransferRequestSchema,
  idempotencyKeySchema,
  issueOptionsResponseSchema,
  ledgerQuerySchema,
  ledgerResponseSchema,
  movementListQuerySchema,
  movementResponseSchema,
  movementsResponseSchema,
  receiveTransferRequestSchema,
  recordCountsRequestSchema,
  reorderLevelsRequestSchema,
  reverseRequestSchema,
  stockTakeListQuerySchema,
  stockTakeReasonRequestSchema,
  stockTakeResponseSchema,
  stockTakesResponseSchema,
  stockTakeVersionRequestSchema,
  storeDetailResponseSchema,
  storesResponseSchema,
  storesSettingsResponseSchema,
  transferDecisionRequestSchema,
  transferListQuerySchema,
  transferResponseSchema,
  transfersResponseSchema,
  transferTargetsResponseSchema,
  updateStoreRequestSchema,
  updateStoresSettingsRequestSchema,
  varianceQuerySchema,
  varianceResponseSchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { z } from "zod";
import { openApi } from "../../../common/openapi.js";
import { AuthService } from "../../identity/auth.service.js";
import { BrowserGuard } from "../../identity/identity.controller.js";
import { uuidSchema } from "../../identity/identity.schemas.js";
import { BuildupMaterialsService } from "./buildup-materials.service.js";
import { MovementsService } from "./movements.service.js";
import { StockTakesService } from "./stock-takes.service.js";
import { storesProblem } from "./stores-common.js";
import { StoresService } from "./stores.service.js";
import { TransfersService } from "./transfers.service.js";
import { VarianceService } from "./variance.service.js";

const idempotencyHeader = {
  name: "Idempotency-Key",
  required: true,
  description:
    "8–100 characters, generated once per record on the device. A replay with the same key and payload returns the original result (Idempotency-Replayed: true); a changed payload is 409 idempotency-key-reused.",
};

/** The Idempotency-Key header (400 idempotency-key-required when missing or malformed). */
function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw storesProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

const replayed = (res: Response, result: { replayed: boolean }) => {
  if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
  return result;
};

const viewNote =
  "Any of stores.manage, procurement.requisition, procurement.approve, finance.view or finance.manage on the store's project.";
const manageNote = "stores.manage on the store's project (not closed or cancelled).";

@ApiTags("stores")
@UseGuards(BrowserGuard)
@Controller({ path: "stores", version: "1" })
export class StoresController {
  constructor(
    private readonly auth: AuthService,
    private readonly stores: StoresService,
    private readonly variance: VarianceService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "Stores per site on visible projects, with stock value, low stock and sites without a store",
    description: viewNote,
    operationId: "listStores",
  })
  @ApiOkResponse({ schema: openApi(storesResponseSchema) })
  async list(@Req() req: Request) {
    return this.stores.list(await this.auth.principal(req), req);
  }

  @Post()
  @ApiOperation({
    summary: "Create the store of a site (one per site; also created on the site's first GRN)",
    description: manageNote,
    operationId: "createStore",
  })
  @ApiBody({ schema: openApi(createStoreRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(storeDetailResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.stores.create(
      await this.auth.principal(req),
      createStoreRequestSchema.parse(body),
      req,
    );
  }

  @Get("settings")
  @ApiOperation({
    summary:
      "Stores settings: the consumption variance threshold (negative stock is never allowed)",
    operationId: "getStoresSettings",
  })
  @ApiOkResponse({ schema: openApi(storesSettingsResponseSchema) })
  async settings(@Req() req: Request) {
    return this.stores.settings(await this.auth.principal(req), req);
  }

  @Put("settings")
  @ApiOperation({
    summary: "Change the consumption variance threshold (config.manage)",
    operationId: "updateStoresSettings",
  })
  @ApiBody({ schema: openApi(updateStoresSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(storesSettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.stores.updateSettings(
      await this.auth.principal(req),
      updateStoresSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Get("variance")
  @ApiOperation({
    summary:
      "Theoretical (measured × build-up × waste) versus actual (issued − returned) consumption per BQ item and material, with alerts above the threshold — estimates for review, never proof of theft",
    description: viewNote,
    operationId: "getConsumptionVariance",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiQuery({ name: "state", required: false })
  @ApiOkResponse({ schema: openApi(varianceResponseSchema) })
  async report(@Query() query: unknown, @Req() req: Request) {
    return this.variance.report(
      await this.auth.principal(req),
      varianceQuerySchema.parse(query),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary:
      "A store with its balances (base unit, weighted average value), stock in transit and permissions",
    description: viewNote,
    operationId: "getStore",
  })
  @ApiOkResponse({ schema: openApi(storeDetailResponseSchema) })
  async detail(@Param("id") id: string, @Req() req: Request) {
    return this.stores.detail(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Rename a store or change its storekeeper (version required)",
    description: manageNote,
    operationId: "updateStore",
  })
  @ApiBody({ schema: openApi(updateStoreRequestSchema) })
  @ApiOkResponse({ schema: openApi(storeDetailResponseSchema) })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.stores.update(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      updateStoreRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/ledger")
  @ApiOperation({
    summary: "The store's append-only stock ledger, newest first (filters, cursor pages)",
    description: viewNote,
    operationId: "listStockLedger",
  })
  @ApiQuery({ name: "materialId", required: false })
  @ApiQuery({ name: "kind", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(ledgerResponseSchema) })
  async ledger(@Param("id") id: string, @Query() query: unknown, @Req() req: Request) {
    return this.stores.ledger(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      ledgerQuerySchema.parse(query),
      req,
    );
  }

  @Put(":id/reorder-levels")
  @ApiOperation({
    summary: "Set or remove reorder levels (base unit); low stock when on hand ≤ level",
    description: manageNote,
    operationId: "setReorderLevels",
  })
  @ApiBody({ schema: openApi(reorderLevelsRequestSchema) })
  @ApiOkResponse({ schema: openApi(storeDetailResponseSchema) })
  async reorderLevels(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.stores.reorderLevels(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      reorderLevelsRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/issue-options")
  @ApiOperation({
    summary: "What an issue needs: BQ items of the BQ in force, active gangs and stock on hand",
    description: manageNote,
    operationId: "getIssueOptions",
  })
  @ApiOkResponse({ schema: openApi(issueOptionsResponseSchema) })
  async issueOptions(@Param("id") id: string, @Req() req: Request) {
    return this.stores.issueOptions(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Get(":id/transfer-targets")
  @ApiOperation({
    summary: "Stores this store can transfer to",
    description: manageNote,
    operationId: "listTransferTargets",
  })
  @ApiOkResponse({ schema: openApi(transferTargetsResponseSchema) })
  async transferTargets(@Param("id") id: string, @Req() req: Request) {
    return this.stores.transferTargets(await this.auth.principal(req), uuidSchema.parse(id), req);
  }
}

const offlineNote =
  "Offline-ready: the client generates the record's ID and an Idempotency-Key once; a replay returns the original. Stock never goes below zero (409 insufficient-stock).";

@ApiTags("stores")
@UseGuards(BrowserGuard)
@Controller({ path: "stock-movements", version: "1" })
export class StockMovementsController {
  constructor(
    private readonly auth: AuthService,
    private readonly movements: MovementsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Issues, returns and wastage on visible projects",
    description: viewNote,
    operationId: "listStockMovements",
  })
  @ApiQuery({ name: "storeId", required: false })
  @ApiQuery({ name: "kind", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(movementsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.movements.list(
      await this.auth.principal(req),
      movementListQuerySchema.parse(query),
      req,
    );
  }

  @Post("issues")
  @ApiOperation({
    summary: "Issue material to a BQ item (approved BQ only) and/or a gang (ISS-NNNN)",
    description: `${manageNote} ${offlineNote}`,
    operationId: "createStockIssue",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(createIssueRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(movementResponseSchema) })
  async issue(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    return replayed(
      res,
      await this.movements.issue(
        await this.auth.principal(req),
        createIssueRequestSchema.parse(body),
        key,
        req,
      ),
    );
  }

  @Post("returns")
  @ApiOperation({
    summary: "Return issued material to its store (never more than is outstanding; RTN-NNNN)",
    description: `${manageNote} ${offlineNote}`,
    operationId: "createStockReturn",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(createReturnRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(movementResponseSchema) })
  async returnStock(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    return replayed(
      res,
      await this.movements.return(
        await this.auth.principal(req),
        createReturnRequestSchema.parse(body),
        key,
        req,
      ),
    );
  }

  @Post("wastage")
  @ApiOperation({
    summary: "Record wastage with a reason (WST-NNNN)",
    description: `${manageNote} ${offlineNote}`,
    operationId: "recordWastage",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(createWastageRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(movementResponseSchema) })
  async wastage(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    return replayed(
      res,
      await this.movements.wastage(
        await this.auth.principal(req),
        createWastageRequestSchema.parse(body),
        key,
        req,
      ),
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "An issue, return or wastage record with its lines and values",
    description: viewNote,
    operationId: "getStockMovement",
  })
  @ApiOkResponse({ schema: openApi(movementResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.movements.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/reverse")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Reverse a mistaken movement with a reason (reversing entries; an issue after its returns)",
    description: manageNote,
    operationId: "reverseStockMovement",
  })
  @ApiBody({ schema: openApi(reverseRequestSchema) })
  @ApiOkResponse({ schema: openApi(movementResponseSchema) })
  async reverse(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.movements.reverse(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      reverseRequestSchema.parse(body),
      req,
    );
  }
}

@ApiTags("stores")
@UseGuards(BrowserGuard)
@Controller({ path: "stock-transfers", version: "1" })
export class StockTransfersController {
  constructor(
    private readonly auth: AuthService,
    private readonly transfers: TransfersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Inter-site transfers to or from visible projects",
    description: viewNote,
    operationId: "listStockTransfers",
  })
  @ApiQuery({ name: "storeId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(transfersResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.transfers.list(
      await this.auth.principal(req),
      transferListQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Dispatch stock to another site's store (TRF-NNNN; in transit until received)",
    description: `stores.manage on the source store's project. ${offlineNote}`,
    operationId: "dispatchStockTransfer",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(dispatchTransferRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(transferResponseSchema) })
  async dispatch(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    return replayed(
      res,
      await this.transfers.dispatch(
        await this.auth.principal(req),
        dispatchTransferRequestSchema.parse(body),
        key,
        req,
      ),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "A transfer with its lines", operationId: "getStockTransfer" })
  @ApiOkResponse({ schema: openApi(transferResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.transfers.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/receive")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Record what arrived per line (base unit); a difference needs a reason and disputes the transfer",
    description: `stores.manage on the destination store's project. ${offlineNote}`,
    operationId: "receiveStockTransfer",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(receiveTransferRequestSchema) })
  @ApiOkResponse({ schema: openApi(transferResponseSchema) })
  async receive(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    return replayed(
      res,
      await this.transfers.receive(
        await this.auth.principal(req),
        uuidSchema.parse(id),
        receiveTransferRequestSchema.parse(body),
        key,
        req,
      ),
    );
  }

  @Post(":id/resolve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Resolve a disputed transfer with a note",
    description:
      "procurement.approve on either project; not the person who dispatched or received it.",
    operationId: "resolveStockTransfer",
  })
  @ApiBody({ schema: openApi(transferDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(transferResponseSchema) })
  async resolve(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.transfers.resolve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      transferDecisionRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel a transfer still in transit (the stock goes back at the value it left with)",
    description: "stores.manage on the source store's project.",
    operationId: "cancelStockTransfer",
  })
  @ApiBody({ schema: openApi(transferDecisionRequestSchema) })
  @ApiOkResponse({ schema: openApi(transferResponseSchema) })
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.transfers.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      transferDecisionRequestSchema.parse(body),
      req,
    );
  }
}

@ApiTags("stores")
@UseGuards(BrowserGuard)
@Controller({ path: "stock-takes", version: "1" })
export class StockTakesController {
  constructor(
    private readonly auth: AuthService,
    private readonly takes: StockTakesService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Stock takes on visible projects", operationId: "listStockTakes" })
  @ApiQuery({ name: "storeId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(stockTakesResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.takes.list(
      await this.auth.principal(req),
      stockTakeListQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Start a count sheet (STK-NNNN) with the system quantity of each material now",
    description: `${manageNote} One open stock take per store.`,
    operationId: "createStockTake",
  })
  @ApiBody({ schema: openApi(createStockTakeRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(stockTakeResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.takes.create(
      await this.auth.principal(req),
      createStockTakeRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "A stock take with snapshot, counts, movements since the snapshot and variances",
    description: viewNote,
    operationId: "getStockTake",
  })
  @ApiOkResponse({ schema: openApi(stockTakeResponseSchema) })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.takes.get(await this.auth.principal(req), uuidSchema.parse(id), req);
  }

  @Post(":id/counts")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Record counted quantities (a batch; each count compared with the system quantity at that moment)",
    description: `${manageNote} ${offlineNote}`,
    operationId: "recordStockCounts",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(recordCountsRequestSchema) })
  @ApiOkResponse({ schema: openApi(stockTakeResponseSchema) })
  async counts(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    return replayed(
      res,
      await this.takes.count(
        await this.auth.principal(req),
        uuidSchema.parse(id),
        recordCountsRequestSchema.parse(body),
        key,
        req,
      ),
    );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a fully counted stock take for approval",
    description: manageNote,
    operationId: "submitStockTake",
  })
  @ApiBody({ schema: openApi(stockTakeVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(stockTakeResponseSchema) })
  async submit(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.takes.submit(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      stockTakeVersionRequestSchema.parse(body).version,
      req,
    );
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a submitted stock take and post its variances as adjustments",
    description:
      "procurement.approve on the project; not someone who created, counted or submitted it (403 maker-checker).",
    operationId: "approveStockTake",
  })
  @ApiBody({ schema: openApi(stockTakeVersionRequestSchema) })
  @ApiOkResponse({ schema: openApi(stockTakeResponseSchema) })
  async approve(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.takes.approve(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      stockTakeVersionRequestSchema.parse(body).version,
      req,
    );
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({
    summary: "Return a submitted stock take for a recount (reason)",
    description: "procurement.approve on the project.",
    operationId: "returnStockTake",
  })
  @ApiBody({ schema: openApi(stockTakeReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(stockTakeResponseSchema) })
  async returnForRecount(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.takes.returnForRecount(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      stockTakeReasonRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel an open stock take (reason)",
    description: "stores.manage or procurement.approve on the project.",
    operationId: "cancelStockTake",
  })
  @ApiBody({ schema: openApi(stockTakeReasonRequestSchema) })
  @ApiOkResponse({ schema: openApi(stockTakeResponseSchema) })
  async cancel(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    return this.takes.cancel(
      await this.auth.principal(req),
      uuidSchema.parse(id),
      stockTakeReasonRequestSchema.parse(body),
      req,
    );
  }
}

const versionParam = z.coerce.number().int().min(1).max(2_147_483_647);

@ApiTags("stores")
@UseGuards(BrowserGuard)
@Controller({ path: "rate-buildups/:buildupId/versions/:versionNo/materials", version: "1" })
export class BuildupMaterialsController {
  constructor(
    private readonly auth: AuthService,
    private readonly mappings: BuildupMaterialsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "The material lines of a build-up version and the catalogue material each is mapped to",
    description: "bq.view company-wide or on at least one assigned project.",
    operationId: "listBuildupMaterials",
  })
  @ApiOkResponse({ schema: openApi(buildupMaterialsResponseSchema) })
  async list(
    @Param("buildupId") buildupId: string,
    @Param("versionNo") versionNo: string,
    @Req() req: Request,
  ) {
    return this.mappings.list(
      await this.auth.principal(req),
      uuidSchema.parse(buildupId),
      versionParam.parse(versionNo),
      req,
    );
  }

  @Put(":lineId")
  @ApiOperation({
    summary: "Map a material line to a catalogue material and the unit its quantity is in",
    description:
      "bq.edit company-wide or on at least one assigned project. The build-up version never changes; the mapping is a separate record (re-mapping stamps the old one).",
    operationId: "mapBuildupMaterial",
  })
  @ApiBody({ schema: openApi(buildupMaterialMappingRequestSchema) })
  @ApiOkResponse({ schema: openApi(buildupMaterialsResponseSchema) })
  async map(
    @Param("buildupId") buildupId: string,
    @Param("versionNo") versionNo: string,
    @Param("lineId") lineId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.mappings.map(
      await this.auth.principal(req),
      uuidSchema.parse(buildupId),
      versionParam.parse(versionNo),
      uuidSchema.parse(lineId),
      buildupMaterialMappingRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":lineId")
  @ApiOperation({
    summary: "Remove a line's material mapping (reported as not mapped again)",
    description: "bq.edit company-wide or on at least one assigned project.",
    operationId: "unmapBuildupMaterial",
  })
  @ApiOkResponse({ schema: openApi(buildupMaterialsResponseSchema) })
  async unmap(
    @Param("buildupId") buildupId: string,
    @Param("versionNo") versionNo: string,
    @Param("lineId") lineId: string,
    @Req() req: Request,
  ) {
    return this.mappings.unmap(
      await this.auth.principal(req),
      uuidSchema.parse(buildupId),
      versionParam.parse(versionNo),
      uuidSchema.parse(lineId),
      req,
    );
  }
}
