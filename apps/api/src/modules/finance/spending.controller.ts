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
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { P2P_LIMITS } from "@pm-buddy/types";
import {
  addBudgetLineRequestSchema,
  approveBudgetRequestSchema,
  approveExpenseRequestSchema,
  billItemsQuerySchema,
  billItemsResponseSchema,
  bqItemSearchQuerySchema,
  bqItemSearchResponseSchema,
  budgetDetailResponseSchema,
  budgetLinesQuerySchema,
  budgetLinesResponseSchema,
  budgetsQuerySchema,
  budgetsResponseSchema,
  cashFlowItemResponseSchema,
  cashFlowItemsQuerySchema,
  cashFlowItemsResponseSchema,
  costCodeResponseSchema,
  costCodesQuerySchema,
  costCodesResponseSchema,
  costLedgerQuerySchema,
  costLedgerResponseSchema,
  countResponseSchema,
  countsQuerySchema,
  countsResponseSchema,
  createBudgetRequestSchema,
  createCashFlowItemRequestSchema,
  createCostCodeRequestSchema,
  createCountRequestSchema,
  createExpenseRequestSchema,
  createFloatRequestSchema,
  createJournalRequestSchema,
  createTopUpRequestSchema,
  custodiansQuerySchema,
  custodiansResponseSchema,
  deleteBudgetLineQuerySchema,
  expenseResponseSchema,
  expensesQuerySchema,
  expensesResponseSchema,
  floatLedgerQuerySchema,
  floatLedgerResponseSchema,
  floatResponseSchema,
  floatsResponseSchema,
  forecastQuerySchema,
  forecastResponseSchema,
  idempotencyKeySchema,
  journalResponseSchema,
  journalsQuerySchema,
  journalsResponseSchema,
  loadCostCodeDefaultsResponseSchema,
  payTopUpRequestSchema,
  projectSpendingResponseSchema,
  reasonBodySchema,
  receiptResponseSchema,
  receiveCashFlowItemRequestSchema,
  reversalJournalRequestSchema,
  smsParseRequestSchema,
  smsParseResponseSchema,
  spendAlertsQuerySchema,
  spendAlertsResponseSchema,
  spendingSettingsResponseSchema,
  spendingSummaryResponseSchema,
  topUpResponseSchema,
  topUpsQuerySchema,
  topUpsResponseSchema,
  updateBudgetLineRequestSchema,
  updateBudgetRequestSchema,
  updateCashFlowItemRequestSchema,
  updateCostCodeRequestSchema,
  updateFloatRequestSchema,
  updateSpendingSettingsRequestSchema,
  versionBodySchema,
} from "@pm-buddy/validation";
import type { Request, Response } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { BudgetsService } from "./budgets.service.js";
import { CashFlowService } from "./cash-flow.service.js";
import { CostCodesService } from "./cost-codes.service.js";
import { CostLedgerService } from "./cost-ledger.service.js";
import { ExpensesService, ReceiptUploadGuard, type UploadedReceipt } from "./expenses.service.js";
import { PettyCashService } from "./petty-cash.service.js";
import { SpendAlertsService } from "./spend-alerts.service.js";
import { spendingProblem } from "./spending-common.js";
import { SpendingReportService } from "./spending-report.service.js";

const readNote =
  "finance.view or finance.manage on the project (role ∩ assignment); clients, suppliers and site agents are refused.";
const managerNote = "finance.manage on the project (company-wide finance and owner roles).";
const pettyNote =
  "Any of finance.petty_cash, finance.view, finance.manage, payments.approve, payments.disburse or procurement.approve on the float's project.";
const uploadLimits = {
  limits: {
    fileSize: P2P_LIMITS.imageMaxBytes,
    files: 1,
    fields: 0,
    parts: 1,
    fieldNameSize: 50,
    headerPairs: 20,
  },
};
const fileBody = {
  schema: {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string", format: "binary" } },
  },
};
const idempotencyHeader = {
  name: "Idempotency-Key",
  required: true,
  description:
    "8–100 characters, generated once per expense on the device. A replay with the same key and payload returns the original (Idempotency-Replayed: true); a changed payload is 409 idempotency-key-reused.",
};

function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success)
    throw spendingProblem(
      400,
      "idempotency-key-required",
      "Send an Idempotency-Key header (8–100 characters)",
    );
  return parsed.data;
}

const id = (value: string) => uuidSchema.parse(value);

@ApiTags("spending")
@UseGuards(BrowserGuard)
@Controller({ path: "spending", version: "1" })
export class SpendingController {
  constructor(
    private readonly auth: AuthService,
    private readonly report: SpendingReportService,
    private readonly ledger: CostLedgerService,
    private readonly cashFlow: CashFlowService,
    private readonly alerts: SpendAlertsService,
    private readonly codes: CostCodesService,
  ) {}

  @Get("summary")
  @ApiOperation({
    summary: "Budget against actual and committed per visible project (company summary)",
    description: readNote,
    operationId: "getSpendingSummary",
  })
  @ApiOkResponse({ schema: openApi(spendingSummaryResponseSchema) })
  async summary(@Req() req: Request) {
    return this.report.summary(await this.auth.principal(req), req);
  }

  @Get("settings")
  @ApiOperation({
    summary:
      "Spending settings: budget alert %, unusual-spend rule, duplicate window, forecast weeks, opening cash",
    description:
      "Needs finance.view or finance.manage company-wide or on some project (portal roles are refused). The opening cash is null unless the role is company-wide.",
    operationId: "getSpendingSettings",
  })
  @ApiOkResponse({ schema: openApi(spendingSettingsResponseSchema) })
  async settings(@Req() req: Request) {
    return this.codes.settings(await this.auth.principal(req), req);
  }

  @Put("settings")
  @ApiOperation({
    summary: "Change the spending settings (company-wide finance.manage; version 0 the first time)",
    operationId: "updateSpendingSettings",
  })
  @ApiBody({ schema: openApi(updateSpendingSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApi(spendingSettingsResponseSchema) })
  async updateSettings(@Body() body: unknown, @Req() req: Request) {
    return this.codes.updateSettings(
      await this.auth.principal(req),
      updateSpendingSettingsRequestSchema.parse(body),
      req,
    );
  }

  @Get("projects/:projectId")
  @ApiOperation({
    summary:
      "A project's budget against actual (accrued) and committed (approved LPOs not yet invoiced), by category and by bill, with paid (net of VAT) and material issues re-allocated to BQ items",
    description: readNote,
    operationId: "getProjectSpending",
  })
  @ApiOkResponse({ schema: openApi(projectSpendingResponseSchema) })
  async project(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.report.project(await this.auth.principal(req), id(projectId), req);
  }

  @Get("projects/:projectId/bills/:billLineageId/items")
  @ApiOperation({
    summary: "A bill's BQ items with budget, committed, actual and paid (search, pages)",
    description: readNote,
    operationId: "listBillSpending",
  })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiOkResponse({ schema: openApi(billItemsResponseSchema) })
  async billItems(
    @Param("projectId") projectId: string,
    @Param("billLineageId") billLineageId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.report.billItems(
      await this.auth.principal(req),
      id(projectId),
      id(billLineageId),
      billItemsQuerySchema.parse(query),
      req,
    );
  }

  @Get("projects/:projectId/bq-items")
  @ApiOperation({
    summary: "Search the BQ in force for an item to tag (at most 50 results, `truncated`)",
    description: `${readNote} Also budget preparers and petty-cash readers.`,
    operationId: "searchSpendingBqItems",
  })
  @ApiQuery({ name: "search", required: false })
  @ApiOkResponse({ schema: openApi(bqItemSearchResponseSchema) })
  async bqItems(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.report.bqItems(
      await this.auth.principal(req),
      id(projectId),
      bqItemSearchQuerySchema.parse(query).search,
      req,
    );
  }

  @Get("ledger")
  @ApiOperation({
    summary: "The append-only cost ledger, newest first, with filters and totals (cursor pages)",
    description: readNote,
    operationId: "listCostEntries",
  })
  @ApiOkResponse({ schema: openApi(costLedgerResponseSchema) })
  async listLedger(@Query() query: unknown, @Req() req: Request) {
    const parsed = costLedgerQuerySchema.parse(query);
    return this.ledger.list(await this.auth.principal(req), parsed, req);
  }

  @Get("forecast")
  @ApiOperation({
    summary:
      "Weekly cash-flow forecast for a project, or the company (company-wide finance roles): payroll, supplier invoices, LPO commitments, petty-cash top-ups and expected receipts",
    description: readNote,
    operationId: "getCashFlowForecast",
  })
  @ApiQuery({ name: "projectId", required: false })
  @ApiOkResponse({ schema: openApi(forecastResponseSchema) })
  async forecast(@Query() query: unknown, @Req() req: Request) {
    return this.cashFlow.forecast(
      await this.auth.principal(req),
      forecastQuerySchema.parse(query).projectId,
      req,
    );
  }

  @Get("alerts")
  @ApiOperation({
    summary:
      "Spend alerts computed on read: budget threshold, unusual spend, duplicate payments, payments without documents",
    description: readNote,
    operationId: "listSpendAlerts",
  })
  @ApiOkResponse({ schema: openApi(spendAlertsResponseSchema) })
  async listAlerts(@Query() query: unknown, @Req() req: Request) {
    return this.alerts.list(
      await this.auth.principal(req),
      spendAlertsQuerySchema.parse(query),
      req,
    );
  }
}

@ApiTags("spending")
@UseGuards(BrowserGuard)
@Controller({ path: "cost-codes", version: "1" })
export class CostCodesController {
  constructor(
    private readonly auth: AuthService,
    private readonly codes: CostCodesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Company cost codes (search, pages)",
    description:
      "Needs a spending, petty-cash or budget-preparing permission company-wide or on some project (portal roles are refused).",
    operationId: "listCostCodes",
  })
  @ApiOkResponse({ schema: openApi(costCodesResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.codes.list(await this.auth.principal(req), costCodesQuerySchema.parse(query), req);
  }

  @Post()
  @ApiOperation({
    summary: "Add a cost code",
    description: managerNote,
    operationId: "createCostCode",
  })
  @ApiBody({ schema: openApi(createCostCodeRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(costCodeResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.codes.create(
      await this.auth.principal(req),
      createCostCodeRequestSchema.parse(body),
      req,
    );
  }

  @Post("defaults")
  @ApiOperation({
    summary: "Load the default cost codes the company does not have yet",
    description: managerNote,
    operationId: "loadDefaultCostCodes",
  })
  @ApiCreatedResponse({ schema: openApi(loadCostCodeDefaultsResponseSchema) })
  async defaults(@Req() req: Request) {
    return this.codes.loadDefaults(await this.auth.principal(req), req);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Rename, recategorise, deactivate or reactivate a cost code (version required)",
    description: managerNote,
    operationId: "updateCostCode",
  })
  @ApiBody({ schema: openApi(updateCostCodeRequestSchema) })
  @ApiOkResponse({ schema: openApi(costCodeResponseSchema) })
  async update(@Param("id") codeId: string, @Body() body: unknown, @Req() req: Request) {
    return this.codes.update(
      await this.auth.principal(req),
      id(codeId),
      updateCostCodeRequestSchema.parse(body),
      req,
    );
  }
}

const budgetPrepare = "finance.manage or bq.edit on the project; only while the budget is a draft.";

@ApiTags("spending")
@UseGuards(BrowserGuard)
@Controller({ path: "budgets", version: "1" })
export class BudgetsController {
  constructor(
    private readonly auth: AuthService,
    private readonly budgets: BudgetsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A project's budget versions (the newest approved is in force)",
    description: `${readNote} Also budget preparers (bq.edit).`,
    operationId: "listBudgets",
  })
  @ApiQuery({ name: "projectId", required: true })
  @ApiOkResponse({ schema: openApi(budgetsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.budgets.list(
      await this.auth.principal(req),
      budgetsQuerySchema.parse(query).projectId,
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Start a budget version: empty, from the BQ in force (one line per item) or a copy",
    description: "finance.manage or bq.edit on the project; one version in preparation at a time.",
    operationId: "createBudget",
  })
  @ApiBody({ schema: openApi(createBudgetRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(budgetDetailResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.budgets.create(
      await this.auth.principal(req),
      createBudgetRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "A budget version with totals and permissions",
    operationId: "getBudget",
  })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async detail(@Param("id") budgetId: string, @Req() req: Request) {
    return this.budgets.detail(await this.auth.principal(req), id(budgetId), req);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Rename a draft budget or change its notes",
    description: budgetPrepare,
    operationId: "updateBudget",
  })
  @ApiBody({ schema: openApi(updateBudgetRequestSchema) })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async update(@Param("id") budgetId: string, @Body() body: unknown, @Req() req: Request) {
    return this.budgets.update(
      await this.auth.principal(req),
      id(budgetId),
      updateBudgetRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id/lines")
  @ApiOperation({ summary: "A budget's lines (search, pages)", operationId: "listBudgetLines" })
  @ApiOkResponse({ schema: openApi(budgetLinesResponseSchema) })
  async lines(@Param("id") budgetId: string, @Query() query: unknown, @Req() req: Request) {
    return this.budgets.lines(
      await this.auth.principal(req),
      id(budgetId),
      budgetLinesQuerySchema.parse(query),
      req,
    );
  }

  @Post(":id/lines")
  @ApiOperation({
    summary: "Add a line for a BQ item or a cost code",
    description: budgetPrepare,
    operationId: "addBudgetLine",
  })
  @ApiBody({ schema: openApi(addBudgetLineRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(budgetDetailResponseSchema) })
  async addLine(@Param("id") budgetId: string, @Body() body: unknown, @Req() req: Request) {
    return this.budgets.addLine(
      await this.auth.principal(req),
      id(budgetId),
      addBudgetLineRequestSchema.parse(body),
      req,
    );
  }

  @Patch(":id/lines/:lineId")
  @ApiOperation({
    summary: "Change a line's amount, description or category",
    description: budgetPrepare,
    operationId: "updateBudgetLine",
  })
  @ApiBody({ schema: openApi(updateBudgetLineRequestSchema) })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async updateLine(
    @Param("id") budgetId: string,
    @Param("lineId") lineId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.budgets.updateLine(
      await this.auth.principal(req),
      id(budgetId),
      id(lineId),
      updateBudgetLineRequestSchema.parse(body),
      req,
    );
  }

  @Delete(":id/lines/:lineId")
  @ApiOperation({
    summary: "Remove a line (budget version in the query)",
    description: budgetPrepare,
    operationId: "removeBudgetLine",
  })
  @ApiQuery({ name: "version", required: true })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async removeLine(
    @Param("id") budgetId: string,
    @Param("lineId") lineId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.budgets.removeLine(
      await this.auth.principal(req),
      id(budgetId),
      id(lineId),
      deleteBudgetLineQuerySchema.parse(query).version,
      req,
    );
  }

  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a draft for approval (its lines are frozen and digested)",
    description: budgetPrepare,
    operationId: "submitBudget",
  })
  @ApiBody({ schema: openApi(versionBodySchema) })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async submit(@Param("id") budgetId: string, @Body() body: unknown, @Req() req: Request) {
    return this.budgets.submit(
      await this.auth.principal(req),
      id(budgetId),
      versionBodySchema.parse(body).version,
      req,
    );
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve the submitted budget seen (digest); it becomes the budget in force",
    description:
      "finance.manage + step-up; never a contributor (403 maker-checker); 409 budget-stale on a changed digest.",
    operationId: "approveBudget",
  })
  @ApiBody({ schema: openApi(approveBudgetRequestSchema) })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async approve(@Param("id") budgetId: string, @Body() body: unknown, @Req() req: Request) {
    return this.budgets.approve(
      await this.auth.principal(req),
      id(budgetId),
      approveBudgetRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({
    summary: "Return a submitted budget to draft with a reason",
    description: "finance.manage.",
    operationId: "returnBudget",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async returnBudget(@Param("id") budgetId: string, @Body() body: unknown, @Req() req: Request) {
    return this.budgets.decide(
      await this.auth.principal(req),
      id(budgetId),
      "return",
      reasonBodySchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel a draft or submitted budget with a reason",
    description: budgetPrepare,
    operationId: "cancelBudget",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(budgetDetailResponseSchema) })
  async cancel(@Param("id") budgetId: string, @Body() body: unknown, @Req() req: Request) {
    return this.budgets.decide(
      await this.auth.principal(req),
      id(budgetId),
      "cancel",
      reasonBodySchema.parse(body),
      req,
    );
  }
}

@ApiTags("spending")
@UseGuards(BrowserGuard)
@Controller({ path: "cost-journals", version: "1" })
export class CostJournalsController {
  constructor(
    private readonly auth: AuthService,
    private readonly ledger: CostLedgerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Manual cost journals (newest first)",
    description: readNote,
    operationId: "listCostJournals",
  })
  @ApiOkResponse({ schema: openApi(journalsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.ledger.journals(
      await this.auth.principal(req),
      journalsQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Propose an adjustment journal (tagged lines; approval by someone else posts them)",
    description: managerNote,
    operationId: "createCostJournal",
  })
  @ApiBody({ schema: openApi(createJournalRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(journalResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.ledger.createJournal(
      await this.auth.principal(req),
      createJournalRequestSchema.parse(body),
      req,
    );
  }

  @Post("reversal")
  @ApiOperation({
    summary: "Propose the reversal of one cost entry (once; a reversal is never reversed)",
    description: managerNote,
    operationId: "createReversalJournal",
  })
  @ApiBody({ schema: openApi(reversalJournalRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(journalResponseSchema) })
  async reversal(@Body() body: unknown, @Req() req: Request) {
    return this.ledger.createReversal(
      await this.auth.principal(req),
      reversalJournalRequestSchema.parse(body),
      req,
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "A journal with its lines",
    description: readNote,
    operationId: "getCostJournal",
  })
  @ApiOkResponse({ schema: openApi(journalResponseSchema) })
  async detail(@Param("id") journalId: string, @Req() req: Request) {
    return this.ledger.journal(await this.auth.principal(req), id(journalId), req);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve and post a journal",
    description: "finance.manage + step-up; never the author (403 maker-checker).",
    operationId: "approveCostJournal",
  })
  @ApiBody({ schema: openApi(versionBodySchema) })
  @ApiOkResponse({ schema: openApi(journalResponseSchema) })
  async approve(@Param("id") journalId: string, @Body() body: unknown, @Req() req: Request) {
    return this.ledger.approveJournal(
      await this.auth.principal(req),
      id(journalId),
      versionBodySchema.parse(body).version,
      req,
    );
  }

  @Post(":id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a journal with a reason",
    description: "finance.manage; never the author.",
    operationId: "rejectCostJournal",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(journalResponseSchema) })
  async reject(@Param("id") journalId: string, @Body() body: unknown, @Req() req: Request) {
    return this.ledger.rejectJournal(
      await this.auth.principal(req),
      id(journalId),
      reasonBodySchema.parse(body),
      req,
    );
  }
}

@ApiTags("spending")
@UseGuards(BrowserGuard)
@Controller({ path: "petty-cash", version: "1" })
export class PettyCashController {
  constructor(
    private readonly auth: AuthService,
    private readonly petty: PettyCashService,
    private readonly expenses: ExpensesService,
  ) {}

  @Get("floats")
  @ApiOperation({
    summary: "Petty-cash floats on visible projects, and sites without one",
    description: pettyNote,
    operationId: "listFloats",
  })
  @ApiOkResponse({ schema: openApi(floatsResponseSchema) })
  async floats(@Req() req: Request) {
    return this.petty.floats(await this.auth.principal(req), req);
  }

  @Post("floats")
  @ApiOperation({
    summary: "Open a site's float with a custodian (who holds finance.petty_cash) and a limit",
    description: managerNote,
    operationId: "createFloat",
  })
  @ApiBody({ schema: openApi(createFloatRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(floatResponseSchema) })
  async createFloat(@Body() body: unknown, @Req() req: Request) {
    return this.petty.createFloat(
      await this.auth.principal(req),
      createFloatRequestSchema.parse(body),
      req,
    );
  }

  @Get("floats/custodians")
  @ApiOperation({
    summary: "People who may hold a float on a project",
    description: managerNote,
    operationId: "listFloatCustodians",
  })
  @ApiQuery({ name: "projectId", required: true })
  @ApiOkResponse({ schema: openApi(custodiansResponseSchema) })
  async custodians(@Query() query: unknown, @Req() req: Request) {
    return this.petty.custodians(
      await this.auth.principal(req),
      custodiansQuerySchema.parse(query).projectId,
      req,
    );
  }

  @Get("floats/:id")
  @ApiOperation({
    summary: "A float with its balance and permissions",
    description: pettyNote,
    operationId: "getFloat",
  })
  @ApiOkResponse({ schema: openApi(floatResponseSchema) })
  async float(@Param("id") floatId: string, @Req() req: Request) {
    return this.petty.float(await this.auth.principal(req), id(floatId), req);
  }

  @Patch("floats/:id")
  @ApiOperation({
    summary:
      "Rename, change the limit or custodian (after an approved count), or close an empty float",
    description: managerNote,
    operationId: "updateFloat",
  })
  @ApiBody({ schema: openApi(updateFloatRequestSchema) })
  @ApiOkResponse({ schema: openApi(floatResponseSchema) })
  async updateFloat(@Param("id") floatId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.updateFloat(
      await this.auth.principal(req),
      id(floatId),
      updateFloatRequestSchema.parse(body),
      req,
    );
  }

  @Get("floats/:id/ledger")
  @ApiOperation({
    summary: "The float's append-only ledger, newest first",
    description: pettyNote,
    operationId: "listFloatLedger",
  })
  @ApiOkResponse({ schema: openApi(floatLedgerResponseSchema) })
  async floatLedger(@Param("id") floatId: string, @Query() query: unknown, @Req() req: Request) {
    return this.petty.ledger(
      await this.auth.principal(req),
      id(floatId),
      floatLedgerQuerySchema.parse(query),
      req,
    );
  }

  @Post("sms/parse")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Parse a pasted M-Pesa SMS into a DRAFT (never a confirmation of settlement) and list records holding its code",
    description: `${pettyNote} The text is not stored.`,
    operationId: "parseMpesaSms",
  })
  @ApiBody({ schema: openApi(smsParseRequestSchema) })
  @ApiOkResponse({ schema: openApi(smsParseResponseSchema) })
  async parseSms(@Body() body: unknown, @Req() req: Request) {
    return this.expenses.parseSms(
      await this.auth.principal(req),
      smsParseRequestSchema.parse(body).text,
      req,
    );
  }

  @Get("expenses")
  @ApiOperation({
    summary: "Expenses on visible projects, newest first",
    description: pettyNote,
    operationId: "listExpenses",
  })
  @ApiOkResponse({ schema: openApi(expensesResponseSchema) })
  async listExpenses(@Query() query: unknown, @Req() req: Request) {
    return this.expenses.list(
      await this.auth.principal(req),
      expensesQuerySchema.parse(query),
      req,
    );
  }

  @Post("expenses")
  @ApiOperation({
    summary: "Record an expense from the float you hold (EXP-NNNN); the cash leaves the float now",
    description:
      "The float's custodian with finance.petty_cash on the project. Offline-ready: client ID + Idempotency-Key. 409 float-insufficient (never below zero), mpesa-code-duplicate.",
    operationId: "createExpense",
  })
  @ApiHeader(idempotencyHeader)
  @ApiBody({ schema: openApi(createExpenseRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(expenseResponseSchema) })
  async createExpense(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(req);
    const result = await this.expenses.record(
      await this.auth.principal(req),
      createExpenseRequestSchema.parse(body),
      key,
      req,
    );
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    return result;
  }

  @Get("expenses/:id")
  @ApiOperation({
    summary: "An expense with its receipts and permissions",
    description: pettyNote,
    operationId: "getExpense",
  })
  @ApiOkResponse({ schema: openApi(expenseResponseSchema) })
  async expense(@Param("id") expenseId: string, @Req() req: Request) {
    return this.expenses.get(await this.auth.principal(req), id(expenseId), req);
  }

  @Post("expenses/:id/receipts")
  @UseGuards(ReceiptUploadGuard)
  @UseInterceptors(FileInterceptor("file", uploadLimits))
  @ApiOperation({
    summary: "Add a receipt photo (JPEG, PNG or WebP, at most 5 MB; at most three)",
    description: "The custodian who recorded it, or finance.manage.",
    operationId: "uploadExpenseReceipt",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody(fileBody)
  @ApiCreatedResponse({ schema: openApi(receiptResponseSchema) })
  async receiptUpload(
    @Param("id") expenseId: string,
    @UploadedFile() file: UploadedReceipt | undefined,
    @Req() req: Request,
  ) {
    return this.expenses.addReceipt(await this.auth.principal(req), id(expenseId), file, req);
  }

  @Get("receipts/:id")
  @ApiOperation({
    summary: "Download a receipt photo",
    description: pettyNote,
    operationId: "downloadReceipt",
  })
  async receipt(@Param("id") receiptId: string, @Req() req: Request) {
    const file = await this.expenses.receipt(await this.auth.principal(req), id(receiptId), req);
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: `inline; filename="${file.fileName}"`,
      length: file.content.length,
    });
  }

  @Post("expenses/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve an expense (needs a receipt); posts its cost, accrued and paid",
    description:
      "finance.manage or procurement.approve; never the recorder or the custodian (403 maker-checker).",
    operationId: "approveExpense",
  })
  @ApiBody({ schema: openApi(approveExpenseRequestSchema) })
  @ApiOkResponse({ schema: openApi(expenseResponseSchema) })
  async approveExpense(@Param("id") expenseId: string, @Body() body: unknown, @Req() req: Request) {
    return this.expenses.decide(
      await this.auth.principal(req),
      id(expenseId),
      "approve",
      approveExpenseRequestSchema.parse(body),
      req,
    );
  }

  @Post("expenses/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject an expense with a reason; its cash goes back on the float's book",
    description: "finance.manage or procurement.approve; never the recorder or the custodian.",
    operationId: "rejectExpense",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(expenseResponseSchema) })
  async rejectExpense(@Param("id") expenseId: string, @Body() body: unknown, @Req() req: Request) {
    return this.expenses.decide(
      await this.auth.principal(req),
      id(expenseId),
      "reject",
      reasonBodySchema.parse(body),
      req,
    );
  }

  @Get("top-ups")
  @ApiOperation({
    summary: "Top-ups on visible projects",
    description: pettyNote,
    operationId: "listTopUps",
  })
  @ApiOkResponse({ schema: openApi(topUpsResponseSchema) })
  async topUps(@Query() query: unknown, @Req() req: Request) {
    return this.petty.topUps(await this.auth.principal(req), topUpsQuerySchema.parse(query), req);
  }

  @Post("top-ups")
  @ApiOperation({
    summary: "Ask for a top-up (never above the float's limit)",
    description: "The custodian (finance.petty_cash) or finance.manage.",
    operationId: "requestTopUp",
  })
  @ApiBody({ schema: openApi(createTopUpRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(topUpResponseSchema) })
  async requestTopUp(@Body() body: unknown, @Req() req: Request) {
    return this.petty.requestTopUp(
      await this.auth.principal(req),
      createTopUpRequestSchema.parse(body),
      req,
    );
  }

  @Post("top-ups/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a top-up",
    description: "payments.approve + step-up; never the requester.",
    operationId: "approveTopUp",
  })
  @ApiBody({ schema: openApi(versionBodySchema) })
  @ApiOkResponse({ schema: openApi(topUpResponseSchema) })
  async approveTopUp(@Param("id") topUpId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.decideTopUp(
      await this.auth.principal(req),
      id(topUpId),
      "approve",
      versionBodySchema.parse(body),
      req,
    );
  }

  @Post("top-ups/:id/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a top-up with a reason",
    description: "payments.approve; never the requester.",
    operationId: "rejectTopUp",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(topUpResponseSchema) })
  async rejectTopUp(@Param("id") topUpId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.decideTopUp(
      await this.auth.principal(req),
      id(topUpId),
      "reject",
      reasonBodySchema.parse(body),
      req,
    );
  }

  @Post("top-ups/:id/pay")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record that an approved top-up was paid (method, reference, date); the float rises",
    description: "payments.disburse + step-up; never the approver. 409 float-limit-exceeded.",
    operationId: "payTopUp",
  })
  @ApiBody({ schema: openApi(payTopUpRequestSchema) })
  @ApiOkResponse({ schema: openApi(topUpResponseSchema) })
  async payTopUp(@Param("id") topUpId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.payTopUp(
      await this.auth.principal(req),
      id(topUpId),
      payTopUpRequestSchema.parse(body),
      req,
    );
  }

  @Post("top-ups/:id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel a top-up not yet paid",
    description: "The requester or finance.manage.",
    operationId: "cancelTopUp",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(topUpResponseSchema) })
  async cancelTopUp(@Param("id") topUpId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.decideTopUp(
      await this.auth.principal(req),
      id(topUpId),
      "cancel",
      reasonBodySchema.parse(body),
      req,
    );
  }

  @Get("counts")
  @ApiOperation({
    summary: "Cash counts on visible projects",
    description: pettyNote,
    operationId: "listCounts",
  })
  @ApiOkResponse({ schema: openApi(countsResponseSchema) })
  async counts(@Query() query: unknown, @Req() req: Request) {
    return this.petty.counts(await this.auth.principal(req), countsQuerySchema.parse(query), req);
  }

  @Post("counts")
  @ApiOperation({
    summary: "Record a cash count against the float's book balance now (CNT-NNNN)",
    description: "The custodian (finance.petty_cash) or finance.manage; one open count per float.",
    operationId: "recordCount",
  })
  @ApiBody({ schema: openApi(createCountRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(countResponseSchema) })
  async recordCount(@Body() body: unknown, @Req() req: Request) {
    return this.petty.recordCount(
      await this.auth.principal(req),
      createCountRequestSchema.parse(body),
      req,
    );
  }

  @Post("counts/:id/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a count; a variance adjusts the float and posts petty-cash cost",
    description:
      "finance.manage or procurement.approve; neither the counter nor the custodian. 409 float-insufficient if the float moved below the shortage since.",
    operationId: "approveCount",
  })
  @ApiBody({ schema: openApi(versionBodySchema) })
  @ApiOkResponse({ schema: openApi(countResponseSchema) })
  async approveCount(@Param("id") countId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.decideCount(
      await this.auth.principal(req),
      id(countId),
      "approve",
      versionBodySchema.parse(body),
      req,
    );
  }

  @Post("counts/:id/return")
  @HttpCode(200)
  @ApiOperation({
    summary: "Return a count for a recount, with a reason",
    description: "As approval.",
    operationId: "returnCount",
  })
  @ApiBody({ schema: openApi(reasonBodySchema) })
  @ApiOkResponse({ schema: openApi(countResponseSchema) })
  async returnCount(@Param("id") countId: string, @Body() body: unknown, @Req() req: Request) {
    return this.petty.decideCount(
      await this.auth.principal(req),
      id(countId),
      "return",
      reasonBodySchema.parse(body),
      req,
    );
  }
}

@ApiTags("spending")
@UseGuards(BrowserGuard)
@Controller({ path: "cash-flow-items", version: "1" })
export class CashFlowItemsController {
  constructor(
    private readonly auth: AuthService,
    private readonly cashFlow: CashFlowService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Manual cash-flow lines (expected receipts and payments)",
    description: readNote,
    operationId: "listCashFlowItems",
  })
  @ApiOkResponse({ schema: openApi(cashFlowItemsResponseSchema) })
  async list(@Query() query: unknown, @Req() req: Request) {
    return this.cashFlow.items(
      await this.auth.principal(req),
      cashFlowItemsQuerySchema.parse(query),
      req,
    );
  }

  @Post()
  @ApiOperation({
    summary: "Add an expected receipt or payment",
    description: managerNote,
    operationId: "createCashFlowItem",
  })
  @ApiBody({ schema: openApi(createCashFlowItemRequestSchema) })
  @ApiCreatedResponse({ schema: openApi(cashFlowItemResponseSchema) })
  async create(@Body() body: unknown, @Req() req: Request) {
    return this.cashFlow.create(
      await this.auth.principal(req),
      createCashFlowItemRequestSchema.parse(body),
      req,
    );
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Change an expected line",
    description: managerNote,
    operationId: "updateCashFlowItem",
  })
  @ApiBody({ schema: openApi(updateCashFlowItemRequestSchema) })
  @ApiOkResponse({ schema: openApi(cashFlowItemResponseSchema) })
  async update(@Param("id") itemId: string, @Body() body: unknown, @Req() req: Request) {
    return this.cashFlow.update(
      await this.auth.principal(req),
      id(itemId),
      "update",
      updateCashFlowItemRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/receive")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record what was actually received (date, amount)",
    description: managerNote,
    operationId: "receiveCashFlowItem",
  })
  @ApiBody({ schema: openApi(receiveCashFlowItemRequestSchema) })
  @ApiOkResponse({ schema: openApi(cashFlowItemResponseSchema) })
  async receive(@Param("id") itemId: string, @Body() body: unknown, @Req() req: Request) {
    return this.cashFlow.update(
      await this.auth.principal(req),
      id(itemId),
      "receive",
      receiveCashFlowItemRequestSchema.parse(body),
      req,
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel an expected line",
    description: managerNote,
    operationId: "cancelCashFlowItem",
  })
  @ApiBody({ schema: openApi(versionBodySchema) })
  @ApiOkResponse({ schema: openApi(cashFlowItemResponseSchema) })
  async cancel(@Param("id") itemId: string, @Body() body: unknown, @Req() req: Request) {
    return this.cashFlow.update(
      await this.auth.principal(req),
      id(itemId),
      "cancel",
      versionBodySchema.parse(body),
      req,
    );
  }
}
