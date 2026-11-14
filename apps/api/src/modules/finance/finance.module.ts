import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { BudgetsService } from "./budgets.service.js";
import { CashFlowService } from "./cash-flow.service.js";
import { CostCodesService } from "./cost-codes.service.js";
import { CostLedgerService } from "./cost-ledger.service.js";
import { ExpensesService, ReceiptUploadGuard } from "./expenses.service.js";
import { PettyCashService } from "./petty-cash.service.js";
import { SpendAlertsService } from "./spend-alerts.service.js";
import {
  BudgetsController,
  CashFlowItemsController,
  CostCodesController,
  CostJournalsController,
  PettyCashController,
  SpendingController,
} from "./spending.controller.js";
import { SpendingAccess } from "./spending-common.js";
import { SpendingReportService } from "./spending-report.service.js";

/**
 * Spending and cash flow (D5.4, ARCHITECTURE §4.8): company cost codes and settings, versioned
 * budgets, the append-only cost ledger and manual journals, budget against actual and committed,
 * petty-cash floats (expenses with receipts and the M-Pesa SMS draft, top-ups, counts), manual
 * cash-flow lines, the weekly forecast and spend alerts. Supplier invoice accruals and settlement
 * payments reach the ledger through database triggers on the procure-to-pay tables.
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    SpendingController,
    CostCodesController,
    BudgetsController,
    CostJournalsController,
    PettyCashController,
    CashFlowItemsController,
  ],
  providers: [
    SpendingAccess,
    SpendingReportService,
    CostCodesService,
    BudgetsService,
    CostLedgerService,
    PettyCashService,
    ExpensesService,
    ReceiptUploadGuard,
    CashFlowService,
    SpendAlertsService,
  ],
})
export class FinanceModule {}
