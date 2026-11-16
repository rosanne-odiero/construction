import { randomUUID } from "node:crypto";
import { z } from "zod";
import { KENYA_STATUTORY_SEED } from "@pm-buddy/types";
import {
  advanceResponseSchema,
  advancesResponseSchema,
  allowanceResponseSchema,
  allowancesResponseSchema,
  batchActionRequestSchema,
  batchDetailResponseSchema,
  cancelBatchRequestSchema,
  createAdvanceRequestSchema,
  createAllowanceRequestSchema,
  createBatchRequestSchema,
  createOutputRequestSchema,
  createStatutoryRuleRequestSchema,
  exportQuerySchema,
  exportSummaryResponseSchema,
  outputResponseSchema,
  outputsResponseSchema,
  payCalendarResponseSchema,
  payrollOverviewResponseSchema,
  payrollRulesResponseSchema,
  payrollSettingsResponseSchema,
  payslipResponseSchema,
  projectPayrollResponseSchema,
  statutoryRuleResponseSchema,
  updatePayCalendarRequestSchema,
  updatePayrollSettingsRequestSchema,
  verifyStatutoryRuleRequestSchema,
  type Advance,
  type Allowance,
  type BatchDetailResponse,
  type PieceRateOutput,
  type PayrollRulesResponse,
  type PayrollSettingsResponse,
} from "@pm-buddy/validation";

export const PAYROLL_BATCH_ID = "49000000-0000-4000-8000-000000000001";
export const PAYROLL_LINE_ID = "49100000-0000-4000-8000-000000000001";
const PROJECT = {
  id: "30000000-0000-4000-8000-000000000001",
  code: "PRJ-001",
  name: "Ruiru Heights Apartments",
};
const AUTHOR = { id: "10000000-0000-4000-8000-000000000099", displayName: "Payroll preparer" };
const WORKER = {
  id: "42000000-0000-4000-8000-000000000001",
  workerNo: "W-0001",
  fullName: "Amina Wekesa Njoroge",
};
const TODAY = "2026-11-15";
const AT = `${TODAY}T09:00:00.000Z`;
const calendar = {
  frequency: "weekly" as const,
  anchorDate: "2026-11-06",
  paydayOffsetDays: 1,
  minimumWageArea: null,
  version: 0,
  isDefault: true,
};

export function payrollFixture() {
  const rule = KENYA_STATUTORY_SEED[0]!;
  const rules: PayrollRulesResponse = {
    today: TODAY,
    production: false,
    permissions: { canManage: true, canVerify: true },
    rules: [
      {
        id: randomUUID(),
        kind: rule.kind,
        parameters: rule.parameters,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: null,
        inForce: true,
        status: "unverified",
        sourceReference: "COMPLIANCE-REVIEW synthetic source",
        notes: "Synthetic fixture only",
        createdBy: AUTHOR,
        createdAt: AT,
        verifiedBy: null,
        verifiedAt: null,
        verificationNote: null,
        submittedBatches: 0,
      },
    ],
    minimumWages: [],
    occupationByCategory: {},
  };
  const data: BatchDetailResponse = {
    project: PROJECT,
    batch: {
      id: PAYROLL_BATCH_ID,
      projectId: PROJECT.id,
      periodStart: "2026-11-06",
      periodEnd: "2026-11-12",
      payDate: "2026-11-13",
      statutoryMonth: "2026-11",
      frequency: "weekly",
      status: "draft",
      version: 1,
      unverifiedRules: true,
      lineCount: 1,
      grossMinor: 600_000,
      totalDeductionsMinor: 95_000,
      netMinor: 505_000,
      employerCostMinor: 50_000,
      digest: "a".repeat(64),
      calculatedAt: AT,
      createdBy: AUTHOR,
      createdAt: AT,
      submittedBy: null,
      submittedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      cancellationReason: null,
    },
    totals: {
      lines: 1,
      grossMinor: 600_000,
      statutoryBaseMinor: 600_000,
      employee: { nssf: 36_000, shif: 30_000, ahl: 9_000, paye: 0 },
      advanceRecoveryMinor: 20_000,
      otherDeductionsMinor: 0,
      totalDeductionsMinor: 95_000,
      netMinor: 505_000,
      employer: { nssf_employer: 36_000, ahl_employer: 9_000, nita: 5_000 },
      employerCostMinor: 50_000,
      shortfallMinor: 0,
    },
    lines: [
      {
        id: PAYROLL_LINE_ID,
        labourer: WORKER,
        engagementType: "casual",
        rateBasis: "daily",
        days: "6",
        daysWorked: 6,
        halfDays: 12,
        normalMinutes: 2880,
        overtimeMinutes: { weekday: 0, rest_day: 0, public_holiday: 0 },
        grossMinor: 600_000,
        statutoryWithheldMinor: 75_000,
        advanceRecoveryMinor: 20_000,
        netMinor: 505_000,
        employerCostMinor: 50_000,
        warnings: [{ code: "rules-unverified", details: {} }],
      },
    ],
    exclusions: [
      {
        sourceKind: "timesheet_line",
        sourceId: randomUUID(),
        labourer: WORKER,
        reason: "missing-rate",
        date: "2026-11-05",
      },
    ],
    unapprovedPeriods: [],
    pendingOutputs: 1,
    rules: [
      {
        id: rules.rules[0]!.id,
        kind: rule.kind,
        effectiveFrom: rule.effectiveFrom,
        status: "unverified",
      },
    ],
    snapshot: { digest: null, verified: null },
    production: false,
    permissions: { canRecalculate: true, canSubmit: true, canCancel: true },
  };
  const settings: PayrollSettingsResponse = {
    today: TODAY,
    settings: {
      advanceMaxMinor: 1_000_000,
      advanceMaxOutstandingMinor: 2_000_000,
      recoveryMaxPercent: "30",
      version: 0,
    },
    calendars: [{ project: PROJECT, calendar, canEdit: true }],
    canConfigure: true,
  };
  return {
    data,
    rules,
    settings,
    built: false,
    allowances: [] as Allowance[],
    outputs: [] as PieceRateOutput[],
    advances: [] as Advance[],
  };
}
export type PayrollState = ReturnType<typeof payrollFixture>;
type Deps = {
  persona: string;
  user: { id: string; displayName: string };
  fresh: () => boolean;
  fail: (status: number, code: string) => never;
};
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };

/** Transport fixtures only; calculation and database invariants are exercised by API e2e tests. */
export function handlePayroll(
  d: Deps,
  state: PayrollState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  if (!path.startsWith("/payroll")) return null;
  const outputRecorder =
    d.persona === "agent" && path === `/payroll/projects/${PROJECT.id}/outputs`;
  if (d.persona !== "owner" && d.persona !== "finance" && d.persona !== "pm" && !outputRecorder)
    d.fail(403, "forbidden");
  const canPrepare = d.persona !== "finance" && d.persona !== "agent";
  if (method !== "GET" && !canPrepare && path !== "/payroll/exports" && !outputRecorder)
    d.fail(403, "forbidden");
  const parse = <T,>(schema: z.ZodType<T>): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) d.fail(400, "validation-error");
    return parsed.data;
  };
  const data = () => ({
    ...state.data,
    permissions: {
      canRecalculate: canPrepare && state.data.batch.status === "draft",
      canSubmit: canPrepare && state.data.batch.status === "draft",
      canCancel: canPrepare && state.data.batch.status !== "cancelled",
    },
  });
  const period = () => ({
    startDate: "2026-11-06",
    endDate: "2026-11-12",
    payDate: "2026-11-13",
    ended: true,
    batch: state.built ? state.data.batch : null,
    timesheetPeriods: { approved: 1, notApproved: 0 },
  });
  if (path === "/payroll/overview")
    return {
      schema: payrollOverviewResponseSchema,
      body: {
        today: TODAY,
        production: false,
        unverifiedRuleVersions: 1,
        projects: [
          {
            project: PROJECT,
            calendar: state.settings.calendars[0]!.calendar,
            current: period(),
            drafts: state.built && state.data.batch.status === "draft" ? 1 : 0,
            submitted: state.data.batch.status === "submitted" ? 1 : 0,
            canPrepare,
          },
        ],
        permissions: {
          canViewRules: true,
          canExport: true,
          canSeeAdvances: true,
          canConfigure: canPrepare,
        },
      },
    };
  const projectBase = `/payroll/projects/${PROJECT.id}`;
  if (path === projectBase)
    return {
      schema: projectPayrollResponseSchema,
      body: {
        project: PROJECT,
        today: TODAY,
        calendar: state.settings.calendars[0]!.calendar,
        periods: [period()],
        batches: state.built ? [state.data.batch] : [],
        permissions: { canPrepare, canRecordOutput: canPrepare, canDecideOutput: canPrepare },
      },
    };
  if (path === `${projectBase}/batches` && method === "POST") {
    parse(createBatchRequestSchema);
    if (state.built) d.fail(409, "batch-exists");
    state.built = true;
    return { status: 201, schema: batchDetailResponseSchema, body: data() };
  }
  const batchPath = `/payroll/batches/${PAYROLL_BATCH_ID}`;
  if (path === batchPath) return { schema: batchDetailResponseSchema, body: data() };
  if ([`${batchPath}/recalculate`, `${batchPath}/submit`, `${batchPath}/cancel`].includes(path)) {
    const input = path.endsWith("/cancel")
      ? parse(cancelBatchRequestSchema)
      : parse(batchActionRequestSchema);
    if (input.version !== state.data.batch.version) d.fail(409, "version-conflict");
    if (path.endsWith("/submit")) {
      state.data.batch.status = "submitted";
      state.data.batch.submittedBy = d.user;
      state.data.batch.submittedAt = AT;
      state.data.snapshot = { digest: state.data.batch.digest, verified: true };
    } else if (path.endsWith("/cancel")) {
      state.data.batch.status = "cancelled";
      state.data.batch.cancellationReason =
        "reason" in input && typeof input.reason === "string" ? input.reason : null;
    }
    state.data.batch.version++;
    return { schema: batchDetailResponseSchema, body: data() };
  }
  if (path === `${batchPath}/lines/${PAYROLL_LINE_ID}`)
    return {
      schema: payslipResponseSchema,
      body: {
        company: "Jenga Bora Builders Ltd",
        project: PROJECT,
        batch: state.data.batch,
        line: {
          ...state.data.lines[0]!,
          trade: null,
          earnings: [
            {
              kind: "attendance",
              category: "weekday",
              date: "2026-11-06",
              description: "Approved attendance",
              quantity: "6",
              unit: "day",
              rateMinor: 100_000,
              multiplier: null,
              labourRateId: null,
              amountMinor: 600_000,
              taxable: true,
            },
          ],
          deductions: [
            {
              kind: "nssf",
              dueMinor: 36_000,
              withheldMinor: 36_000,
              shortfallMinor: 0,
              ruleVersionId: state.rules.rules[0]!.id,
            },
          ],
          recoveries: [
            { advanceId: randomUUID(), amountMinor: 20_000, outstandingAfterMinor: 80_000 },
          ],
          employerCosts: [
            { kind: "nita", amountMinor: 5_000, ruleVersionId: state.rules.rules[0]!.id },
          ],
          monthToDate: {
            statutoryMonth: "2026-11",
            priorBatches: 0,
            priorBaseMinor: 0,
            cumulativeBaseMinor: 600_000,
            taxablePayMinor: 525_000,
            payeBeforeReliefMinor: 52_500,
            personalReliefMinor: 52_500,
            monthly: state.data.totals.employee,
          },
          advanceBalanceMinor: 80_000,
        },
      },
    };
  if (path === "/payroll/rules" && method === "POST") {
    const input = parse(createStatutoryRuleRequestSchema);
    const rule = { ...state.rules.rules[0]!, ...input, id: randomUUID(), createdBy: d.user };
    state.rules.rules.push(rule);
    return { status: 201, schema: statutoryRuleResponseSchema, body: { rule } };
  }
  if (path === "/payroll/rules" || path === "/payroll/rules/defaults")
    return {
      schema: payrollRulesResponseSchema,
      body: { ...state.rules, permissions: { canManage: canPrepare, canVerify: canPrepare } },
    };
  const verify = /^\/payroll\/rules\/([^/]+)\/verify$/.exec(path);
  if (verify) {
    const input = parse(verifyStatutoryRuleRequestSchema);
    if (!d.fresh()) d.fail(403, "step-up-required");
    const rule = state.rules.rules.find((item) => item.id === verify[1]);
    if (!rule) d.fail(404, "not-found");
    rule.status = "verified";
    rule.verifiedBy = d.user;
    rule.verifiedAt = AT;
    rule.verificationNote = input.note;
    return { schema: statutoryRuleResponseSchema, body: { rule } };
  }
  if (path === "/payroll/settings") {
    if (method === "PUT") {
      const input = parse(updatePayrollSettingsRequestSchema);
      state.settings.settings = { ...input, version: input.version + 1 };
    }
    return {
      schema: payrollSettingsResponseSchema,
      body: {
        ...state.settings,
        canConfigure: canPrepare,
        calendars: state.settings.calendars.map((row) => ({ ...row, canEdit: canPrepare })),
      },
    };
  }
  if (path === `${projectBase}/calendar`) {
    const input = parse(updatePayCalendarRequestSchema);
    state.settings.calendars[0]!.calendar = {
      ...input,
      version: input.version + 1,
      isDefault: false,
    };
    return {
      schema: payCalendarResponseSchema,
      body: { project: PROJECT, calendar: state.settings.calendars[0]!.calendar },
    };
  }
  if (path === `${projectBase}/allowances`) {
    if (method === "POST") {
      const input = parse(createAllowanceRequestSchema);
      const allowance: Allowance = {
        code: input.code,
        nameEn: input.nameEn,
        nameSw: input.nameSw,
        basis: input.basis,
        amountMinor: input.amountMinor,
        taxable: input.taxable,
        effectiveFrom: input.effectiveFrom,
        id: randomUUID(),
        projectId: PROJECT.id,
        trade: null,
        labourer: input.labourerId ? WORKER : null,
        endedOn: null,
        createdBy: d.user,
        createdAt: AT,
      };
      state.allowances.push(allowance);
      return { status: 201, schema: allowanceResponseSchema, body: { allowance } };
    }
    return {
      schema: allowancesResponseSchema,
      body: {
        project: PROJECT,
        today: TODAY,
        allowances: state.allowances,
        trades: [],
        canManage: canPrepare,
      },
    };
  }
  if (path === `${projectBase}/outputs`) {
    if (method === "POST") {
      const input = parse(createOutputRequestSchema);
      const output: PieceRateOutput = {
        workDate: input.workDate,
        description: input.description,
        unit: input.unit,
        quantity: input.quantity,
        rateMinor: input.rateMinor,
        id: randomUUID(),
        projectId: PROJECT.id,
        labourer: input.labourerId ? WORKER : null,
        gang: input.gangId ? { id: input.gangId, name: "Gang A" } : null,
        bqItem: null,
        amountMinor: 100_000,
        status: "pending",
        version: 1,
        recordedBy: d.user,
        recordedAt: AT,
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        shares: [],
      };
      state.outputs.push(output);
      return { status: 201, schema: outputResponseSchema, body: { output } };
    }
    return {
      schema: outputsResponseSchema,
      body: {
        project: PROJECT,
        today: TODAY,
        outputs: state.outputs,
        gangs: [{ id: "43000000-0000-4000-8000-000000000001", name: "Gang A", members: 3 }],
        permissions: { canRecord: canPrepare || outputRecorder, canDecide: canPrepare },
      },
    };
  }
  if (path === "/payroll/advances")
    return {
      schema: advancesResponseSchema,
      body: {
        today: TODAY,
        advances: state.advances,
        limits: state.settings.settings,
        requestableProjects: canPrepare ? [PROJECT] : [],
      },
    };
  if (path === `${projectBase}/advances` && method === "POST") {
    const input = parse(createAdvanceRequestSchema);
    const advance: Advance = {
      amountMinor: input.amountMinor,
      reason: input.reason,
      instalmentMinor: input.instalmentMinor,
      maxRecoveryPercent: input.maxRecoveryPercent,
      id: randomUUID(),
      project: PROJECT,
      labourer: WORKER,
      status: "requested",
      displayStatus: "requested",
      recoveredMinor: 0,
      outstandingMinor: input.amountMinor,
      version: 1,
      requestedBy: d.user,
      requestedAt: AT,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      disbursement: null,
      cancelledBy: null,
      cancelledAt: null,
      cancellationReason: null,
      recoveries: [],
      permissions: { canDecide: false, canDisburse: false, canCancel: true },
    };
    state.advances.push(advance);
    return { status: 201, schema: advanceResponseSchema, body: { advance } };
  }
  if (path === "/payroll/exports") {
    const input = exportQuerySchema.parse(Object.fromEntries(query));
    return {
      schema: exportSummaryResponseSchema,
      body: {
        month: input.month,
        production: false,
        batches:
          state.data.batch.status === "submitted"
            ? [
                {
                  id: PAYROLL_BATCH_ID,
                  project: PROJECT,
                  periodStart: "2026-11-06",
                  periodEnd: "2026-11-12",
                  payDate: "2026-11-13",
                  unverifiedRules: true,
                },
              ]
            : [],
        employees: 1,
        totals: {
          grossMinor: 600_000,
          employee: state.data.totals.employee,
          employer: state.data.totals.employer,
          shortfallMinor: 0,
        },
        missingIdentifiers: { kraPin: 0, nssfNumber: 1, shaNumber: 1 },
        unverified: true,
        blocked: false,
        canExport: true,
      },
    };
  }
  d.fail(404, "not-found");
}
