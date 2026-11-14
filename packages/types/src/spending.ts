import type { Permission } from "./permissions.js";

/**
 * Spending and cash-flow vocabulary (D5.4, brief §5.8 and §15 C/D; ARCHITECTURE §4.8; WORKFLOWS
 * "Petty cash" and "Budgets"). The database CHECK constraints and triggers in migration
 * `20261123090000_spending` list the same values.
 */

/** Every shilling carries one of these categories (brief §5.8). */
export const COST_CATEGORIES = [
  "materials",
  "labour",
  "plant",
  "subcontract",
  "preliminaries",
  "fees",
  "permits",
  "transport",
  "petty_cash",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

/**
 * The two cost measures of the ledger (brief §15 C: committed, accrued and paid are separate):
 * `accrued` is cost incurred (an approved supplier invoice, an approved petty-cash expense);
 * `paid` is the cost portion of cash that has left (a recorded settlement, a petty-cash expense).
 * Committed cost (approved LPOs not yet invoiced) is a read model over the LPOs, never an entry.
 * An invoice and its settlement never increase the same measure.
 */
export const COST_MEASURES = ["accrued", "paid"] as const;
export type CostMeasure = (typeof COST_MEASURES)[number];

/** Where a cost entry came from; each source posts once per purpose (idempotent). */
export const COST_SOURCES = [
  "supplier_invoice",
  "invoice_settlement",
  "petty_cash_expense",
  "petty_cash_count",
  "cost_journal",
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/**
 * What an entry records for its source: the cost of an expense or invoice (`accrual`), the cash
 * that paid it (`payment`), an M-Pesa transaction charge (`charge_accrual`, `charge_payment`), an
 * approved petty-cash count variance (`variance_accrual`, `variance_payment`), a journal line
 * (`journal`) or the reversal of an earlier entry (`reversal`).
 */
export const COST_PURPOSES = [
  "accrual",
  "payment",
  "charge_accrual",
  "charge_payment",
  "variance_accrual",
  "variance_payment",
  "journal",
  "reversal",
] as const;
export type CostPurpose = (typeof COST_PURPOSES)[number];

/** Who received the money. */
export const COUNTERPARTY_KINDS = ["supplier", "worker", "other", "none"] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/**
 * Budgets are versioned per project: draft → submitted → approved (by someone who did not prepare
 * it, with step-up); submitted → draft (returned with a reason); draft or submitted → cancelled.
 * The newest approved version is the budget in force; approved versions never change.
 */
export const BUDGET_STATUSES = ["draft", "submitted", "approved", "cancelled"] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];
export const BUDGET_ACTIONS = ["submit", "approve", "return", "cancel"] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];
/** How a new budget version starts: empty, one line per measured BQ item, or a copy of the current one. */
export const BUDGET_SOURCES = ["empty", "bq", "copy"] as const;
export type BudgetSource = (typeof BUDGET_SOURCES)[number];

/** Manual cost journals: proposed (submitted) → approved (posted) or rejected, by someone else. */
export const JOURNAL_STATUSES = ["submitted", "approved", "rejected"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
export const JOURNAL_KINDS = ["adjustment", "reversal"] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** A petty-cash float per site; closed floats keep their history. */
export const FLOAT_STATUSES = ["active", "closed"] as const;
export type FloatStatus = (typeof FLOAT_STATUSES)[number];

/** What moves a float's book balance (its own append-only ledger). */
export const FLOAT_ENTRY_KINDS = [
  "top_up",
  "expense",
  "expense_rejected",
  "count_adjustment",
] as const;
export type FloatEntryKind = (typeof FLOAT_ENTRY_KINDS)[number];

/**
 * Petty-cash expenses: submitted (the cash has left the float) → approved (posted to the cost
 * ledger) or rejected (the custodian owes the cash back; the book balance is restored).
 */
export const EXPENSE_STATUSES = ["submitted", "approved", "rejected"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export const EXPENSE_PAYMENT_METHODS = ["cash", "mpesa"] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];
export const EXPENSE_SOURCES = ["web", "site_app"] as const;
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

/**
 * Top-ups: requested → approved (payments.approve, step-up, not the requester) → paid (recorded
 * by someone with payments.disburse who did not approve it; the float's balance rises); requested
 * or approved → rejected or cancelled with a reason.
 */
export const TOP_UP_STATUSES = ["requested", "approved", "paid", "rejected", "cancelled"] as const;
export type TopUpStatus = (typeof TOP_UP_STATUSES)[number];
export const TOP_UP_METHODS = ["mpesa", "bank_transfer", "cash", "cheque"] as const;
export type TopUpMethod = (typeof TOP_UP_METHODS)[number];

/** Cash counts: submitted → approved (variance posted) or returned (recount), independently. */
export const COUNT_STATUSES = ["submitted", "approved", "returned"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

/** Manual cash-flow lines (expected client receipts until certificates exist; other payments). */
export const CASH_FLOW_DIRECTIONS = ["in", "out"] as const;
export type CashFlowDirection = (typeof CASH_FLOW_DIRECTIONS)[number];
export const CASH_FLOW_ITEM_STATUSES = ["expected", "received", "cancelled"] as const;
export type CashFlowItemStatus = (typeof CASH_FLOW_ITEM_STATUSES)[number];

/** Rows of the weekly cash-flow forecast. */
export const FORECAST_LINE_KINDS = [
  "client_receipts",
  "other_receipts",
  "payroll",
  "supplier_invoices",
  "lpo_commitments",
  "petty_cash_top_ups",
  "other_payments",
] as const;
export type ForecastLineKind = (typeof FORECAST_LINE_KINDS)[number];
/** How sure a forecast amount is: recorded (a document says so) or estimated (a projection). */
export const FORECAST_BASES = ["recorded", "estimated"] as const;
export type ForecastBasis = (typeof FORECAST_BASES)[number];

/** In-app spend alerts (computed on read; notifications are Phase 8). */
export const SPEND_ALERT_KINDS = [
  "budget_threshold",
  "unusual_spend",
  "duplicate_payment",
  "missing_documents",
] as const;
export type SpendAlertKind = (typeof SPEND_ALERT_KINDS)[number];
export const SPEND_ALERT_SEVERITIES = ["warning", "critical"] as const;
export type SpendAlertSeverity = (typeof SPEND_ALERT_SEVERITIES)[number];

/** Kenyan M-Pesa confirmation messages the parser recognises (EN and SW wording). */
export const MPESA_SMS_KINDS = ["sent", "paybill", "till", "received", "withdraw"] as const;
export type MpesaSmsKind = (typeof MPESA_SMS_KINDS)[number];
/** Messages that record money leaving the float (an expense draft); `received` is money in. */
export const MPESA_OUTFLOW_KINDS = [
  "sent",
  "paybill",
  "till",
  "withdraw",
] as const satisfies readonly MpesaSmsKind[];

/**
 * Who may read budgets, the cost ledger, budget vs actual, the forecast and spend alerts on a
 * project: finance viewers and managers. Portal-only roles (client, supplier, labourer) hold
 * neither, and neither do site agents (they see their petty cash only).
 */
export const SPENDING_READ_PERMISSIONS = [
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/**
 * Who may see a project's petty-cash floats, expenses, top-ups and counts: custodians
 * (`finance.petty_cash`), finance, and the approvers of expenses, top-ups and counts.
 */
export const PETTY_CASH_READ_PERMISSIONS = [
  "finance.petty_cash",
  "finance.view",
  "finance.manage",
  "payments.approve",
  "payments.disburse",
  "procurement.approve",
] as const satisfies readonly Permission[];

/**
 * Who approves petty-cash expenses and cash counts (never the custodian or the recorder): the
 * people who approve spending on the project (project manager, owner) or finance.
 */
export const PETTY_CASH_APPROVE_PERMISSIONS = [
  "finance.manage",
  "procurement.approve",
] as const satisfies readonly Permission[];

/** Who prepares a budget version (approval is `finance.manage` + step-up, by someone else). */
export const BUDGET_PREPARE_PERMISSIONS = [
  "finance.manage",
  "bq.edit",
] as const satisfies readonly Permission[];

/** Company spending settings (CONFIGURATION "Spending"); no row = these defaults. */
export const DEFAULT_SPENDING_SETTINGS = {
  /** A budget line, category or project alerts when actual + committed reaches this % of budget. */
  budgetAlertPercent: 80,
  /** An expense is unusual above this multiple of the site's median expense. */
  unusualSpendMultiplier: "3",
  /** …measured over at least this many earlier expenses of the same float (else no alert). */
  unusualSpendMinSamples: 5,
  /** Same counterparty and amount within this many days counts as a possible duplicate. */
  duplicateWindowDays: 3,
  /** Weeks shown by the cash-flow forecast. */
  forecastWeeks: 13,
} as const;

export const SPENDING_LIMITS = {
  pageSize: 50,
  /** Budget lines per version (a large BQ fits; search and pages in the editor). */
  budgetLines: 5_000,
  journalLines: 50,
  receiptsPerExpense: 3,
  /** Earlier expenses of the float the unusual-spend median looks at. */
  unusualSpendWindow: 20,
  /** How far back alerts look at expenses and settlements. */
  alertLookbackDays: 180,
  /** An expense may be dated at most this many days back. */
  expenseMaxAgeDays: 90,
  /** A pasted SMS is at most this many characters (code points). */
  smsMaxLength: 1_000,
  budgetAlertPercent: { min: 1, max: 100 },
  unusualSpendMultiplier: { min: 1, max: 100 },
  unusualSpendMinSamples: { min: 3, max: 20 },
  duplicateWindowDays: { min: 0, max: 30 },
  forecastWeeks: { min: 4, max: 26 },
  /** BQ items one search returns (budget editor, expense form). */
  bqItemsPerSearch: 50,
} as const;

/** Default company cost codes offered on first use ("Load default cost codes"). */
export const DEFAULT_COST_CODES: readonly {
  code: string;
  nameEn: string;
  category: CostCategory;
}[] = [
  { code: "MAT-01", nameEn: "Materials", category: "materials" },
  { code: "LAB-01", nameEn: "Casual labour", category: "labour" },
  { code: "PLT-01", nameEn: "Plant hire and fuel", category: "plant" },
  { code: "SUB-01", nameEn: "Subcontract works", category: "subcontract" },
  { code: "PRE-01", nameEn: "Site establishment and welfare", category: "preliminaries" },
  { code: "PRE-02", nameEn: "Site security", category: "preliminaries" },
  { code: "FEE-01", nameEn: "Professional fees", category: "fees" },
  { code: "FEE-02", nameEn: "Bank and M-Pesa charges", category: "fees" },
  { code: "PER-01", nameEn: "Approvals and permits", category: "permits" },
  { code: "TRN-01", nameEn: "Transport and deliveries", category: "transport" },
  { code: "PC-01", nameEn: "Petty-cash sundries", category: "petty_cash" },
];
