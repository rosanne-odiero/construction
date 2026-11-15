/**
 * D5.4 spending in the Playwright mock API: company cost codes and settings, versioned budgets
 * (prepare → submit → approve on the digest, by someone who did not prepare it), the cost ledger
 * with reversal journals, budget against committed/actual/paid by category, bill and BQ item,
 * petty-cash floats (expenses with receipts and the M-Pesa SMS draft, top-ups maker-checked,
 * counts), manual cash-flow lines, the weekly forecast and spend alerts. Figures, the SMS parser,
 * forecast buckets and alert rules use the real packages/domain functions; requests and responses
 * go through the shared schemas. Permissions follow the API (SpendingAccess): budgets, the ledger,
 * the forecast and alerts need finance.view or finance.manage on the project; petty cash needs
 * PETTY_CASH_READ_PERMISSIONS; company-wide roles (owner, finance) hold their role everywhere.
 * The BQ bill and items below are a spending-local fixture. Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  addCalendarDays,
  bucketForecast,
  budgetRow,
  counterpartyKey,
  duplicatePayments,
  nairobiDate,
  parseMpesaSms,
  sumFigures,
  unusualSpend,
  type BudgetFigures,
  type ForecastItem,
  type PaymentFact,
} from "@pm-buddy/domain";
import {
  BUDGET_PREPARE_PERMISSIONS,
  COST_CATEGORIES,
  DEFAULT_COST_CODES,
  DEFAULT_SPENDING_SETTINGS,
  PETTY_CASH_APPROVE_PERMISSIONS,
  PETTY_CASH_READ_PERMISSIONS,
  SPEND_ALERT_KINDS,
  SPENDING_READ_PERMISSIONS,
  type CostCategory,
  type CostMeasure,
  type CostPurpose,
  type CostSource,
  type Permission,
  type SpendAlertKind,
} from "@pm-buddy/types";
import {
  addBudgetLineRequestSchema,
  approveBudgetRequestSchema,
  billItemsResponseSchema,
  budgetDetailResponseSchema,
  budgetLinesResponseSchema,
  budgetsResponseSchema,
  bqItemSearchResponseSchema,
  cashFlowItemResponseSchema,
  cashFlowItemsResponseSchema,
  costCodeResponseSchema,
  costCodesResponseSchema,
  costLedgerResponseSchema,
  countResponseSchema,
  countsResponseSchema,
  createBudgetRequestSchema,
  createCashFlowItemRequestSchema,
  createCostCodeRequestSchema,
  createCountRequestSchema,
  createExpenseRequestSchema,
  createFloatRequestSchema,
  createJournalRequestSchema,
  createTopUpRequestSchema,
  custodiansResponseSchema,
  expenseResponseSchema,
  expensesResponseSchema,
  floatLedgerResponseSchema,
  floatResponseSchema,
  floatsResponseSchema,
  forecastResponseSchema,
  journalResponseSchema,
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
  spendAlertsResponseSchema,
  spendingSettingsResponseSchema,
  spendingSummaryResponseSchema,
  topUpResponseSchema,
  topUpsResponseSchema,
  updateBudgetLineRequestSchema,
  updateCostCodeRequestSchema,
  updateFloatRequestSchema,
  updateSpendingSettingsRequestSchema,
  versionBodySchema,
  type BudgetLine,
  type CashFlowItem,
  type CostCode,
  type CostEntry,
  type Count,
  type Expense,
  type SpendAlert,
  type SpendingBqItem,
  type SpendingSettings,
  type TopUp,
} from "@pm-buddy/validation";
import type { Person, Reply } from "./mock-bq-model.mts";

const NOW = "2026-11-10T07:45:00.000Z";
const RUIRU_ID = "30000000-0000-4000-8000-000000000001";
const MAIN_PLOT_ID = "31000000-0000-4000-8000-000000000001";
const OWNER: Person = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const PM: Person = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
const AGENT: Person = { id: "21000000-0000-4000-8000-000000000003", displayName: "Kevin Kiprono" };
const FINANCE: Person = {
  id: "21000000-0000-4000-8000-000000000005",
  displayName: "Daniel Mwangi",
};
export const SPENDING_FLOAT_ID = "75000000-0000-4000-8000-000000000001";
export const SPENDING_BUDGET_ID = "76000000-0000-4000-8000-000000000001";
export const SPENDING_BILL_ID = "74000000-0000-4000-8000-000000000001";
const BQ_VERSION_ID = "74000000-0000-4000-8000-0000000000aa";
const INVOICE_ID = "77000000-0000-4000-8000-000000000001";

type ProjectInfo = {
  id: string;
  code: string;
  name: string;
  status: string;
  sites: { id: string; name: string }[];
};

export type SpendingDeps = {
  fail: (status: number, code: string) => Error;
  parse<T>(schema: import("zod").ZodType<T>, body: unknown): T;
  actor: Person;
  projects: ProjectInfo[];
  /** The persona's project permissions (role on company-wide memberships, else role ∩ assignment). */
  projectPermissions(projectId: string): readonly Permission[];
  /** Company-wide role permissions, or null for project-limited members. */
  companyPermissions: readonly Permission[] | null;
  /** People holding `permission` on the project (custodian candidates). */
  holders(projectId: string, permission: Permission): Person[];
  requireStepUp(): void;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  raw: Buffer;
};

type MockBudget = {
  id: string;
  projectId: string;
  versionNo: number;
  name: string;
  notes: string | null;
  status: "draft" | "submitted" | "approved" | "cancelled";
  lines: BudgetLine[];
  contributors: string[];
  createdBy: Person;
  createdAt: string;
  submittedBy: Person | null;
  submittedAt: string | null;
  approvedBy: Person | null;
  approvedAt: string | null;
  returnReason: string | null;
  cancelledBy: Person | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  digest: string | null;
  version: number;
};
type MockFloat = {
  id: string;
  name: string;
  projectId: string;
  siteId: string;
  custodian: Person;
  limitMinor: number;
  balanceMinor: number;
  status: "active" | "closed";
  version: number;
};
type FloatEntry = {
  id: string;
  floatId: string;
  seq: number;
  kind: "top_up" | "expense" | "expense_rejected" | "count_adjustment";
  amountMinor: number;
  balanceMinor: number;
  document: { kind: "top_up" | "expense" | "count"; id: string; number: string };
  recordedBy: Person;
  recordedAt: string;
  businessDate: string;
};
type MockReceipt = {
  id: string;
  expenseId: string;
  content: Buffer;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  uploadedAt: string;
  uploadedBy: Person;
};
type MockExpense = Omit<Expense, "receiptCount" | "float" | "project" | "site"> & {
  floatId: string;
  key: string;
  digest: string;
};
type MockTopUp = Omit<TopUp, "permissions" | "float" | "project"> & {
  floatId: string;
  projectId: string;
};
type MockCount = Omit<Count, "permissions" | "float" | "project"> & {
  floatId: string;
  projectId: string;
};
type MockItem = Omit<CashFlowItem, "permissions" | "project"> & { projectId: string };
type MockJournal = {
  id: string;
  number: string;
  projectId: string;
  kind: "adjustment" | "reversal";
  reason: string;
  status: "submitted" | "approved" | "rejected";
  createdBy: Person;
  createdAt: string;
  decidedBy: Person | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
  lines: {
    id: string;
    measure: CostMeasure;
    category: CostCategory;
    costCodeId: string | null;
    bqItemLineageId: string | null;
    counterpartyName: string | null;
    paymentReference: string | null;
    occurredOn: string;
    amountMinor: number;
    reversesEntryId: string | null;
    postedEntryId: string | null;
  }[];
};

export type SpendingState = {
  settings: SpendingSettings;
  costCodes: CostCode[];
  budgets: MockBudget[];
  entries: CostEntry[];
  journals: MockJournal[];
  floats: MockFloat[];
  floatEntries: FloatEntry[];
  expenses: MockExpense[];
  receipts: MockReceipt[];
  topUps: MockTopUp[];
  counts: MockCount[];
  items: MockItem[];
  /** Approved LPOs not yet invoiced on Ruiru Heights, materials, net of VAT (D5.2 commitments). */
  committedMinor: number;
  numbers: Record<"expense" | "topUp" | "count" | "journal", number>;
};

const BILL = { lineageId: SPENDING_BILL_ID, number: "2", title: "Substructure (synthetic)" };
const BQ_ITEMS: (SpendingBqItem & { amountMinor: number })[] = [
  [
    "74100000-0000-4000-8000-000000000001",
    "A",
    "Reinforced concrete class 25 in column bases (synthetic)",
    "m3",
    39_600_000,
  ],
  [
    "74100000-0000-4000-8000-000000000002",
    "B",
    "Concrete class 25 in ground floor slab (synthetic)",
    "m3",
    56_880_000,
  ],
  [
    "74100000-0000-4000-8000-000000000003",
    "C",
    "Machine-cut stone walling, 200 mm (synthetic)",
    "m2",
    17_400_000,
  ],
].map(([lineageId, ref, description, unit, amountMinor]) => ({
  versionId: BQ_VERSION_ID,
  lineageId: lineageId as string,
  ref: ref as string,
  description: description as string,
  unit: unit as string,
  bill: BILL,
  amountMinor: amountMinor as number,
}));
const item = (lineageId: string | null): SpendingBqItem | null => {
  const found = BQ_ITEMS.find((entry) => entry.lineageId === lineageId);
  if (!found) return null;
  return omit(found, ["amountMinor"]);
};

/** A copy of `value` without `keys`. */
const omit = <T extends object, K extends keyof T>(value: T, keys: readonly K[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as K))) as Omit<
    T,
    K
  >;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const minus = (date: string, days: number) => addCalendarDays(date, -days);
const ruiru = { id: RUIRU_ID, code: "RUI-HTS", name: "Ruiru Heights Apartments" };

export function initialSpending(projects: ProjectInfo[]): SpendingState {
  const today = nairobiDate();
  const ruiruInfo = projects.find((project) => project.id === RUIRU_ID);
  const project = ruiruInfo
    ? { id: ruiruInfo.id, code: ruiruInfo.code, name: ruiruInfo.name }
    : ruiru;
  const site = {
    id: MAIN_PLOT_ID,
    name: ruiruInfo?.sites.find((entry) => entry.id === MAIN_PLOT_ID)?.name ?? "Main plot",
  };
  const costCodes: CostCode[] = DEFAULT_COST_CODES.map((code, index) => ({
    id: `78000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    code: code.code,
    name: code.nameEn,
    category: code.category,
    active: true,
    version: 1,
  }));
  const code = (value: string) => costCodes.find((entry) => entry.code === value)!;
  const costCodeRef = (value: string) => {
    const found = code(value);
    return { id: found.id, code: found.code, name: found.name, category: found.category };
  };
  const line = (
    lineNo: number,
    extra: Partial<BudgetLine> & { amountMinor: number; description: string },
  ): BudgetLine => ({
    id: `76100000-0000-4000-8000-${String(lineNo).padStart(12, "0")}`,
    lineNo,
    bqItem: null,
    costCode: null,
    category: null,
    ...extra,
  });
  const lines: BudgetLine[] = [
    ...BQ_ITEMS.map((entry, index) =>
      line(index + 1, {
        bqItem: item(entry.lineageId),
        description: `${entry.ref} ${entry.description}`,
        amountMinor: entry.amountMinor,
      }),
    ),
    line(4, {
      costCode: costCodeRef("MAT-01"),
      category: "materials",
      description: "Materials into the site store (synthetic)",
      amountMinor: 12_000_000,
    }),
    line(5, {
      costCode: costCodeRef("PC-01"),
      category: "petty_cash",
      description: "Petty-cash sundries (synthetic)",
      amountMinor: 500_000,
    }),
  ];
  const entry = (
    seq: number,
    extra: Partial<CostEntry> & {
      measure: CostMeasure;
      category: CostCategory;
      amountMinor: number;
      source: CostSource;
      purpose: CostPurpose;
      document: CostEntry["document"];
    },
  ): CostEntry => ({
    id: `79000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    project,
    site: null,
    costCode: null,
    bqItem: null,
    counterpartyKind: "supplier",
    supplier: { id: "60000000-0000-4000-8000-000000000001", name: "Mlolongo Quarry (synthetic)" },
    counterpartyName: null,
    paymentReference: null,
    occurredOn: minus(today, 6),
    reversesEntryId: null,
    reversedByEntryId: null,
    recordedBy: FINANCE,
    recordedAt: NOW,
    businessDate: minus(today, 6),
    ...extra,
  });
  const invoice = { kind: "supplier_invoice" as const, id: INVOICE_ID, label: "MQ-INV-1001" };
  const entries: CostEntry[] = [
    entry(1, {
      measure: "accrued",
      category: "materials",
      amountMinor: 7_800_000,
      source: "supplier_invoice",
      purpose: "accrual",
      document: invoice,
    }),
    entry(2, {
      measure: "paid",
      category: "materials",
      amountMinor: 7_800_000,
      source: "invoice_settlement",
      purpose: "payment",
      paymentReference: "SKB7C8D9E0",
      document: { ...invoice, kind: "invoice_settlement" },
    }),
  ];
  const floatId = SPENDING_FLOAT_ID;
  const expense = (
    n: number,
    extra: Partial<MockExpense> & {
      amountMinor: number;
      spentOn: string;
      payeeName: string;
      description: string;
    },
  ): MockExpense => ({
    id: `75100000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: `EXP-${String(n).padStart(4, "0")}`,
    floatId,
    chargeMinor: 0,
    category: "petty_cash",
    costCode: costCodeRef("PC-01"),
    bqItem: null,
    counterpartyKind: "other",
    supplier: null,
    payeeAccount: null,
    payeePhoneMasked: null,
    paymentMethod: "cash",
    mpesaCode: null,
    parsedFromSms: false,
    smsKind: null,
    status: "approved",
    source: "web",
    capturedAt: NOW,
    recordedAt: NOW,
    recordedBy: AGENT,
    decidedBy: PM,
    decidedAt: NOW,
    decisionReason: null,
    version: 2,
    key: `seed-${n}`,
    digest: `seed-${n}`,
    ...extra,
  });
  const expenses: MockExpense[] = [
    expense(1, {
      amountMinor: 60_000,
      spentOn: minus(today, 6),
      payeeName: "Kamau water vendor (synthetic)",
      description: "Drinking water for the crew (synthetic)",
    }),
    expense(2, {
      amountMinor: 70_000,
      spentOn: minus(today, 5),
      payeeName: "Boda boda rider (synthetic)",
      description: "Nails from Ruiru town (synthetic)",
      category: "transport",
      costCode: costCodeRef("TRN-01"),
    }),
    expense(3, {
      amountMinor: 90_000,
      spentOn: minus(today, 4),
      payeeName: "Ruiru Hardware (synthetic)",
      description: "Two padlocks for the store (synthetic)",
    }),
    expense(4, {
      amountMinor: 85_000,
      spentOn: minus(today, 2),
      payeeName: "MWANGI HARDWARE (SYNTHETIC)",
      description: "Binding wire for the column bases (synthetic)",
      category: "materials",
      costCode: null,
      bqItem: item(BQ_ITEMS[0]!.lineageId),
      paymentMethod: "mpesa",
      mpesaCode: "SKE4F5G6H7",
      parsedFromSms: true,
      smsKind: "till",
    }),
    expense(5, {
      amountMinor: 240_000,
      spentOn: minus(today, 3),
      payeeName: "Ruiru Water Bowsers (synthetic)",
      description: "Water bowser for curing (synthetic)",
      paymentMethod: "mpesa",
      mpesaCode: "SKF7G8H9J0",
      chargeMinor: 3_400,
    }),
    expense(6, {
      amountMinor: 85_000,
      spentOn: minus(today, 1),
      payeeName: "Mwangi Hardware (synthetic)",
      description: "More binding wire (synthetic)",
      category: "materials",
      costCode: null,
      bqItem: item(BQ_ITEMS[0]!.lineageId),
      status: "submitted",
      decidedBy: null,
      decidedAt: null,
      version: 1,
    }),
  ];
  // Receipts on the approved expenses; the submitted one has none (a missing-document alert).
  const receipts: MockReceipt[] = expenses
    .filter((row) => row.status === "approved")
    .map((row, index) => ({
      id: `75200000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      expenseId: row.id,
      content: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      ),
      contentType: "image/png",
      uploadedAt: NOW,
      uploadedBy: AGENT,
    }));
  let seq = 2;
  for (const row of expenses.filter((entry) => entry.status === "approved"))
    for (const [measure, purpose] of [
      ["accrued", "accrual"],
      ["paid", "payment"],
    ] as const) {
      seq += 1;
      entries.push(
        entry(seq, {
          measure,
          category: row.category,
          amountMinor: row.amountMinor,
          source: "petty_cash_expense",
          purpose,
          costCode: row.costCode,
          bqItem: row.bqItem,
          site,
          counterpartyKind: "other",
          supplier: null,
          counterpartyName: row.payeeName,
          paymentReference: row.mpesaCode,
          occurredOn: row.spentOn,
          businessDate: row.spentOn,
          recordedBy: PM,
          document: { kind: "petty_cash_expense", id: row.id, label: row.number },
        }),
      );
    }
  const topUpId = "75300000-0000-4000-8000-000000000001";
  const topUps: MockTopUp[] = [
    {
      id: topUpId,
      number: "TOP-0001",
      floatId,
      projectId: RUIRU_ID,
      amountMinor: 3_000_000,
      reason: "Opening float for the main plot (synthetic)",
      status: "paid",
      requestedBy: AGENT,
      requestedAt: NOW,
      decidedBy: FINANCE,
      decidedAt: NOW,
      decisionReason: null,
      paidBy: OWNER,
      paidAt: NOW,
      paidOn: minus(today, 7),
      method: "mpesa",
      reference: "SKD0E1M2O3",
      cancelledBy: null,
      cancelReason: null,
      version: 3,
    },
  ];
  const floatEntries: FloatEntry[] = [];
  let balance = 0;
  const post = (
    kind: FloatEntry["kind"],
    amountMinor: number,
    document: FloatEntry["document"],
    by: Person,
    date: string,
  ) => {
    balance += amountMinor;
    floatEntries.push({
      id: randomUUID(),
      floatId,
      seq: floatEntries.length + 1,
      kind,
      amountMinor,
      balanceMinor: balance,
      document,
      recordedBy: by,
      recordedAt: NOW,
      businessDate: date,
    });
  };
  post(
    "top_up",
    3_000_000,
    { kind: "top_up", id: topUpId, number: "TOP-0001" },
    OWNER,
    minus(today, 7),
  );
  for (const row of expenses)
    post(
      "expense",
      -(row.amountMinor + row.chargeMinor),
      { kind: "expense", id: row.id, number: row.number },
      AGENT,
      row.spentOn,
    );
  return {
    settings: {
      budgetAlertPercent: DEFAULT_SPENDING_SETTINGS.budgetAlertPercent,
      unusualSpendMultiplier: DEFAULT_SPENDING_SETTINGS.unusualSpendMultiplier,
      unusualSpendMinSamples: DEFAULT_SPENDING_SETTINGS.unusualSpendMinSamples,
      duplicateWindowDays: DEFAULT_SPENDING_SETTINGS.duplicateWindowDays,
      forecastWeeks: DEFAULT_SPENDING_SETTINGS.forecastWeeks,
      openingCashMinor: 240_000_000,
      openingCashOn: minus(today, 7),
      version: 1,
      updatedAt: NOW,
    },
    costCodes,
    budgets: [
      {
        id: SPENDING_BUDGET_ID,
        projectId: RUIRU_ID,
        versionNo: 1,
        name: "Ruiru Heights cost budget (synthetic)",
        notes: null,
        status: "approved",
        lines,
        contributors: [PM.id],
        createdBy: PM,
        createdAt: NOW,
        submittedBy: PM,
        submittedAt: NOW,
        approvedBy: FINANCE,
        approvedAt: NOW,
        returnReason: null,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
        digest: sha(lines),
        version: 3,
      },
    ],
    entries,
    journals: [],
    floats: [
      {
        id: floatId,
        name: "Main plot float (synthetic)",
        projectId: RUIRU_ID,
        siteId: MAIN_PLOT_ID,
        custodian: AGENT,
        limitMinor: 5_000_000,
        balanceMinor: balance,
        status: "active",
        version: 1,
      },
    ],
    floatEntries,
    expenses,
    receipts,
    topUps,
    counts: [],
    items: [
      {
        id: "75400000-0000-4000-8000-000000000001",
        projectId: RUIRU_ID,
        direction: "in",
        description: "Client instalment 3 (synthetic)",
        expectedOn: addCalendarDays(today, 17),
        amountMinor: 150_000_000,
        status: "expected",
        receivedOn: null,
        receivedMinor: null,
        reference: "RUI-HTS-INST-3",
        createdBy: FINANCE,
        createdAt: NOW,
        version: 1,
      },
    ],
    committedMinor: 9_480_000,
    numbers: { expense: expenses.length, topUp: 1, count: 0, journal: 0 },
  };
}

const page = (hasMore = false, nextCursor: string | null = null) => ({ hasMore, nextCursor });

class Spending {
  private readonly deps: SpendingDeps;
  private readonly state: SpendingState;
  constructor(deps: SpendingDeps, state: SpendingState) {
    this.deps = deps;
    this.state = state;
  }

  // Access ---------------------------------------------------------------------------------------

  private perms(projectId: string): readonly Permission[] {
    return this.deps.companyPermissions ?? this.deps.projectPermissions(projectId);
  }
  private holds(projectId: string, permissions: readonly Permission[]) {
    const held = this.perms(projectId);
    return permissions.some((permission) => held.includes(permission));
  }
  private project(projectId: string) {
    const found = this.deps.projects.find((entry) => entry.id === projectId);
    if (!found) throw this.deps.fail(404, "not-found");
    return { id: found.id, code: found.code, name: found.name };
  }
  private require(projectId: string, permissions: readonly Permission[]) {
    const project = this.project(projectId);
    if (!this.holds(projectId, permissions)) throw this.deps.fail(403, "forbidden");
    return project;
  }
  private readable(permissions: readonly Permission[]) {
    return this.deps.projects
      .filter((project) => this.holds(project.id, permissions))
      .map((project) => project.id);
  }
  private company(permissions: readonly Permission[]) {
    return Boolean(
      this.deps.companyPermissions?.some((permission) => permissions.includes(permission)),
    );
  }
  private next(kind: keyof SpendingState["numbers"], prefix: string) {
    this.state.numbers[kind] += 1;
    return `${prefix}-${String(this.state.numbers[kind]).padStart(4, "0")}`;
  }
  private site(projectId: string, siteId: string) {
    const site = this.deps.projects
      .find((entry) => entry.id === projectId)
      ?.sites.find((entry) => entry.id === siteId);
    return { id: siteId, name: site?.name ?? "Site" };
  }
  private costCodeRef(id: string | null | undefined) {
    const code = this.state.costCodes.find((entry) => entry.id === id);
    if (!code) return null;
    return { id: code.id, code: code.code, name: code.name, category: code.category };
  }

  // Settings and cost codes ------------------------------------------------------------------------

  settings(): Reply {
    const company = this.company(SPENDING_READ_PERMISSIONS);
    if (!company && !this.readable(SPENDING_READ_PERMISSIONS).length)
      throw this.deps.fail(403, "forbidden");
    const settings = company
      ? this.state.settings
      : { ...this.state.settings, openingCashMinor: null, openingCashOn: null };
    return {
      body: { settings, permissions: { canEdit: this.company(["finance.manage"]) } },
      schema: spendingSettingsResponseSchema,
    };
  }
  updateSettings(body: unknown): Reply {
    if (!this.company(["finance.manage"])) throw this.deps.fail(403, "forbidden");
    const input = this.deps.parse(updateSpendingSettingsRequestSchema, body);
    if (input.version !== this.state.settings.version)
      throw this.deps.fail(409, "version-conflict");
    this.state.settings = {
      ...omit(input, ["version"]),
      version: this.state.settings.version + 1,
      updatedAt: new Date().toISOString(),
    };
    return this.settings();
  }
  costCodes(query: URLSearchParams): Reply {
    const readers = [
      ...SPENDING_READ_PERMISSIONS,
      ...PETTY_CASH_READ_PERMISSIONS,
      ...BUDGET_PREPARE_PERMISSIONS,
    ];
    if (!this.company(readers) && !this.readable(readers).length)
      throw this.deps.fail(403, "forbidden");
    const search = (query.get("search") ?? "").trim().toLowerCase();
    const cursor = query.get("cursor");
    const limit = Math.min(200, Number(query.get("limit") ?? 50) || 50);
    const rows = this.state.costCodes
      .filter((code) => query.get("includeInactive") === "true" || code.active)
      .filter(
        (code) =>
          !search ||
          code.code.toLowerCase().includes(search) ||
          code.name.toLowerCase().includes(search),
      )
      .filter((code) => !cursor || code.code > cursor)
      .sort((a, b) => (a.code < b.code ? -1 : 1));
    const shown = rows.slice(0, limit);
    return {
      body: {
        costCodes: shown,
        page: page(rows.length > limit, rows.length > limit ? shown.at(-1)!.code : null),
        permissions: { canManage: this.company(["finance.manage"]) },
      },
      schema: costCodesResponseSchema,
    };
  }
  createCostCode(body: unknown): Reply {
    if (!this.company(["finance.manage"])) throw this.deps.fail(403, "forbidden");
    const input = this.deps.parse(createCostCodeRequestSchema, body);
    if (this.state.costCodes.some((code) => code.code === input.code))
      throw this.deps.fail(409, "cost-code-taken");
    const code: CostCode = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      category: input.category,
      active: true,
      version: 1,
    };
    this.state.costCodes.push(code);
    return { status: 201, body: { costCode: code }, schema: costCodeResponseSchema };
  }
  updateCostCode(id: string, body: unknown): Reply {
    if (!this.company(["finance.manage"])) throw this.deps.fail(403, "forbidden");
    const input = this.deps.parse(updateCostCodeRequestSchema, body);
    const code = this.state.costCodes.find((entry) => entry.id === id);
    if (!code) throw this.deps.fail(404, "not-found");
    if (code.version !== input.version) throw this.deps.fail(409, "version-conflict");
    Object.assign(code, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      version: code.version + 1,
    });
    return { body: { costCode: code }, schema: costCodeResponseSchema };
  }
  loadDefaults(): Reply {
    if (!this.company(["finance.manage"])) throw this.deps.fail(403, "forbidden");
    let created = 0;
    for (const entry of DEFAULT_COST_CODES)
      if (!this.state.costCodes.some((code) => code.code === entry.code)) {
        created += 1;
        this.state.costCodes.push({
          id: randomUUID(),
          code: entry.code,
          name: entry.nameEn,
          category: entry.category,
          active: true,
          version: 1,
        });
      }
    return {
      status: 201,
      body: { created, existing: DEFAULT_COST_CODES.length - created },
      schema: loadCostCodeDefaultsResponseSchema,
    };
  }

  // Budget against actual and committed ------------------------------------------------------------

  private current(projectId: string) {
    return this.state.budgets
      .filter((budget) => budget.projectId === projectId && budget.status === "approved")
      .sort((a, b) => b.versionNo - a.versionNo)[0];
  }
  private entriesOf(projectId: string) {
    return this.state.entries.filter((entry) => entry.project.id === projectId);
  }
  private figures(
    entries: readonly CostEntry[],
    budgetMinor: number | null,
    committedMinor: number,
  ): BudgetFigures {
    const sum = (measure: CostMeasure) =>
      entries
        .filter((entry) => entry.measure === measure)
        .reduce((total, entry) => total + entry.amountMinor, 0);
    return { budgetMinor, committedMinor, actualMinor: sum("accrued"), paidMinor: sum("paid") };
  }
  private projectFacts(projectId: string) {
    const threshold = this.state.settings.budgetAlertPercent;
    const budget = this.current(projectId);
    const lines = budget?.lines ?? [];
    const entries = this.entriesOf(projectId);
    const committed = projectId === RUIRU_ID ? this.state.committedMinor : 0;
    const lineSum = (filter: (line: BudgetLine) => boolean) => {
      const chosen = lines.filter(filter);
      return chosen.length ? chosen.reduce((total, line) => total + line.amountMinor, 0) : null;
    };
    const categories = COST_CATEGORIES.map((category) => ({
      category,
      ...budgetRow(
        this.figures(
          entries.filter((entry) => entry.category === category),
          lineSum((line) => line.category === category),
          category === "materials" ? committed : 0,
        ),
        threshold,
      ),
    }));
    const bills =
      budget || BQ_ITEMS.length
        ? [
            {
              bill: BILL,
              itemCount: BQ_ITEMS.length,
              ...budgetRow(
                this.figures(
                  entries.filter((entry) => entry.bqItem?.bill?.lineageId === BILL.lineageId),
                  lineSum((line) => line.bqItem?.bill?.lineageId === BILL.lineageId),
                  0,
                ),
                threshold,
              ),
            },
          ]
        : [];
    const notOnBqItems = budgetRow(
      this.figures(
        entries.filter((entry) => !entry.bqItem),
        lineSum((line) => !line.bqItem),
        committed,
      ),
      threshold,
    );
    const totals = budgetRow(
      sumFigures([this.figures(entries, budget ? (lineSum(() => true) ?? 0) : null, committed)]),
      threshold,
    );
    const accrued = entries
      .filter((entry) => entry.source === "supplier_invoice" && entry.measure === "accrued")
      .reduce((total, entry) => total + entry.amountMinor, 0);
    return {
      budget,
      threshold,
      categories,
      bills: projectId === RUIRU_ID ? bills : [],
      notOnBqItems,
      totals,
      uncategorisedBudgetMinor: lines
        .filter((line) => line.bqItem && !line.category)
        .reduce((total, line) => total + line.amountMinor, 0),
      cashPaidMinor:
        entries
          .filter((entry) => entry.measure === "paid")
          .reduce((total, entry) => total + entry.amountMinor, 0) +
        (projectId === RUIRU_ID ? 1_248_000 : 0),
      materials: {
        accruedMinor: accrued,
        issuedMinor: 0,
        notIssuedMinor: accrued,
        transferredInMinor: 0,
        transferredOutMinor: 0,
      },
    };
  }
  private budgetRef(budget: MockBudget | undefined) {
    return budget
      ? {
          id: budget.id,
          versionNo: budget.versionNo,
          name: budget.name,
          approvedAt: budget.approvedAt,
        }
      : null;
  }
  summary(): Reply {
    const ids = this.readable(SPENDING_READ_PERMISSIONS);
    return {
      body: {
        thresholdPercent: this.state.settings.budgetAlertPercent,
        projects: ids.map((projectId) => {
          const facts = this.projectFacts(projectId);
          return {
            project: this.project(projectId),
            budget: this.budgetRef(facts.budget),
            figures: facts.totals,
            cashPaidMinor: facts.cashPaidMinor,
          };
        }),
      },
      schema: spendingSummaryResponseSchema,
    };
  }
  projectSpending(projectId: string): Reply {
    const project = this.require(projectId, SPENDING_READ_PERMISSIONS);
    const facts = this.projectFacts(projectId);
    return {
      body: {
        project,
        budget: this.budgetRef(facts.budget),
        thresholdPercent: facts.threshold,
        totals: facts.totals,
        cashPaidMinor: facts.cashPaidMinor,
        categories: facts.categories,
        uncategorisedBudgetMinor: facts.uncategorisedBudgetMinor,
        bills: facts.bills,
        notOnBqItems: facts.notOnBqItems,
        materials: facts.materials,
        permissions: {
          canPrepareBudget: this.holds(projectId, BUDGET_PREPARE_PERMISSIONS),
          canJournal: this.company(["finance.manage"]),
        },
      },
      schema: projectSpendingResponseSchema,
    };
  }
  billItems(projectId: string, billId: string, query: URLSearchParams): Reply {
    const project = this.require(projectId, SPENDING_READ_PERMISSIONS);
    if (billId !== BILL.lineageId || projectId !== RUIRU_ID) throw this.deps.fail(404, "not-found");
    const search = (query.get("search") ?? "").trim().toLowerCase();
    const budget = this.current(projectId);
    const entries = this.entriesOf(projectId);
    const items = BQ_ITEMS.filter(
      (entry) => !search || `${entry.ref} ${entry.description}`.toLowerCase().includes(search),
    ).map((entry) => {
      const budgetLine = budget?.lines.find((line) => line.bqItem?.lineageId === entry.lineageId);
      return {
        item: item(entry.lineageId)!,
        contractAmountMinor: entry.amountMinor,
        ...budgetRow(
          this.figures(
            entries.filter((row) => row.bqItem?.lineageId === entry.lineageId),
            budgetLine ? budgetLine.amountMinor : null,
            0,
          ),
          this.state.settings.budgetAlertPercent,
        ),
      };
    });
    return {
      body: {
        project,
        bill: BILL,
        thresholdPercent: this.state.settings.budgetAlertPercent,
        items,
        page: page(),
      },
      schema: billItemsResponseSchema,
    };
  }
  bqItems(projectId: string, query: URLSearchParams): Reply {
    this.project(projectId);
    if (
      !this.holds(projectId, [
        ...SPENDING_READ_PERMISSIONS,
        ...PETTY_CASH_READ_PERMISSIONS,
        ...BUDGET_PREPARE_PERMISSIONS,
      ])
    )
      throw this.deps.fail(403, "forbidden");
    const search = (query.get("search") ?? "").trim().toLowerCase();
    const items =
      projectId === RUIRU_ID
        ? BQ_ITEMS.filter(
            (entry) =>
              !search || `${entry.ref} ${entry.description}`.toLowerCase().includes(search),
          ).map((entry) => item(entry.lineageId)!)
        : [];
    return {
      body: { items, truncated: false, versionId: projectId === RUIRU_ID ? BQ_VERSION_ID : null },
      schema: bqItemSearchResponseSchema,
    };
  }

  // Cost ledger and journals ----------------------------------------------------------------------

  ledger(query: URLSearchParams): Reply {
    const ids = this.readable(SPENDING_READ_PERMISSIONS);
    const projectId = query.get("projectId");
    if (projectId) this.require(projectId, SPENDING_READ_PERMISSIONS);
    const rows = this.state.entries
      .filter((entry) => ids.includes(entry.project.id))
      .filter((entry) => !projectId || entry.project.id === projectId)
      .filter((entry) => !query.get("measure") || entry.measure === query.get("measure"))
      .filter((entry) => !query.get("category") || entry.category === query.get("category"))
      .filter((entry) => !query.get("source") || entry.source === query.get("source"))
      .filter(
        (entry) =>
          !query.get("bqItemLineageId") || entry.bqItem?.lineageId === query.get("bqItemLineageId"),
      )
      .filter((entry) => !query.get("from") || entry.occurredOn >= query.get("from")!)
      .filter((entry) => !query.get("to") || entry.occurredOn <= query.get("to")!)
      .reverse();
    const sum = (measure: CostMeasure) =>
      rows
        .filter((entry) => entry.measure === measure)
        .reduce((total, entry) => total + entry.amountMinor, 0);
    return {
      body: {
        entries: rows.slice(0, 50),
        totals: { accruedMinor: sum("accrued"), paidMinor: sum("paid"), count: rows.length },
        page: page(),
        permissions: { canReverse: this.company(["finance.manage"]) },
      },
      schema: costLedgerResponseSchema,
    };
  }
  private journalWire(journal: MockJournal) {
    const decider =
      this.company(["finance.manage"]) &&
      journal.status === "submitted" &&
      journal.createdBy.id !== this.deps.actor.id;
    return {
      journal: {
        id: journal.id,
        number: journal.number,
        project: this.project(journal.projectId),
        kind: journal.kind,
        reason: journal.reason,
        status: journal.status,
        lineCount: journal.lines.length,
        totalMinor: journal.lines.reduce((total, line) => total + line.amountMinor, 0),
        createdBy: journal.createdBy,
        createdAt: journal.createdAt,
        decidedBy: journal.decidedBy,
        decidedAt: journal.decidedAt,
        decisionReason: journal.decisionReason,
        version: journal.version,
        lines: journal.lines.map((line, index) => ({
          id: line.id,
          lineNo: index + 1,
          measure: line.measure,
          category: line.category,
          costCode: this.costCodeRef(line.costCodeId),
          bqItem: item(line.bqItemLineageId),
          site: null,
          counterpartyKind: line.counterpartyName ? ("other" as const) : ("none" as const),
          supplier: null,
          counterpartyName: line.counterpartyName,
          paymentReference: line.paymentReference,
          occurredOn: line.occurredOn,
          amountMinor: line.amountMinor,
          reversesEntryId: line.reversesEntryId,
          postedEntryId: line.postedEntryId,
        })),
      },
      permissions: { canApprove: decider, canReject: decider },
    };
  }
  journals(query: URLSearchParams): Reply {
    const ids = this.readable(SPENDING_READ_PERMISSIONS);
    const rows = this.state.journals
      .filter((journal) => ids.includes(journal.projectId))
      .filter((journal) => !query.get("projectId") || journal.projectId === query.get("projectId"))
      .filter((journal) => !query.get("status") || journal.status === query.get("status"))
      .reverse()
      .map((journal) => omit(this.journalWire(journal).journal, ["lines"]));
    return {
      body: {
        journals: rows,
        page: page(),
        permissions: { canCreate: this.company(["finance.manage"]) },
      },
      schema: journalsResponseSchema,
    };
  }
  journal(id: string): Reply {
    const journal = this.state.journals.find((entry) => entry.id === id);
    if (!journal) throw this.deps.fail(404, "not-found");
    this.require(journal.projectId, SPENDING_READ_PERMISSIONS);
    return { body: this.journalWire(journal), schema: journalResponseSchema };
  }
  createJournal(body: unknown): Reply {
    const input = this.deps.parse(createJournalRequestSchema, body);
    this.require(input.projectId, ["finance.manage"]);
    if (!this.company(["finance.manage"])) throw this.deps.fail(403, "forbidden");
    const journal: MockJournal = {
      id: randomUUID(),
      number: this.next("journal", "JNL"),
      projectId: input.projectId,
      kind: "adjustment",
      reason: input.reason,
      status: "submitted",
      createdBy: this.deps.actor,
      createdAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      version: 1,
      lines: input.lines.map((line) => ({
        id: randomUUID(),
        measure: line.measure,
        category: line.category,
        costCodeId: line.costCodeId ?? null,
        bqItemLineageId: line.bqItemLineageId ?? null,
        counterpartyName: line.counterpartyName ?? null,
        paymentReference: line.paymentReference ?? null,
        occurredOn: line.occurredOn,
        amountMinor: line.amountMinor,
        reversesEntryId: null,
        postedEntryId: null,
      })),
    };
    this.state.journals.push(journal);
    return { status: 201, body: this.journalWire(journal), schema: journalResponseSchema };
  }
  reverse(body: unknown): Reply {
    const input = this.deps.parse(reversalJournalRequestSchema, body);
    const entry = this.state.entries.find((row) => row.id === input.entryId);
    if (!entry) throw this.deps.fail(404, "entry-not-found");
    this.require(entry.project.id, ["finance.manage"]);
    if (!this.company(["finance.manage"])) throw this.deps.fail(403, "forbidden");
    if (entry.reversesEntryId) throw this.deps.fail(409, "entry-is-reversal");
    if (
      entry.reversedByEntryId ||
      this.state.journals.some(
        (journal) =>
          journal.status === "submitted" &&
          journal.lines.some((line) => line.reversesEntryId === entry.id),
      )
    )
      throw this.deps.fail(409, "entry-already-reversed");
    const journal: MockJournal = {
      id: randomUUID(),
      number: this.next("journal", "JNL"),
      projectId: entry.project.id,
      kind: "reversal",
      reason: input.reason,
      status: "submitted",
      createdBy: this.deps.actor,
      createdAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      version: 1,
      lines: [
        {
          id: randomUUID(),
          measure: entry.measure,
          category: entry.category,
          costCodeId: entry.costCode?.id ?? null,
          bqItemLineageId: entry.bqItem?.lineageId ?? null,
          counterpartyName: entry.counterpartyName,
          paymentReference: entry.paymentReference,
          occurredOn: entry.occurredOn,
          amountMinor: -entry.amountMinor,
          reversesEntryId: entry.id,
          postedEntryId: null,
        },
      ],
    };
    this.state.journals.push(journal);
    return { status: 201, body: this.journalWire(journal), schema: journalResponseSchema };
  }
  decideJournal(id: string, action: "approve" | "reject", body: unknown): Reply {
    const journal = this.state.journals.find((entry) => entry.id === id);
    if (!journal) throw this.deps.fail(404, "not-found");
    this.require(journal.projectId, ["finance.manage"]);
    const input =
      action === "approve"
        ? this.deps.parse(versionBodySchema, body)
        : this.deps.parse(reasonBodySchema, body);
    if (journal.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
    if (journal.version !== input.version) throw this.deps.fail(409, "version-conflict");
    if (journal.createdBy.id === this.deps.actor.id) throw this.deps.fail(403, "maker-checker");
    if (action === "approve") {
      this.deps.requireStepUp();
      const today = nairobiDate();
      for (const line of journal.lines) {
        const posted: CostEntry = {
          id: randomUUID(),
          project: this.project(journal.projectId),
          site: null,
          measure: line.measure,
          category: line.category,
          costCode: this.costCodeRef(line.costCodeId),
          bqItem: item(line.bqItemLineageId),
          counterpartyKind: line.counterpartyName ? "other" : "none",
          supplier: null,
          counterpartyName: line.counterpartyName,
          paymentReference: line.paymentReference,
          amountMinor: line.amountMinor,
          occurredOn: line.occurredOn,
          source: "cost_journal",
          purpose: line.reversesEntryId ? "reversal" : "journal",
          document: { kind: "cost_journal", id: journal.id, label: journal.number },
          reversesEntryId: line.reversesEntryId,
          reversedByEntryId: null,
          recordedBy: this.deps.actor,
          recordedAt: new Date().toISOString(),
          businessDate: today,
        };
        this.state.entries.push(posted);
        line.postedEntryId = posted.id;
        const original = this.state.entries.find((entry) => entry.id === line.reversesEntryId);
        if (original) original.reversedByEntryId = posted.id;
      }
    }
    Object.assign(journal, {
      status: action === "approve" ? "approved" : "rejected",
      decidedBy: this.deps.actor,
      decidedAt: new Date().toISOString(),
      decisionReason: "reason" in input ? input.reason : null,
      version: journal.version + 1,
    });
    return { body: this.journalWire(journal), schema: journalResponseSchema };
  }

  // Budgets --------------------------------------------------------------------------------------

  private budgetDetail(budget: MockBudget) {
    const preparer = this.holds(budget.projectId, BUDGET_PREPARE_PERMISSIONS);
    const approver = this.holds(budget.projectId, ["finance.manage"]);
    const contributor = budget.contributors.includes(this.deps.actor.id);
    const totalMinor = budget.lines.reduce((total, line) => total + line.amountMinor, 0);
    const current = this.current(budget.projectId)?.id === budget.id;
    const byCategory = new Map<CostCategory | null, number>();
    for (const line of budget.lines)
      byCategory.set(line.category, (byCategory.get(line.category) ?? 0) + line.amountMinor);
    const billTotal = budget.lines
      .filter((line) => line.bqItem)
      .reduce((total, line) => total + line.amountMinor, 0);
    const codeTotal = budget.lines
      .filter((line) => !line.bqItem)
      .reduce((total, line) => total + line.amountMinor, 0);
    return {
      budget: {
        id: budget.id,
        project: this.project(budget.projectId),
        versionNo: budget.versionNo,
        name: budget.name,
        status: budget.status,
        totalMinor,
        lineCount: budget.lines.length,
        bqVersion: budget.projectId === RUIRU_ID ? { id: BQ_VERSION_ID, versionNo: 1 } : null,
        createdBy: budget.createdBy,
        createdAt: budget.createdAt,
        submittedAt: budget.submittedAt,
        approvedBy: budget.approvedBy,
        approvedAt: budget.approvedAt,
        current,
        version: budget.version,
        notes: budget.notes,
        digest: budget.digest,
        submittedBy: budget.submittedBy,
        returnReason: budget.returnReason,
        cancelledBy: budget.cancelledBy,
        cancelledAt: budget.cancelledAt,
        cancelReason: budget.cancelReason,
      },
      totals: {
        byCategory: [...byCategory.entries()].map(([category, amountMinor]) => ({
          category,
          amountMinor,
        })),
        byBill: [
          ...(budget.lines.some((line) => line.bqItem)
            ? [{ bill: BILL, amountMinor: billTotal }]
            : []),
          ...(budget.lines.some((line) => !line.bqItem)
            ? [{ bill: null, amountMinor: codeTotal }]
            : []),
        ],
      },
      permissions: {
        canEdit: preparer && budget.status === "draft",
        canSubmit: preparer && budget.status === "draft" && budget.lines.length > 0,
        canApprove: approver && budget.status === "submitted" && !contributor,
        canReturn: approver && budget.status === "submitted",
        canCancel: preparer && (budget.status === "draft" || budget.status === "submitted"),
      },
    };
  }
  private budget(id: string) {
    const budget = this.state.budgets.find((entry) => entry.id === id);
    if (!budget) throw this.deps.fail(404, "not-found");
    if (
      !this.holds(budget.projectId, [...SPENDING_READ_PERMISSIONS, ...BUDGET_PREPARE_PERMISSIONS])
    )
      throw this.deps.fail(403, "forbidden");
    return budget;
  }
  budgets(query: URLSearchParams): Reply {
    const projectId = query.get("projectId") ?? "";
    const project = this.require(projectId, [
      ...SPENDING_READ_PERMISSIONS,
      ...BUDGET_PREPARE_PERMISSIONS,
    ]);
    const rows = this.state.budgets
      .filter((budget) => budget.projectId === projectId)
      .sort((a, b) => b.versionNo - a.versionNo);
    const open = rows.some((budget) => budget.status === "draft" || budget.status === "submitted");
    return {
      body: {
        project,
        budgets: rows.map((budget) =>
          omit(this.budgetDetail(budget).budget, [
            "notes",
            "digest",
            "submittedBy",
            "returnReason",
            "cancelledBy",
            "cancelledAt",
            "cancelReason",
          ]),
        ),
        permissions: { canCreate: this.holds(projectId, BUDGET_PREPARE_PERMISSIONS) && !open },
      },
      schema: budgetsResponseSchema,
    };
  }
  budgetDetailReply(id: string, status = 200): Reply {
    return { status, body: this.budgetDetail(this.budget(id)), schema: budgetDetailResponseSchema };
  }
  createBudget(body: unknown): Reply {
    const input = this.deps.parse(createBudgetRequestSchema, body);
    this.require(input.projectId, BUDGET_PREPARE_PERMISSIONS);
    if (
      this.state.budgets.some(
        (budget) =>
          budget.projectId === input.projectId &&
          (budget.status === "draft" || budget.status === "submitted"),
      )
    )
      throw this.deps.fail(409, "budget-open");
    if (input.source === "bq" && input.projectId !== RUIRU_ID)
      throw this.deps.fail(409, "bq-not-approved");
    const current = this.current(input.projectId);
    const lines: BudgetLine[] =
      input.source === "bq"
        ? BQ_ITEMS.map((entry, index) => ({
            id: randomUUID(),
            lineNo: index + 1,
            bqItem: item(entry.lineageId),
            costCode: null,
            category: null,
            description: `${entry.ref} ${entry.description}`,
            amountMinor: entry.amountMinor,
          }))
        : input.source === "copy" && current
          ? current.lines.map((line) => ({ ...line, id: randomUUID() }))
          : [];
    const budget: MockBudget = {
      id: randomUUID(),
      projectId: input.projectId,
      versionNo:
        Math.max(
          0,
          ...this.state.budgets
            .filter((entry) => entry.projectId === input.projectId)
            .map((entry) => entry.versionNo),
        ) + 1,
      name: input.name,
      notes: input.notes ?? null,
      status: "draft",
      lines,
      contributors: [this.deps.actor.id],
      createdBy: this.deps.actor,
      createdAt: new Date().toISOString(),
      submittedBy: null,
      submittedAt: null,
      approvedBy: null,
      approvedAt: null,
      returnReason: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      digest: null,
      version: 1,
    };
    this.state.budgets.push(budget);
    return this.budgetDetailReply(budget.id, 201);
  }
  private editable(id: string, version: number) {
    const budget = this.budget(id);
    this.require(budget.projectId, BUDGET_PREPARE_PERMISSIONS);
    if (budget.status !== "draft") throw this.deps.fail(409, "invalid-transition");
    if (budget.version !== version) throw this.deps.fail(409, "version-conflict");
    if (!budget.contributors.includes(this.deps.actor.id))
      budget.contributors.push(this.deps.actor.id);
    budget.version += 1;
    return budget;
  }
  budgetLines(id: string, query: URLSearchParams): Reply {
    const budget = this.budget(id);
    const search = (query.get("search") ?? "").trim().toLowerCase();
    const lines = budget.lines
      .filter(
        (line) =>
          !search ||
          `${line.description} ${line.costCode?.code ?? ""} ${line.bqItem?.ref ?? ""}`
            .toLowerCase()
            .includes(search),
      )
      .map((line, index) => ({ ...line, lineNo: index + 1 }));
    return { body: { lines, page: page() }, schema: budgetLinesResponseSchema };
  }
  addLine(id: string, body: unknown): Reply {
    const input = this.deps.parse(addBudgetLineRequestSchema, body);
    const budget = this.editable(id, input.version);
    const bqItem = item(input.bqItemLineageId ?? null);
    const costCode = this.costCodeRef(input.costCodeId);
    if (input.bqItemLineageId && !bqItem) throw this.deps.fail(422, "bq-item-not-found");
    if (input.costCodeId && !costCode) throw this.deps.fail(422, "cost-code-not-found");
    if (
      budget.lines.some(
        (line) =>
          (bqItem && line.bqItem?.lineageId === bqItem.lineageId) ||
          (costCode && line.costCode?.id === costCode.id),
      )
    )
      throw this.deps.fail(409, "budget-line-exists");
    budget.lines.push({
      id: randomUUID(),
      lineNo: budget.lines.length + 1,
      bqItem,
      costCode,
      category: costCode ? costCode.category : (input.category ?? null),
      description: input.description ?? (costCode ? costCode.name : (bqItem?.description ?? "")),
      amountMinor: input.amountMinor,
    });
    return this.budgetDetailReply(id, 201);
  }
  updateLine(id: string, lineId: string, body: unknown): Reply {
    const input = this.deps.parse(updateBudgetLineRequestSchema, body);
    const budget = this.editable(id, input.version);
    const line = budget.lines.find((entry) => entry.id === lineId);
    if (!line) throw this.deps.fail(404, "not-found");
    if (input.amountMinor !== undefined) line.amountMinor = input.amountMinor;
    if (input.description !== undefined) line.description = input.description;
    return this.budgetDetailReply(id);
  }
  removeLine(id: string, lineId: string, query: URLSearchParams): Reply {
    const budget = this.editable(id, Number(query.get("version")));
    budget.lines = budget.lines.filter((entry) => entry.id !== lineId);
    return this.budgetDetailReply(id);
  }
  decideBudget(
    id: string,
    action: "submit" | "approve" | "return" | "cancel",
    body: unknown,
  ): Reply {
    const budget = this.budget(id);
    if (action === "submit") {
      const input = this.deps.parse(versionBodySchema, body);
      this.require(budget.projectId, BUDGET_PREPARE_PERMISSIONS);
      if (budget.status !== "draft") throw this.deps.fail(409, "invalid-transition");
      if (budget.version !== input.version) throw this.deps.fail(409, "version-conflict");
      if (!budget.lines.length) throw this.deps.fail(409, "budget-empty");
      Object.assign(budget, {
        status: "submitted",
        digest: sha(budget.lines),
        submittedBy: this.deps.actor,
        submittedAt: new Date().toISOString(),
        returnReason: null,
        version: budget.version + 1,
      });
    } else if (action === "approve") {
      const input = this.deps.parse(approveBudgetRequestSchema, body);
      this.require(budget.projectId, ["finance.manage"]);
      this.deps.requireStepUp();
      if (budget.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
      if (budget.version !== input.version) throw this.deps.fail(409, "version-conflict");
      if (budget.digest !== input.digest) throw this.deps.fail(409, "budget-stale");
      if (budget.contributors.includes(this.deps.actor.id))
        throw this.deps.fail(403, "maker-checker");
      Object.assign(budget, {
        status: "approved",
        approvedBy: this.deps.actor,
        approvedAt: new Date().toISOString(),
        version: budget.version + 1,
      });
    } else {
      const input = this.deps.parse(reasonBodySchema, body);
      this.require(
        budget.projectId,
        action === "return" ? ["finance.manage"] : BUDGET_PREPARE_PERMISSIONS,
      );
      if (budget.version !== input.version) throw this.deps.fail(409, "version-conflict");
      if (action === "return") {
        if (budget.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
        Object.assign(budget, {
          status: "draft",
          returnReason: input.reason,
          digest: null,
          version: budget.version + 1,
        });
      } else {
        if (budget.status !== "draft" && budget.status !== "submitted")
          throw this.deps.fail(409, "invalid-transition");
        Object.assign(budget, {
          status: "cancelled",
          cancelledBy: this.deps.actor,
          cancelledAt: new Date().toISOString(),
          cancelReason: input.reason,
          version: budget.version + 1,
        });
      }
    }
    return this.budgetDetailReply(id);
  }

  // Petty cash -------------------------------------------------------------------------------------

  float(id: string) {
    const float = this.state.floats.find((entry) => entry.id === id);
    if (!float) throw this.deps.fail(404, "not-found");
    this.require(float.projectId, PETTY_CASH_READ_PERMISSIONS);
    return float;
  }
  private operator(float: MockFloat) {
    const perms = this.perms(float.projectId);
    return (
      (float.custodian.id === this.deps.actor.id && perms.includes("finance.petty_cash")) ||
      perms.includes("finance.manage")
    );
  }
  private floatSummary(float: MockFloat) {
    const approved = this.state.counts
      .filter((count) => count.floatId === float.id && count.status === "approved")
      .at(-1);
    const entries = this.state.floatEntries.filter((entry) => entry.floatId === float.id);
    return {
      id: float.id,
      name: float.name,
      project: this.project(float.projectId),
      site: this.site(float.projectId, float.siteId),
      custodian: float.custodian,
      limitMinor: float.limitMinor,
      balanceMinor: float.balanceMinor,
      status: float.status,
      lastEntryAt: entries.at(-1)?.recordedAt ?? null,
      submittedExpenses: this.state.expenses.filter(
        (expense) => expense.floatId === float.id && expense.status === "submitted",
      ).length,
      openTopUps: this.state.topUps.filter(
        (topUp) =>
          topUp.floatId === float.id &&
          (topUp.status === "requested" || topUp.status === "approved"),
      ).length,
      openCount: this.state.counts.some(
        (count) => count.floatId === float.id && count.status === "submitted",
      ),
      lastApprovedCount: approved
        ? {
            number: approved.number,
            countedAt: approved.countedAt,
            varianceMinor: approved.varianceMinor,
          }
        : null,
      version: float.version,
    };
  }
  floatReply(float: MockFloat, status = 200): Reply {
    const summary = this.floatSummary(float);
    const active = float.status === "active";
    const operator = this.operator(float);
    const perms = this.perms(float.projectId);
    return {
      status,
      body: {
        float: summary,
        permissions: {
          canRecordExpense:
            active &&
            float.custodian.id === this.deps.actor.id &&
            perms.includes("finance.petty_cash"),
          canRequestTopUp: active && operator,
          canCount: active && operator && !summary.openCount,
          canEdit: active && perms.includes("finance.manage"),
        },
      },
      schema: floatResponseSchema,
    };
  }
  floats(): Reply {
    const ids = this.readable(PETTY_CASH_READ_PERMISSIONS);
    const floats = this.state.floats
      .filter((float) => ids.includes(float.projectId))
      .map((float) => this.floatSummary(float));
    const sitesWithoutFloat = this.deps.projects
      .filter((project) => ids.includes(project.id))
      .flatMap((project) =>
        project.sites
          .filter((site) => !this.state.floats.some((float) => float.siteId === site.id))
          .map((site) => ({
            project: { id: project.id, code: project.code, name: project.name },
            site,
            canCreate: this.holds(project.id, ["finance.manage"]),
          })),
      );
    return { body: { floats, sitesWithoutFloat }, schema: floatsResponseSchema };
  }
  custodians(query: URLSearchParams): Reply {
    const projectId = query.get("projectId") ?? "";
    this.require(projectId, ["finance.manage"]);
    return {
      body: { people: this.deps.holders(projectId, "finance.petty_cash") },
      schema: custodiansResponseSchema,
    };
  }
  createFloat(body: unknown): Reply {
    const input = this.deps.parse(createFloatRequestSchema, body);
    const project = this.deps.projects.find((entry) =>
      entry.sites.some((site) => site.id === input.siteId),
    );
    if (!project) throw this.deps.fail(404, "not-found");
    this.require(project.id, ["finance.manage"]);
    const custodian = this.deps
      .holders(project.id, "finance.petty_cash")
      .find((person) => person.id === input.custodianUserId);
    if (!custodian) throw this.deps.fail(422, "custodian-not-eligible");
    if (this.state.floats.some((float) => float.siteId === input.siteId))
      throw this.deps.fail(409, "float-exists");
    const float: MockFloat = {
      id: randomUUID(),
      name: input.name,
      projectId: project.id,
      siteId: input.siteId,
      custodian,
      limitMinor: input.limitMinor,
      balanceMinor: 0,
      status: "active",
      version: 1,
    };
    this.state.floats.push(float);
    return this.floatReply(float, 201);
  }
  updateFloat(id: string, body: unknown): Reply {
    const float = this.float(id);
    this.require(float.projectId, ["finance.manage"]);
    const input = this.deps.parse(updateFloatRequestSchema, body);
    if (float.version !== input.version) throw this.deps.fail(409, "version-conflict");
    if (input.custodianUserId && input.custodianUserId !== float.custodian.id) {
      const next = this.deps
        .holders(float.projectId, "finance.petty_cash")
        .find((person) => person.id === input.custodianUserId);
      if (!next) throw this.deps.fail(422, "custodian-not-eligible");
      if (float.balanceMinor !== 0) throw this.deps.fail(409, "handover-needs-count");
      float.custodian = next;
    }
    if (input.limitMinor !== undefined) float.limitMinor = input.limitMinor;
    if (input.name !== undefined) float.name = input.name;
    float.version += 1;
    return this.floatReply(float);
  }
  floatLedger(id: string): Reply {
    const float = this.float(id);
    const entries = this.state.floatEntries
      .filter((entry) => entry.floatId === float.id)
      .reverse()
      .map((entry) => omit(entry, ["floatId"]));
    return { body: { entries, page: page() }, schema: floatLedgerResponseSchema };
  }
  private post(
    float: MockFloat,
    kind: FloatEntry["kind"],
    amountMinor: number,
    document: FloatEntry["document"],
  ) {
    if (float.balanceMinor + amountMinor < 0) throw this.deps.fail(409, "float-insufficient");
    float.balanceMinor += amountMinor;
    this.state.floatEntries.push({
      id: randomUUID(),
      floatId: float.id,
      seq: this.state.floatEntries.filter((entry) => entry.floatId === float.id).length + 1,
      kind,
      amountMinor,
      balanceMinor: float.balanceMinor,
      document,
      recordedBy: this.deps.actor,
      recordedAt: new Date().toISOString(),
      businessDate: nairobiDate(),
    });
  }
  private expenseWire(expense: MockExpense) {
    const float = this.state.floats.find((entry) => entry.id === expense.floatId)!;
    const rest = omit(expense, ["floatId", "key", "digest"]);
    const receipts = this.state.receipts
      .filter((receipt) => receipt.expenseId === expense.id)
      .map((receipt) => this.receiptWire(receipt));
    return {
      ...rest,
      float: { id: float.id, name: float.name },
      project: this.project(float.projectId),
      site: this.site(float.projectId, float.siteId),
      receiptCount: receipts.length,
      receipts,
    };
  }
  private receiptWire(receipt: MockReceipt) {
    return {
      id: receipt.id,
      contentType: receipt.contentType,
      sizeBytes: receipt.content.length,
      scanStatus: "not_scanned" as const,
      uploadedAt: receipt.uploadedAt,
      uploadedBy: receipt.uploadedBy,
    };
  }
  private expenseReply(expense: MockExpense, replayed = false, status = 200): Reply {
    const float = this.state.floats.find((entry) => entry.id === expense.floatId)!;
    const perms = this.perms(float.projectId);
    const independent =
      expense.recordedBy.id !== this.deps.actor.id && float.custodian.id !== this.deps.actor.id;
    const approver = PETTY_CASH_APPROVE_PERMISSIONS.some((permission) =>
      perms.includes(permission),
    );
    const submitted = expense.status === "submitted";
    const wire = this.expenseWire(expense);
    return {
      status,
      body: {
        expense: wire,
        replayed,
        permissions: {
          canApprove: approver && submitted && independent && wire.receiptCount > 0,
          canReject: approver && submitted && independent,
          canAddReceipt:
            expense.status !== "rejected" &&
            wire.receiptCount < 3 &&
            (expense.recordedBy.id === this.deps.actor.id || perms.includes("finance.manage")),
        },
      },
      schema: expenseResponseSchema,
    };
  }
  private expense(id: string) {
    const expense = this.state.expenses.find((entry) => entry.id === id);
    if (!expense) throw this.deps.fail(404, "not-found");
    this.float(expense.floatId);
    return expense;
  }
  expenses(query: URLSearchParams): Reply {
    const ids = this.readable(PETTY_CASH_READ_PERMISSIONS);
    const rows = this.state.expenses
      .filter((expense) =>
        ids.includes(this.state.floats.find((float) => float.id === expense.floatId)!.projectId),
      )
      .filter((expense) => !query.get("floatId") || expense.floatId === query.get("floatId"))
      .filter((expense) => !query.get("status") || expense.status === query.get("status"))
      .slice()
      .reverse()
      .map((expense) => omit(this.expenseWire(expense), ["receipts"]));
    return { body: { expenses: rows, page: page() }, schema: expensesResponseSchema };
  }
  expenseDetail(id: string): Reply {
    return this.expenseReply(this.expense(id));
  }
  recordExpense(body: unknown): Reply {
    const key = this.deps.idempotencyKey;
    if (!key || key.length < 8) throw this.deps.fail(400, "idempotency-key-required");
    const input = this.deps.parse(createExpenseRequestSchema, body);
    const digest = sha(input);
    const replay = this.state.expenses.find((expense) => expense.key === key);
    if (replay) {
      if (replay.digest !== digest || replay.id !== input.id)
        throw this.deps.fail(409, "idempotency-key-reused");
      return this.expenseReply(replay, true, 201);
    }
    if (this.state.expenses.some((expense) => expense.id === input.id))
      throw this.deps.fail(409, "expense-id-conflict");
    const float = this.float(input.floatId);
    if (float.status !== "active") throw this.deps.fail(409, "float-closed");
    if (
      float.custodian.id !== this.deps.actor.id ||
      !this.perms(float.projectId).includes("finance.petty_cash")
    )
      throw this.deps.fail(403, "not-custodian");
    const today = nairobiDate();
    if (input.spentOn > today || input.spentOn < addCalendarDays(today, -90))
      throw this.deps.fail(400, "expense-date-invalid");
    if (
      input.mpesaCode &&
      this.state.expenses.some(
        (expense) => expense.mpesaCode === input.mpesaCode && expense.status !== "rejected",
      )
    )
      throw this.deps.fail(409, "mpesa-code-duplicate");
    if (input.amountMinor + input.chargeMinor > float.balanceMinor)
      throw this.deps.fail(409, "float-insufficient");
    const expense: MockExpense = {
      id: input.id,
      number: this.next("expense", "EXP"),
      floatId: float.id,
      spentOn: input.spentOn,
      amountMinor: input.amountMinor,
      chargeMinor: input.chargeMinor,
      category: input.category,
      costCode: this.costCodeRef(input.costCodeId),
      bqItem: item(input.bqItemLineageId ?? null),
      counterpartyKind: input.counterpartyKind,
      supplier: null,
      payeeName: input.payeeName,
      payeeAccount: input.payeeAccount ?? null,
      payeePhoneMasked: input.payeePhoneMasked ?? null,
      paymentMethod: input.paymentMethod,
      mpesaCode: input.mpesaCode ?? null,
      parsedFromSms: input.parsedFromSms,
      smsKind: input.smsKind ?? null,
      description: input.description,
      status: "submitted",
      source: input.source,
      capturedAt: input.capturedAt,
      recordedAt: new Date().toISOString(),
      recordedBy: this.deps.actor,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      version: 1,
      key,
      digest,
    };
    this.post(float, "expense", -(input.amountMinor + input.chargeMinor), {
      kind: "expense",
      id: expense.id,
      number: expense.number,
    });
    this.state.expenses.push(expense);
    return this.expenseReply(expense, false, 201);
  }
  addReceipt(id: string): Reply {
    const expense = this.expense(id);
    const float = this.state.floats.find((entry) => entry.id === expense.floatId)!;
    if (
      expense.recordedBy.id !== this.deps.actor.id &&
      !this.perms(float.projectId).includes("finance.manage")
    )
      throw this.deps.fail(403, "forbidden");
    if (expense.status === "rejected") throw this.deps.fail(409, "invalid-transition");
    if (this.state.receipts.filter((receipt) => receipt.expenseId === id).length >= 3)
      throw this.deps.fail(409, "too-many-receipts");
    const file = multipartFile(this.deps.raw, this.deps.contentType);
    if (!file) throw this.deps.fail(400, "file-required");
    const contentType = sniffImage(file);
    if (!contentType) throw this.deps.fail(415, "unsupported-file-type");
    const receipt: MockReceipt = {
      id: randomUUID(),
      expenseId: id,
      content: file,
      contentType,
      uploadedAt: new Date().toISOString(),
      uploadedBy: this.deps.actor,
    };
    this.state.receipts.push(receipt);
    return {
      status: 201,
      body: { receipt: this.receiptWire(receipt) },
      schema: receiptResponseSchema,
    };
  }
  decideExpense(id: string, action: "approve" | "reject", body: unknown): Reply {
    const expense = this.expense(id);
    const float = this.state.floats.find((entry) => entry.id === expense.floatId)!;
    const input =
      action === "approve"
        ? this.deps.parse(versionBodySchema, body)
        : this.deps.parse(reasonBodySchema, body);
    if (
      !PETTY_CASH_APPROVE_PERMISSIONS.some((permission) =>
        this.perms(float.projectId).includes(permission),
      )
    )
      throw this.deps.fail(403, "forbidden");
    if (expense.recordedBy.id === this.deps.actor.id || float.custodian.id === this.deps.actor.id)
      throw this.deps.fail(403, "maker-checker");
    if (expense.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
    if (expense.version !== input.version) throw this.deps.fail(409, "version-conflict");
    if (action === "approve") {
      if (!this.state.receipts.some((receipt) => receipt.expenseId === id))
        throw this.deps.fail(409, "receipt-required");
      for (const [measure, purpose] of [
        ["accrued", "accrual"],
        ["paid", "payment"],
      ] as const)
        this.state.entries.push({
          id: randomUUID(),
          project: this.project(float.projectId),
          site: this.site(float.projectId, float.siteId),
          measure,
          category: expense.category,
          costCode: expense.costCode,
          bqItem: expense.bqItem,
          counterpartyKind: expense.counterpartyKind,
          supplier: null,
          counterpartyName: expense.payeeName,
          paymentReference: expense.mpesaCode,
          amountMinor: expense.amountMinor,
          occurredOn: expense.spentOn,
          source: "petty_cash_expense",
          purpose,
          document: { kind: "petty_cash_expense", id: expense.id, label: expense.number },
          reversesEntryId: null,
          reversedByEntryId: null,
          recordedBy: this.deps.actor,
          recordedAt: new Date().toISOString(),
          businessDate: nairobiDate(),
        });
    } else {
      this.post(float, "expense_rejected", expense.amountMinor + expense.chargeMinor, {
        kind: "expense",
        id: expense.id,
        number: expense.number,
      });
    }
    Object.assign(expense, {
      status: action === "approve" ? "approved" : "rejected",
      decidedBy: this.deps.actor,
      decidedAt: new Date().toISOString(),
      decisionReason: "reason" in input ? input.reason : null,
      version: expense.version + 1,
    });
    return this.expenseReply(expense);
  }
  parseSms(body: unknown): Reply {
    if (!this.readable(PETTY_CASH_READ_PERMISSIONS).length) throw this.deps.fail(403, "forbidden");
    const input = this.deps.parse(smsParseRequestSchema, body);
    const result = parseMpesaSms(input.text);
    const duplicates = result.ok
      ? this.state.expenses
          .filter((expense) => expense.mpesaCode === result.draft.code)
          .map((expense) => ({
            kind: "expense" as const,
            id: expense.id,
            label: expense.number,
            status: expense.status,
          }))
      : [];
    return {
      body: { result, duplicates, confirmsSettlement: false },
      schema: smsParseResponseSchema,
    };
  }
  private topUpWire(topUp: MockTopUp): TopUp {
    const float = this.state.floats.find((entry) => entry.id === topUp.floatId)!;
    const perms = this.perms(topUp.projectId);
    const actor = this.deps.actor.id;
    const custodian = float.custodian.id === actor;
    const rest = omit(topUp, ["floatId", "projectId"]);
    return {
      ...rest,
      float: { id: float.id, name: float.name },
      project: this.project(topUp.projectId),
      permissions: {
        canApprove:
          topUp.status === "requested" &&
          perms.includes("payments.approve") &&
          topUp.requestedBy.id !== actor &&
          !custodian,
        canReject:
          topUp.status === "requested" &&
          perms.includes("payments.approve") &&
          topUp.requestedBy.id !== actor &&
          !custodian,
        canPay:
          topUp.status === "approved" &&
          perms.includes("payments.disburse") &&
          topUp.decidedBy?.id !== actor &&
          topUp.requestedBy.id !== actor &&
          !custodian,
        canCancel:
          (topUp.status === "requested" || topUp.status === "approved") &&
          (topUp.requestedBy.id === actor || perms.includes("finance.manage")),
      },
    };
  }
  topUps(query: URLSearchParams): Reply {
    const ids = this.readable(PETTY_CASH_READ_PERMISSIONS);
    const rows = this.state.topUps
      .filter((topUp) => ids.includes(topUp.projectId))
      .filter((topUp) => !query.get("floatId") || topUp.floatId === query.get("floatId"))
      .slice()
      .reverse()
      .map((topUp) => this.topUpWire(topUp));
    return { body: { topUps: rows, page: page() }, schema: topUpsResponseSchema };
  }
  requestTopUp(body: unknown): Reply {
    const input = this.deps.parse(createTopUpRequestSchema, body);
    const float = this.float(input.floatId);
    if (!this.operator(float)) throw this.deps.fail(403, "forbidden");
    if (input.amountMinor + float.balanceMinor > float.limitMinor)
      throw this.deps.fail(409, "float-limit-exceeded");
    const topUp: MockTopUp = {
      id: randomUUID(),
      number: this.next("topUp", "TOP"),
      floatId: float.id,
      projectId: float.projectId,
      amountMinor: input.amountMinor,
      reason: input.reason,
      status: "requested",
      requestedBy: this.deps.actor,
      requestedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      paidBy: null,
      paidAt: null,
      paidOn: null,
      method: null,
      reference: null,
      cancelledBy: null,
      cancelReason: null,
      version: 1,
    };
    this.state.topUps.push(topUp);
    return { status: 201, body: { topUp: this.topUpWire(topUp) }, schema: topUpResponseSchema };
  }
  decideTopUp(id: string, action: "approve" | "reject" | "pay" | "cancel", body: unknown): Reply {
    const topUp = this.state.topUps.find((entry) => entry.id === id);
    if (!topUp) throw this.deps.fail(404, "not-found");
    const float = this.float(topUp.floatId);
    const perms = this.perms(topUp.projectId);
    const now = new Date().toISOString();
    if (action === "approve" || action === "reject") {
      const input =
        action === "approve"
          ? this.deps.parse(versionBodySchema, body)
          : this.deps.parse(reasonBodySchema, body);
      if (!perms.includes("payments.approve")) throw this.deps.fail(403, "forbidden");
      if (topUp.requestedBy.id === this.deps.actor.id || float.custodian.id === this.deps.actor.id)
        throw this.deps.fail(403, "maker-checker");
      if (topUp.status !== "requested") throw this.deps.fail(409, "invalid-transition");
      if (topUp.version !== input.version) throw this.deps.fail(409, "version-conflict");
      if (action === "approve") this.deps.requireStepUp();
      Object.assign(topUp, {
        status: action === "approve" ? "approved" : "rejected",
        decidedBy: this.deps.actor,
        decidedAt: now,
        decisionReason: "reason" in input ? input.reason : null,
      });
    } else if (action === "pay") {
      const input = this.deps.parse(payTopUpRequestSchema, body);
      if (!perms.includes("payments.disburse")) throw this.deps.fail(403, "forbidden");
      if (
        topUp.decidedBy?.id === this.deps.actor.id ||
        topUp.requestedBy.id === this.deps.actor.id ||
        float.custodian.id === this.deps.actor.id
      )
        throw this.deps.fail(403, "maker-checker");
      if (topUp.status !== "approved") throw this.deps.fail(409, "invalid-transition");
      if (topUp.version !== input.version) throw this.deps.fail(409, "version-conflict");
      this.deps.requireStepUp();
      if (input.paidOn > nairobiDate()) throw this.deps.fail(400, "top-up-date-invalid");
      if (topUp.amountMinor + float.balanceMinor > float.limitMinor)
        throw this.deps.fail(409, "float-limit-exceeded");
      this.post(float, "top_up", topUp.amountMinor, {
        kind: "top_up",
        id: topUp.id,
        number: topUp.number,
      });
      Object.assign(topUp, {
        status: "paid",
        paidBy: this.deps.actor,
        paidAt: now,
        paidOn: input.paidOn,
        method: input.method,
        reference: input.reference,
      });
    } else {
      const input = this.deps.parse(reasonBodySchema, body);
      if (topUp.requestedBy.id !== this.deps.actor.id && !perms.includes("finance.manage"))
        throw this.deps.fail(403, "forbidden");
      if (topUp.status !== "requested" && topUp.status !== "approved")
        throw this.deps.fail(409, "invalid-transition");
      if (topUp.version !== input.version) throw this.deps.fail(409, "version-conflict");
      Object.assign(topUp, {
        status: "cancelled",
        cancelledBy: this.deps.actor,
        cancelReason: input.reason,
      });
    }
    topUp.version += 1;
    return { body: { topUp: this.topUpWire(topUp) }, schema: topUpResponseSchema };
  }
  private countWire(count: MockCount): Count {
    const float = this.state.floats.find((entry) => entry.id === count.floatId)!;
    const perms = this.perms(count.projectId);
    const decider =
      count.status === "submitted" &&
      PETTY_CASH_APPROVE_PERMISSIONS.some((permission) => perms.includes(permission)) &&
      count.countedBy.id !== this.deps.actor.id &&
      float.custodian.id !== this.deps.actor.id;
    const rest = omit(count, ["floatId", "projectId"]);
    return {
      ...rest,
      float: { id: float.id, name: float.name },
      project: this.project(count.projectId),
      permissions: { canApprove: decider, canReturn: decider },
    };
  }
  counts(query: URLSearchParams): Reply {
    const ids = this.readable(PETTY_CASH_READ_PERMISSIONS);
    const rows = this.state.counts
      .filter((count) => ids.includes(count.projectId))
      .filter((count) => !query.get("floatId") || count.floatId === query.get("floatId"))
      .slice()
      .reverse()
      .map((count) => this.countWire(count));
    return { body: { counts: rows, page: page() }, schema: countsResponseSchema };
  }
  recordCount(body: unknown): Reply {
    const input = this.deps.parse(createCountRequestSchema, body);
    const float = this.float(input.floatId);
    if (!this.operator(float)) throw this.deps.fail(403, "forbidden");
    if (
      this.state.counts.some((count) => count.floatId === float.id && count.status === "submitted")
    )
      throw this.deps.fail(409, "count-open");
    const count: MockCount = {
      id: randomUUID(),
      number: this.next("count", "CNT"),
      floatId: float.id,
      projectId: float.projectId,
      countedMinor: input.countedMinor,
      bookMinor: float.balanceMinor,
      varianceMinor: input.countedMinor - float.balanceMinor,
      note: input.note ?? null,
      status: "submitted",
      countedBy: this.deps.actor,
      countedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      version: 1,
    };
    this.state.counts.push(count);
    return { status: 201, body: { count: this.countWire(count) }, schema: countResponseSchema };
  }
  decideCount(id: string, action: "approve" | "return", body: unknown): Reply {
    const count = this.state.counts.find((entry) => entry.id === id);
    if (!count) throw this.deps.fail(404, "not-found");
    const float = this.float(count.floatId);
    const input =
      action === "approve"
        ? this.deps.parse(versionBodySchema, body)
        : this.deps.parse(reasonBodySchema, body);
    if (!this.countWire(count).permissions.canApprove) {
      if (count.status !== "submitted") throw this.deps.fail(409, "invalid-transition");
      throw this.deps.fail(403, "maker-checker");
    }
    if (count.version !== input.version) throw this.deps.fail(409, "version-conflict");
    if (action === "approve" && count.varianceMinor !== 0) {
      this.post(float, "count_adjustment", count.varianceMinor, {
        kind: "count",
        id: count.id,
        number: count.number,
      });
      for (const [measure, purpose] of [
        ["accrued", "variance_accrual"],
        ["paid", "variance_payment"],
      ] as const)
        this.state.entries.push({
          id: randomUUID(),
          project: this.project(float.projectId),
          site: this.site(float.projectId, float.siteId),
          measure,
          category: "petty_cash",
          costCode: null,
          bqItem: null,
          counterpartyKind: "none",
          supplier: null,
          counterpartyName: null,
          paymentReference: null,
          amountMinor: -count.varianceMinor,
          occurredOn: nairobiDate(),
          source: "petty_cash_count",
          purpose,
          document: { kind: "petty_cash_count", id: count.id, label: count.number },
          reversesEntryId: null,
          reversedByEntryId: null,
          recordedBy: this.deps.actor,
          recordedAt: new Date().toISOString(),
          businessDate: nairobiDate(),
        });
    }
    Object.assign(count, {
      status: action === "approve" ? "approved" : "returned",
      decidedBy: this.deps.actor,
      decidedAt: new Date().toISOString(),
      decisionReason: "reason" in input ? input.reason : null,
      version: count.version + 1,
    });
    return { body: { count: this.countWire(count) }, schema: countResponseSchema };
  }

  // Cash flow and alerts ---------------------------------------------------------------------------

  private itemWire(row: MockItem): CashFlowItem {
    const { projectId, ...rest } = row;
    return {
      ...rest,
      project: this.project(projectId),
      permissions: {
        canEdit: this.holds(projectId, ["finance.manage"]) && row.status === "expected",
      },
    };
  }
  cashFlowItems(query: URLSearchParams): Reply {
    const ids = this.readable(SPENDING_READ_PERMISSIONS);
    const rows = this.state.items
      .filter((row) => ids.includes(row.projectId))
      .filter((row) => !query.get("projectId") || row.projectId === query.get("projectId"))
      .filter((row) => !query.get("status") || row.status === query.get("status"))
      .map((row) => this.itemWire(row));
    return { body: { items: rows, page: page() }, schema: cashFlowItemsResponseSchema };
  }
  createItem(body: unknown): Reply {
    const input = this.deps.parse(createCashFlowItemRequestSchema, body);
    this.require(input.projectId, ["finance.manage"]);
    const row: MockItem = {
      id: randomUUID(),
      projectId: input.projectId,
      direction: input.direction,
      description: input.description,
      expectedOn: input.expectedOn,
      amountMinor: input.amountMinor,
      status: "expected",
      receivedOn: null,
      receivedMinor: null,
      reference: input.reference ?? null,
      createdBy: this.deps.actor,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    this.state.items.push(row);
    return { status: 201, body: { item: this.itemWire(row) }, schema: cashFlowItemResponseSchema };
  }
  decideItem(id: string, action: "receive" | "cancel", body: unknown): Reply {
    const row = this.state.items.find((entry) => entry.id === id);
    if (!row) throw this.deps.fail(404, "not-found");
    this.require(row.projectId, ["finance.manage"]);
    if (row.status !== "expected") throw this.deps.fail(409, "invalid-transition");
    if (action === "receive") {
      const input = this.deps.parse(receiveCashFlowItemRequestSchema, body);
      if (row.version !== input.version) throw this.deps.fail(409, "version-conflict");
      if (input.receivedOn > nairobiDate()) throw this.deps.fail(400, "received-date-invalid");
      Object.assign(row, {
        status: "received",
        receivedOn: input.receivedOn,
        receivedMinor: input.receivedMinor,
        reference: input.reference ?? row.reference,
      });
    } else {
      const input = this.deps.parse(versionBodySchema, body);
      if (row.version !== input.version) throw this.deps.fail(409, "version-conflict");
      row.status = "cancelled";
    }
    row.version += 1;
    return { body: { item: this.itemWire(row) }, schema: cashFlowItemResponseSchema };
  }
  forecast(query: URLSearchParams): Reply {
    const projectId = query.get("projectId");
    const today = nairobiDate();
    let ids: string[];
    let project = null;
    if (projectId) {
      project = this.require(projectId, SPENDING_READ_PERMISSIONS);
      ids = [projectId];
    } else {
      if (!this.company(SPENDING_READ_PERMISSIONS)) throw this.deps.fail(403, "forbidden");
      ids = this.deps.projects.map((entry) => entry.id);
    }
    const lines: {
      item: ForecastItem;
      project: { id: string; code: string; name: string };
      document: {
        kind: "lpo" | "top_up" | "cash_flow_item" | "pay_period";
        id: string | null;
        label: string;
      };
    }[] = [];
    for (const row of this.state.items.filter(
      (entry) => ids.includes(entry.projectId) && entry.status === "expected",
    ))
      lines.push({
        item: {
          kind: row.direction === "in" ? "client_receipts" : "other_payments",
          direction: row.direction,
          date: row.expectedOn,
          amountMinor: row.amountMinor,
          basis: "recorded",
        },
        project: this.project(row.projectId),
        document: { kind: "cash_flow_item", id: row.id, label: row.description },
      });
    for (const topUp of this.state.topUps.filter(
      (entry) =>
        ids.includes(entry.projectId) &&
        (entry.status === "requested" || entry.status === "approved"),
    ))
      lines.push({
        item: {
          kind: "petty_cash_top_ups",
          direction: "out",
          date: today,
          amountMinor: topUp.amountMinor,
          basis: "recorded",
        },
        project: this.project(topUp.projectId),
        document: { kind: "top_up", id: topUp.id, label: topUp.number },
      });
    if (ids.includes(RUIRU_ID)) {
      lines.push({
        item: {
          kind: "lpo_commitments",
          direction: "out",
          date: addCalendarDays(today, 20),
          amountMinor: Math.round((this.state.committedMinor * 116) / 100),
          basis: "estimated",
        },
        project: this.project(RUIRU_ID),
        document: { kind: "lpo", id: "77100000-0000-4000-8000-000000000001", label: "LPO-0002" },
      });
      lines.push({
        item: {
          kind: "payroll",
          direction: "out",
          date: addCalendarDays(today, 4),
          amountMinor: 46_850_000,
          basis: "estimated",
        },
        project: this.project(RUIRU_ID),
        document: { kind: "pay_period", id: null, label: "Week pay (synthetic)" },
      });
    }
    lines.sort((a, b) => (a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : 0));
    const paidSince = this.state.topUps
      .filter((entry) => ids.includes(entry.projectId) && entry.status === "paid")
      .reduce((total, entry) => total + entry.amountMinor, 0);
    const receivedSince = this.state.items
      .filter((entry) => ids.includes(entry.projectId) && entry.status === "received")
      .reduce((total, entry) => total + (entry.receivedMinor ?? 0), 0);
    const entered = this.state.settings.openingCashMinor;
    const opening = projectId
      ? {
          basis: "derived" as const,
          amountMinor: receivedSince - paidSince,
          enteredMinor: null,
          enteredOn: null,
          receivedSinceMinor: receivedSince,
          paidSinceMinor: paidSince,
        }
      : entered === null
        ? {
            basis: "none" as const,
            amountMinor: null,
            enteredMinor: null,
            enteredOn: null,
            receivedSinceMinor: receivedSince,
            paidSinceMinor: paidSince,
          }
        : {
            basis: "entered" as const,
            amountMinor: entered + receivedSince - paidSince,
            enteredMinor: entered,
            enteredOn: this.state.settings.openingCashOn,
            receivedSinceMinor: receivedSince,
            paidSinceMinor: paidSince,
          };
    const buckets = bucketForecast(
      lines.map((line) => line.item),
      today,
      this.state.settings.forecastWeeks,
      opening.amountMinor,
    );
    const firstWeek = buckets.weeks[0]!.start;
    return {
      body: {
        scope: projectId ? "project" : "company",
        project,
        today,
        opening,
        weeks: buckets.weeks,
        later: buckets.later,
        lines: lines.map((line) => ({
          ...line.item,
          overdue: line.item.date < firstWeek,
          project: line.project,
          document: line.document,
        })),
        linesTruncated: false,
      },
      schema: forecastResponseSchema,
    };
  }
  alerts(query: URLSearchParams): Reply {
    const projectId = query.get("projectId");
    if (projectId) this.require(projectId, SPENDING_READ_PERMISSIONS);
    const ids = this.readable(SPENDING_READ_PERMISSIONS).filter(
      (id) => !projectId || id === projectId,
    );
    const settings = this.state.settings;
    const today = nairobiDate();
    const alerts: SpendAlert[] = [];
    const base = (
      kind: SpendAlertKind,
      projectRef: { id: string; code: string; name: string },
    ) => ({
      kind,
      project: projectRef,
      detectedOn: today,
      amountMinor: null,
      scope: null,
      figures: null,
      typical: null,
      rule: null,
      records: [],
    });
    for (const id of ids) {
      const facts = this.projectFacts(id);
      const projectRef = this.project(id);
      const rows = [
        { scope: { kind: "project" as const, category: null, bill: null }, row: facts.totals },
        ...facts.categories.map((row) => ({
          scope: { kind: "category" as const, category: row.category, bill: null },
          row,
        })),
      ];
      for (const { scope, row } of rows)
        if (
          (row.level === "threshold" || row.level === "over") &&
          row.budgetMinor !== null &&
          row.usedPercent !== null
        )
          alerts.push({
            ...base("budget_threshold", projectRef),
            id: `budget_threshold:${id}:${scope.kind}:${scope.category ?? ""}`,
            severity: row.level === "over" ? "critical" : "warning",
            amountMinor: row.forecastMinor,
            scope,
            figures: {
              usedMinor: row.forecastMinor,
              budgetMinor: row.budgetMinor,
              usedPercent: row.usedPercent,
              thresholdPercent: settings.budgetAlertPercent,
            },
          });
    }
    const expenses = this.state.expenses.filter((expense) => {
      const float = this.state.floats.find((entry) => entry.id === expense.floatId)!;
      return ids.includes(float.projectId) && expense.status !== "rejected";
    });
    const projectOf = (expense: MockExpense) =>
      this.project(this.state.floats.find((entry) => entry.id === expense.floatId)!.projectId);
    const record = (expense: MockExpense) => ({
      kind: "expense" as const,
      id: expense.id,
      label: expense.number,
      date: expense.spentOn,
      amountMinor: expense.amountMinor,
    });
    for (const [index, expense] of expenses.entries()) {
      const earlier = expenses
        .slice(0, index)
        .filter((entry) => entry.floatId === expense.floatId)
        .slice(-20)
        .map((entry) => entry.amountMinor);
      const result = unusualSpend(
        expense.amountMinor,
        earlier,
        settings.unusualSpendMultiplier,
        settings.unusualSpendMinSamples,
      );
      if (result.unusual && result.medianMinor)
        alerts.push({
          ...base("unusual_spend", projectOf(expense)),
          id: `unusual_spend:${expense.id}`,
          severity: "warning",
          amountMinor: expense.amountMinor,
          detectedOn: expense.spentOn,
          typical: {
            medianMinor: result.medianMinor,
            multiplier: settings.unusualSpendMultiplier,
            samples: result.samples,
          },
          records: [record(expense)],
        });
    }
    const facts: PaymentFact[] = expenses.map((expense) => ({
      id: expense.id,
      source: "expense",
      projectId: this.state.floats.find((entry) => entry.id === expense.floatId)!.projectId,
      counterparty: counterpartyKey({ name: expense.payeeName, account: expense.payeeAccount }),
      amountMinor: expense.amountMinor,
      date: expense.spentOn,
      reference: expense.mpesaCode,
      recordedAt: expense.recordedAt,
    }));
    for (const pair of duplicatePayments(facts, settings.duplicateWindowDays)) {
      const first = expenses.find((expense) => expense.id === pair.first.id)!;
      const second = expenses.find((expense) => expense.id === pair.second.id)!;
      alerts.push({
        ...base("duplicate_payment", projectOf(second)),
        id: `duplicate_payment:${first.id}:${second.id}`,
        severity: pair.rule === "same_reference" ? "critical" : "warning",
        amountMinor: second.amountMinor,
        detectedOn: second.spentOn,
        rule: pair.rule,
        records: [record(first), record(second)],
      });
    }
    for (const expense of expenses.filter(
      (entry) => !this.state.receipts.some((receipt) => receipt.expenseId === entry.id),
    ))
      alerts.push({
        ...base("missing_documents", projectOf(expense)),
        id: `missing_documents:${expense.id}`,
        severity: "warning",
        amountMinor: expense.amountMinor + expense.chargeMinor,
        detectedOn: expense.spentOn,
        records: [record(expense)],
      });
    const counts = Object.fromEntries(
      SPEND_ALERT_KINDS.map((kind) => [kind, alerts.filter((alert) => alert.kind === kind).length]),
    );
    const kind = query.get("kind");
    const shown = alerts.filter((alert) => !kind || alert.kind === kind);
    return { body: { alerts: shown, counts, page: page() }, schema: spendAlertsResponseSchema };
  }
}

/** The first file part of a multipart body (the mock reads the raw request). */
function multipartFile(raw: Buffer, contentType: string | undefined): Buffer | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!marker) return null;
  const delimiter = Buffer.from(`--${marker}`);
  let start = raw.indexOf(delimiter);
  while (start !== -1) {
    const next = raw.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = raw.subarray(start + delimiter.length, next);
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1 && /name="file"/.test(part.subarray(0, split).toString("latin1"))) {
      const body = part.subarray(split + 4, part.length - 2);
      return body.length ? body : null;
    }
    start = next;
  }
  return null;
}

function sniffImage(content: Buffer): MockReceipt["contentType"] | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff)
    return "image/jpeg";
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

/** A stored receipt for the download route (bytes and content type), if the caller may see it. */
export function spendingReceipt(state: SpendingState, id: string) {
  return state.receipts.find((receipt) => receipt.id === id) ?? null;
}

export function handleSpending(
  deps: SpendingDeps,
  state: SpendingState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  const spending = new Spending(deps, state);
  if (path === "/spending/summary" && method === "GET") return spending.summary();
  if (path === "/spending/settings") {
    if (method === "GET") return spending.settings();
    if (method === "PUT") return spending.updateSettings(body);
    return null;
  }
  if (path === "/spending/ledger" && method === "GET") return spending.ledger(query);
  if (path === "/spending/forecast" && method === "GET") return spending.forecast(query);
  if (path === "/spending/alerts" && method === "GET") return spending.alerts(query);
  const project = /^\/spending\/projects\/([^/]+)(?:\/(bq-items)|\/bills\/([^/]+)\/items)?$/.exec(
    path,
  );
  if (project && method === "GET") {
    const [, projectId, bqItems, billId] = project;
    if (bqItems) return spending.bqItems(projectId!, query);
    if (billId) return spending.billItems(projectId!, billId, query);
    return spending.projectSpending(projectId!);
  }
  if (path === "/cost-codes") {
    if (method === "GET") return spending.costCodes(query);
    if (method === "POST") return spending.createCostCode(body);
    return null;
  }
  if (path === "/cost-codes/defaults" && method === "POST") return spending.loadDefaults();
  const costCode = /^\/cost-codes\/([^/]+)$/.exec(path);
  if (costCode && method === "PATCH") return spending.updateCostCode(costCode[1]!, body);
  if (path === "/budgets") {
    if (method === "GET") return spending.budgets(query);
    if (method === "POST") return spending.createBudget(body);
    return null;
  }
  const budget =
    /^\/budgets\/([^/]+)(?:\/(lines|submit|approve|return|cancel)(?:\/([^/]+))?)?$/.exec(path);
  if (budget) {
    const [, budgetId, sub, lineId] = budget;
    if (!sub && method === "GET") return spending.budgetDetailReply(budgetId!);
    if (sub === "lines" && !lineId && method === "GET")
      return spending.budgetLines(budgetId!, query);
    if (sub === "lines" && !lineId && method === "POST") return spending.addLine(budgetId!, body);
    if (sub === "lines" && lineId && method === "PATCH")
      return spending.updateLine(budgetId!, lineId, body);
    if (sub === "lines" && lineId && method === "DELETE")
      return spending.removeLine(budgetId!, lineId, query);
    if (sub && sub !== "lines" && method === "POST")
      return spending.decideBudget(
        budgetId!,
        sub as "submit" | "approve" | "return" | "cancel",
        body,
      );
    return null;
  }
  if (path === "/cost-journals") {
    if (method === "GET") return spending.journals(query);
    if (method === "POST") return spending.createJournal(body);
    return null;
  }
  if (path === "/cost-journals/reversal" && method === "POST") return spending.reverse(body);
  const journal = /^\/cost-journals\/([^/]+)(?:\/(approve|reject))?$/.exec(path);
  if (journal) {
    if (!journal[2] && method === "GET") return spending.journal(journal[1]!);
    if (journal[2] && method === "POST")
      return spending.decideJournal(journal[1]!, journal[2] as "approve" | "reject", body);
    return null;
  }
  if (path === "/petty-cash/floats") {
    if (method === "GET") return spending.floats();
    if (method === "POST") return spending.createFloat(body);
    return null;
  }
  if (path === "/petty-cash/floats/custodians" && method === "GET")
    return spending.custodians(query);
  const float = /^\/petty-cash\/floats\/([^/]+)(\/ledger)?$/.exec(path);
  if (float) {
    if (float[2] && method === "GET") return spending.floatLedger(float[1]!);
    if (!float[2] && method === "GET") return spending.floatReply(spending.float(float[1]!));
    if (!float[2] && method === "PATCH") return spending.updateFloat(float[1]!, body);
    return null;
  }
  if (path === "/petty-cash/sms/parse" && method === "POST") return spending.parseSms(body);
  if (path === "/petty-cash/expenses") {
    if (method === "GET") return spending.expenses(query);
    if (method === "POST") return spending.recordExpense(body);
    return null;
  }
  const expense = /^\/petty-cash\/expenses\/([^/]+)(?:\/(receipts|approve|reject))?$/.exec(path);
  if (expense) {
    const [, expenseId, sub] = expense;
    if (!sub && method === "GET") return spending.expenseDetail(expenseId!);
    if (sub === "receipts" && method === "POST") return spending.addReceipt(expenseId!);
    if ((sub === "approve" || sub === "reject") && method === "POST")
      return spending.decideExpense(expenseId!, sub, body);
    return null;
  }
  if (path === "/petty-cash/top-ups") {
    if (method === "GET") return spending.topUps(query);
    if (method === "POST") return spending.requestTopUp(body);
    return null;
  }
  const topUp = /^\/petty-cash\/top-ups\/([^/]+)\/(approve|reject|pay|cancel)$/.exec(path);
  if (topUp && method === "POST")
    return spending.decideTopUp(
      topUp[1]!,
      topUp[2] as "approve" | "reject" | "pay" | "cancel",
      body,
    );
  if (path === "/petty-cash/counts") {
    if (method === "GET") return spending.counts(query);
    if (method === "POST") return spending.recordCount(body);
    return null;
  }
  const count = /^\/petty-cash\/counts\/([^/]+)\/(approve|return)$/.exec(path);
  if (count && method === "POST")
    return spending.decideCount(count[1]!, count[2] as "approve" | "return", body);
  if (path === "/cash-flow-items") {
    if (method === "GET") return spending.cashFlowItems(query);
    if (method === "POST") return spending.createItem(body);
    return null;
  }
  const flowItem = /^\/cash-flow-items\/([^/]+)\/(receive|cancel)$/.exec(path);
  if (flowItem && method === "POST")
    return spending.decideItem(flowItem[1]!, flowItem[2] as "receive" | "cancel", body);
  return null;
}
