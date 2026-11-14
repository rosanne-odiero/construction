import { randomUUID } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import type { Request } from "express";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import type { SpendAlertKind } from "@pm-buddy/types";
import {
  createCashFlowItemRequestSchema,
  createExpenseRequestSchema,
  createJournalRequestSchema,
  updateSpendingSettingsRequestSchema,
} from "@pm-buddy/validation";
import { PrismaService } from "../infra/prisma.service.js";
import { BudgetsService } from "../modules/finance/budgets.service.js";
import { CashFlowService } from "../modules/finance/cash-flow.service.js";
import { CostCodesService } from "../modules/finance/cost-codes.service.js";
import { CostLedgerService } from "../modules/finance/cost-ledger.service.js";
import { ExpensesService } from "../modules/finance/expenses.service.js";
import { PettyCashService } from "../modules/finance/petty-cash.service.js";
import { SpendAlertsService } from "../modules/finance/spend-alerts.service.js";
import { approvedBqVersion } from "../modules/finance/spending-common.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { seedPrincipal } from "./demo-procure-to-pay.js";

/**
 * D5.4 demo data (synthetic): company cost codes and spending settings (an entered opening cash
 * position), an approved Ruiru Heights budget (the BQ items plus cost-code lines, prepared by the
 * project manager and approved by finance on the digest), a petty-cash float on the main site held
 * by the site agent (one top-up maker-checked and paid, another waiting), six expenses — one filled
 * from a pasted M-Pesa SMS — with receipts, approvals, an approved count with a small shortage, a
 * maker-checked cost journal and expected client receipts for the forecast. The cost ledger also
 * holds the D5.2 invoice and its settlement (posted by the database). The data is arranged so each
 * alert kind shows: petty cash passes 80 % of its budget, a repeat payment to the same shop, an
 * expense far above the site's usual amount and expenses without receipts. Every step goes through
 * the real services and database triggers.
 */
const FLOAT_NAME = "Ruiru Heights main yard float (demo)";

export type SpendingSeedSummary = {
  created: boolean;
  budget: string;
  float: string;
  expenses: string[];
  topUps: string[];
  count: string;
  journal: string;
  alerts: Partial<Record<SpendAlertKind, number>>;
};

type SeedUsers = {
  ownerId: string;
  projectManagerId: string;
  siteAgentId: string;
  financeId: string;
};

const seedRequest = { headers: {} } as Request;
/** A 1 × 1 PNG standing in for a receipt photo (synthetic). */
const RECEIPT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export async function seedSpending(
  app: INestApplicationContext,
  tenantId: string,
  users: SeedUsers,
): Promise<SpendingSeedSummary> {
  const prisma = app.get(PrismaService);
  const db = app.get(TenantDatabase);
  const read = <T>(work: (tx: Parameters<Parameters<TenantDatabase["run"]>[1]>[0]) => Promise<T>) =>
    db.run({ userId: users.ownerId, tenantId, requestId: "seed" }, work);
  const [owner, pm, agent, finance] = await Promise.all(
    [users.ownerId, users.projectManagerId, users.siteAgentId, users.financeId].map((id) =>
      seedPrincipal(prisma, id, tenantId),
    ),
  );
  const existing = await read((tx) =>
    tx.pettyCashFloat.findFirst({ where: { tenantId, name: FLOAT_NAME } }),
  );
  if (existing) return summarise(app, finance, existing.id, false);

  const today = nairobiDate();
  const day = (offset: number) => addCalendarDays(today, offset);
  const facts = await read(async (tx) => {
    const ruiru = await tx.project.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: "RUI-HTS" } },
    });
    const site = await tx.site.findFirstOrThrow({
      where: { tenantId, projectId: ruiru.id },
      orderBy: { name: "asc" },
    });
    const bq = await approvedBqVersion(tx, tenantId, ruiru.id);
    if (!bq) throw new Error("The spending seed needs the stores seed's approved BQ");
    const columnBases = await tx.bqItem.findFirstOrThrow({
      where: { tenantId, versionId: bq.id, ref: "A" },
    });
    return { projectId: ruiru.id, siteId: site.id, itemA: columnBases.lineageId };
  });

  // 1. Company settings (opening cash entered a week ago) and the default cost codes.
  const costCodes = app.get(CostCodesService);
  const settings = await costCodes.settings(finance, seedRequest);
  await costCodes.updateSettings(
    finance,
    updateSpendingSettingsRequestSchema.parse({
      version: settings.settings.version,
      budgetAlertPercent: 80,
      unusualSpendMultiplier: "3",
      unusualSpendMinSamples: 5,
      duplicateWindowDays: 3,
      forecastWeeks: 13,
      openingCashMinor: 240_000_000,
      openingCashOn: day(-7),
    }),
    seedRequest,
  );
  await costCodes.loadDefaults(finance, seedRequest);
  const codes = (await costCodes.list(finance, { limit: 50 }, seedRequest)).costCodes;
  const code = (value: string) => codes.find((entry) => entry.code === value)!.id;

  // 2. Budget v1: the BQ items plus cost-code lines; the PM prepares, finance approves the digest.
  const budgets = app.get(BudgetsService);
  let budget = await budgets.create(
    pm,
    { projectId: facts.projectId, name: "Ruiru Heights cost budget (synthetic)", source: "bq" },
    seedRequest,
  );
  for (const [costCode, description, amountMinor] of [
    ["MAT-01", "Materials bought into the site store (synthetic)", 25_000_000],
    ["PRE-02", "Site security (synthetic)", 6_000_000],
    ["TRN-01", "Deliveries and boda boda runs (synthetic)", 2_000_000],
    ["PC-01", "Petty-cash sundries (synthetic)", 500_000],
  ] as const)
    budget = await budgets.addLine(
      pm,
      budget.budget.id,
      { version: budget.budget.version, costCodeId: code(costCode), description, amountMinor },
      seedRequest,
    );
  budget = await budgets.submit(pm, budget.budget.id, budget.budget.version, seedRequest);
  budget = await budgets.approve(
    finance,
    budget.budget.id,
    { version: budget.budget.version, digest: budget.budget.digest! },
    seedRequest,
  );

  // 3. The float: the site agent holds it; the first top-up is asked for, approved by finance
  //    and paid by the owner (three different people).
  const pettyCash = app.get(PettyCashService);
  const float = await pettyCash.createFloat(
    finance,
    {
      siteId: facts.siteId,
      name: FLOAT_NAME,
      custodianUserId: users.siteAgentId,
      limitMinor: 5_000_000,
    },
    seedRequest,
  );
  const floatId = float.float.id;
  let topUp = await pettyCash.requestTopUp(
    agent,
    { floatId, amountMinor: 3_000_000, reason: "Opening float for the main yard (synthetic)" },
    seedRequest,
  );
  topUp = await pettyCash.decideTopUp(
    finance,
    topUp.topUp.id,
    "approve",
    { version: topUp.topUp.version },
    seedRequest,
  );
  await pettyCash.payTopUp(
    owner,
    topUp.topUp.id,
    { version: topUp.topUp.version, method: "mpesa", reference: "SKD0E1M2O3", paidOn: today },
    seedRequest,
  );

  // 4. Expenses. The first is filled from a pasted M-Pesa SMS (a draft only: the custodian checks
  //    it, tags it and attaches the receipt).
  const expenses = app.get(ExpensesService);
  const smsDay = day(-2);
  const sms = `SKE4F5G6H7 Confirmed. Ksh850.00 paid to MWANGI HARDWARE (SYNTHETIC). on ${smsDay.slice(8, 10)}/${smsDay.slice(5, 7)}/${smsDay.slice(2, 4)} at 10:42 AM.New M-PESA balance is Ksh1,215.00. Transaction cost, Ksh0.00.`;
  const parsed = await expenses.parseSms(agent, sms, seedRequest);
  if (!parsed.result.ok) throw new Error("The demo SMS no longer parses");
  const draft = parsed.result.draft;
  const record = async (input: Record<string, unknown>) => {
    const id = randomUUID();
    return (
      await expenses.record(
        agent,
        createExpenseRequestSchema.parse({
          id,
          floatId,
          capturedAt: new Date().toISOString(),
          counterpartyKind: "other",
          paymentMethod: "cash",
          ...input,
        }),
        `seed-spending-${id}`,
        seedRequest,
      )
    ).expense;
  };
  const receipt = (id: string) =>
    expenses.addReceipt(
      agent,
      id,
      { buffer: RECEIPT, originalname: "receipt.png", size: RECEIPT.length },
      seedRequest,
    );
  const approve = async (expense: { id: string }) => {
    await receipt(expense.id);
    const current = await expenses.get(pm, expense.id, seedRequest);
    await expenses.decide(
      pm,
      expense.id,
      "approve",
      { version: current.expense.version },
      seedRequest,
    );
  };
  const fromSms = await record({
    spentOn: draft.occurredOn ?? smsDay,
    amountMinor: draft.amountMinor,
    chargeMinor: draft.chargeMinor ?? 0,
    category: "materials",
    bqItemLineageId: facts.itemA,
    payeeName: draft.counterpartyName ?? "Mwangi Hardware (synthetic)",
    paymentMethod: "mpesa",
    mpesaCode: draft.code,
    parsedFromSms: true,
    smsKind: draft.kind,
    description: "Binding wire for the column bases (synthetic)",
  });
  await approve(fromSms);
  for (const input of [
    {
      spentOn: day(-6),
      amountMinor: 60_000,
      category: "petty_cash",
      costCodeId: code("PC-01"),
      payeeName: "Kamau water vendor (synthetic)",
      description: "Drinking water for the crew (synthetic)",
    },
    {
      spentOn: day(-5),
      amountMinor: 70_000,
      category: "transport",
      costCodeId: code("TRN-01"),
      payeeName: "Boda boda rider (synthetic)",
      description: "Nails fetched from Ruiru town (synthetic)",
    },
    {
      spentOn: day(-4),
      amountMinor: 90_000,
      category: "petty_cash",
      costCodeId: code("PC-01"),
      payeeName: "Ruiru Hardware (synthetic)",
      description: "Two padlocks for the store (synthetic)",
    },
    {
      spentOn: day(-3),
      amountMinor: 240_000,
      chargeMinor: 3_400,
      category: "petty_cash",
      costCodeId: code("PC-01"),
      payeeName: "Ruiru Water Bowsers (synthetic)",
      payeeAccount: "RUI-HTS",
      paymentMethod: "mpesa",
      mpesaCode: "SKF7G8H9J0",
      description: "Water bowser for curing (synthetic)",
    },
  ])
    await approve(await record(input));

  // 5. The count: KES 150 short against the book, approved by the project manager.
  const book = (await pettyCash.float(finance, floatId, seedRequest)).float.balanceMinor;
  const count = await pettyCash.recordCount(
    agent,
    { floatId, countedMinor: book - 15_000, note: "Counted with the project manager (synthetic)" },
    seedRequest,
  );
  await pettyCash.decideCount(
    pm,
    count.count.id,
    "approve",
    { version: count.count.version },
    seedRequest,
  );

  // 6. Waiting for approval: the same shop and amount again without a receipt (a possible
  //    duplicate), and a generator repair far above the site's usual spend.
  await record({
    spentOn: day(-1),
    amountMinor: 85_000,
    category: "materials",
    bqItemLineageId: facts.itemA,
    payeeName: "Mwangi Hardware (synthetic)",
    description: "More binding wire (synthetic)",
  });
  const repair = await record({
    spentOn: today,
    amountMinor: 950_000,
    category: "plant",
    costCodeId: code("PLT-01"),
    payeeName: "Juja Generator Services (synthetic)",
    description: "Generator repair on site (synthetic)",
  });
  await receipt(repair.id);
  await pettyCash.requestTopUp(
    agent,
    { floatId, amountMinor: 1_000_000, reason: "Next week's sundries (synthetic)" },
    seedRequest,
  );

  // 7. A maker-checked journal: site security paid outside petty cash (finance proposes, the
  //    owner approves).
  const ledger = app.get(CostLedgerService);
  const journal = await ledger.createJournal(
    finance,
    createJournalRequestSchema.parse({
      projectId: facts.projectId,
      reason: "Site security for last month paid by bank transfer (synthetic)",
      lines: (["accrued", "paid"] as const).map((measure) => ({
        measure,
        category: "preliminaries",
        costCodeId: code("PRE-02"),
        siteId: facts.siteId,
        counterpartyKind: "other",
        counterpartyName: "Ruiru Guards Ltd (synthetic)",
        paymentReference: "FT-DEMO-0071",
        occurredOn: day(-10),
        amountMinor: 1_800_000,
      })),
    }),
    seedRequest,
  );
  await ledger.approveJournal(owner, journal.journal.id, journal.journal.version, seedRequest);

  // 8. Expected client receipts and one manual payment for the forecast.
  const cashFlow = app.get(CashFlowService);
  for (const item of [
    {
      direction: "in",
      description: "Client instalment 3 (synthetic)",
      expectedOn: day(17),
      amountMinor: 150_000_000,
      reference: "RUI-HTS-INST-3",
    },
    {
      direction: "in",
      description: "Client instalment 4 (synthetic)",
      expectedOn: day(52),
      amountMinor: 120_000_000,
    },
    {
      direction: "out",
      description: "Scaffold hire deposit (synthetic)",
      expectedOn: day(10),
      amountMinor: 8_500_000,
    },
  ])
    await cashFlow.create(
      finance,
      createCashFlowItemRequestSchema.parse({ projectId: facts.projectId, ...item }),
      seedRequest,
    );

  return summarise(app, finance, floatId, true);
}

async function summarise(
  app: INestApplicationContext,
  finance: Awaited<ReturnType<typeof seedPrincipal>>,
  floatId: string,
  created: boolean,
): Promise<SpendingSeedSummary> {
  const pettyCash = app.get(PettyCashService);
  const float = (await pettyCash.float(finance, floatId, seedRequest)).float;
  const projectId = float.project.id;
  const [budgets, expenses, topUps, counts, journals, alerts] = await Promise.all([
    app.get(BudgetsService).list(finance, projectId, seedRequest),
    app.get(ExpensesService).list(finance, { floatId, limit: 50 }, seedRequest),
    pettyCash.topUps(finance, { floatId, limit: 20 }, seedRequest),
    pettyCash.counts(finance, { floatId, limit: 5 }, seedRequest),
    app.get(CostLedgerService).journals(finance, { projectId, limit: 5 }, seedRequest),
    app.get(SpendAlertsService).list(finance, { projectId, limit: 1 }, seedRequest),
  ]);
  const budget = budgets.budgets.find((entry) => entry.current);
  return {
    created,
    budget: budget ? `v${budget.versionNo} (${budget.status})` : "none",
    float: float.name,
    expenses: expenses.expenses.map((entry) => `${entry.number} (${entry.status})`).reverse(),
    topUps: topUps.topUps.map((entry) => `${entry.number} (${entry.status})`).reverse(),
    count: counts.counts[0] ? `${counts.counts[0].number} (${counts.counts[0].status})` : "none",
    journal: journals.journals[0]
      ? `${journals.journals[0].number} (${journals.journals[0].status})`
      : "none",
    alerts: alerts.counts,
  };
}
