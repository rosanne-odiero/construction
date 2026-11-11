import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addCalendarDays,
  isoWeekday,
  monthlyStatutory,
  nairobiDate,
  selectRuleSet,
  statutoryMonthOf,
  type StatutoryRuleVersion,
} from "@pm-buddy/domain";
import {
  CURRENT_CONSENT_NOTICE,
  DEMO_TIMESHEET_RULE,
  KENYA_STATUTORY_SEED,
  type EmployeeStatutory,
} from "@pm-buddy/types";
import {
  advanceResponseSchema,
  advancesResponseSchema,
  allowanceResponseSchema,
  batchDetailResponseSchema,
  batchSnapshotResponseSchema,
  exportSummaryResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  outputResponseSchema,
  payrollOverviewResponseSchema,
  payrollRulesResponseSchema,
  payrollSettingsResponseSchema,
  payslipResponseSchema,
  periodsResponseSchema,
  projectPayrollResponseSchema,
  projectResponseSchema,
  siteResponseSchema,
  statutoryRuleResponseSchema,
  musterResponseSchema,
  type BatchDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { PayrollAccess } from "../src/modules/payroll/payroll-support.js";
import { Browser, notifications } from "./support.js";

const ruiru = { lat: -1.1489, lng: 36.9612 };
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("Payroll engine (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let agent: Browser;
  let foreman: Browser;
  let finance: Browser;
  let tenantA: string;
  let tenantB: string;
  let p1: string;
  let p2: string;
  let pB: string;
  let site1: string;
  let site2: string;
  let seq = 0;
  const workers: Record<string, string> = {};
  let notificationSpy: ReturnType<typeof vi.spyOn>;
  let batchP2: BatchDetailResponse;
  let batchP1: BatchDetailResponse;

  const today = nairobiDate();
  // Weekly periods end tomorrow's weekday, so the current period is never due during the run.
  const weekEndsOn = isoWeekday(addCalendarDays(today, 1));
  const P1 = { start: addCalendarDays(today, -12), end: addCalendarDays(today, -6) };
  const P2 = { start: addCalendarDays(today, -19), end: addCalendarDays(today, -13) };
  const current = { start: addCalendarDays(today, -5), end: addCalendarDays(today, 1) };
  const datesOf = (period: { start: string }) =>
    Array.from({ length: 7 }, (_, index) => addCalendarDays(period.start, index));
  const workdays = (period: { start: string }) =>
    datesOf(period).filter((date) => isoWeekday(date) !== 7);
  const sundayP1 = datesOf(P1).find((date) => isoWeekday(date) === 7)!;
  const saturdayP1 = datesOf(P1).find((date) => isoWeekday(date) === 6)!;
  const mondayToFridayP1 = workdays(P1).filter((date) => isoWeekday(date) <= 5);

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const stale = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });
  const as = (browser: Browser, tenantId: string, requestId: string) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId,
  });
  const problem = (res: request.Response) => (res.body as { code?: string }).code;
  const readA = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.run(as(owner, tenantA, "e2e-read"), query);
  const detail = (res: request.Response) => batchDetailResponseSchema.parse(res.body);
  const lineOf = (view: BatchDetailResponse, key: string) =>
    view.lines.find((line) => line.labourer.id === workers[key]);
  const getBatch = async (browser: Browser, id: string) => {
    const res = await browser.call("get", `payroll/batches/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return detail(res);
  };
  const payslip = async (browser: Browser, batchId: string, key: string) => {
    const view = await getBatch(browser, batchId);
    const line = lineOf(view, key)!;
    const res = await browser.call("get", `payroll/batches/${batchId}/lines/${line.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return payslipResponseSchema.parse(res.body);
  };
  /** Statutory rule versions as the engine sees them (from the seed, all unverified). */
  const seedRules = (date: string) => {
    const { rules } = selectRuleSet(
      KENYA_STATUTORY_SEED.map(
        (seed) =>
          ({
            id: seed.kind,
            kind: seed.kind,
            effectiveFrom: seed.effectiveFrom,
            status: "unverified",
            parameters: seed.parameters,
          }) as StatutoryRuleVersion,
      ),
      date,
    );
    return rules!;
  };
  const auditEvents = () =>
    readA((tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA },
        select: { action: true, metadata: true },
      }),
    );

  const join = async (member: Browser, role: string, projectIds: string[]) => {
    await fresh(owner);
    const invited = await owner.call("post", "tenants/current/invitations", {
      identifier: member.identifier,
      role,
      projectIds,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    const token = notifications
      .get(member.identifier)
      ?.at(-1)
      ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
    expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
    expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
  };
  const site = async (browser: Browser, projectId: string, name: string, east: number) => {
    const res = await browser.call("post", `projects/${projectId}/sites`, {
      name,
      geofence: {
        kind: "radius",
        center: { lat: ruiru.lat, lng: Math.round((ruiru.lng + east / 111_173) * 1e6) / 1e6 },
        radiusM: 50,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return siteResponseSchema.parse(res.body).site.id;
  };
  const register = async (
    key: string,
    setup: { trade: string; level: string },
    extra: Record<string, unknown> = {},
  ) => {
    seq += 1;
    const n = String(seq).padStart(7, "0");
    const res = await owner.call("post", "labour/labourers", {
      fullName: `Mfanyakazi Mshahara ${key}`,
      dateOfBirth: "1991-03-09",
      gender: "female",
      tradeId: setup.trade,
      skillLevelId: setup.level,
      engagementType: "casual",
      rateBasis: "daily",
      idType: "national_id",
      idNumber: `7${n}`,
      projectId: p1,
      engagementStartDate: addCalendarDays(today, -40),
      consent: {
        noticeVersion: CURRENT_CONSENT_NOTICE.version,
        language: "en",
        method: "signed",
        granted: true,
      },
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    workers[key] = labourerResponseSchema.parse(res.body).labourer.id;
  };
  const present = (key: string, checkIn = "07:00", checkOut = "16:00", status = "present") => ({
    labourerId: workers[key],
    version: 0,
    status,
    checkIn,
    checkOut,
  });
  /** Records (recorder), submits and confirms (confirmer) one muster day. */
  const recordDay = async (
    recorder: Browser,
    confirmer: Browser,
    projectId: string,
    siteId: string,
    date: string,
    entries: object[],
  ) => {
    const current = await recorder.call(
      "get",
      `attendance/projects/${projectId}/muster?siteId=${siteId}&date=${date}`,
    );
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    const saved = await recorder.call("put", `attendance/projects/${projectId}/muster`, {
      siteId,
      date,
      dayVersion: musterResponseSchema.parse(current.body).day?.version ?? 0,
      entries,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const view = musterResponseSchema.parse(saved.body);
    const submitted = await recorder.call("post", `attendance/days/${view.day!.id}/submit`, {
      version: view.day!.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const confirmed = await confirmer.call("post", `attendance/days/${view.day!.id}/confirm`, {
      version: musterResponseSchema.parse(submitted.body).day!.version,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  };
  /** Submits (submitter) and approves (approver) the timesheet period starting on `start`. */
  const approvePeriod = async (
    submitter: Browser,
    approver: Browser,
    projectId: string,
    start: string,
  ) => {
    const list = await submitter.call("get", `attendance/projects/${projectId}/periods`);
    expect(list.status).toBe(200);
    const period = periodsResponseSchema
      .parse(list.body)
      .periods.find((entry) => entry.period.startDate === start)!.period;
    const submitted = await submitter.call("post", `attendance/periods/${period.id}/submit`, {
      version: period.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const approved = await approver.call("post", `attendance/periods/${period.id}/approve`, {
      version: (submitted.body as { period: { version: number } }).period.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  };
  const createBatch = (browser: Browser, projectId: string, periodStart: string, headers = {}) =>
    browser.call("post", `payroll/projects/${projectId}/batches`, { periodStart }, true, headers);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
    owner = new Browser(app);
    ownerB = new Browser(app);
    pm = new Browser(app);
    agent = new Browser(app);
    foreman = new Browser(app);
    finance = new Browser(app);
    for (const browser of [owner, ownerB, finance]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [pm, agent, foreman]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Payroll company A" });
    const b = await ownerB.call("post", "tenants", { name: "Payroll company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    await fresh(ownerB);
    p1 = projectResponseSchema.parse(
      (await owner.call("post", "projects", { code: "PAY-ONE", name: "Payroll one" })).body,
    ).project.id;
    p2 = projectResponseSchema.parse(
      (await owner.call("post", "projects", { code: "PAY-TWO", name: "Payroll two" })).body,
    ).project.id;
    pB = projectResponseSchema.parse(
      (await ownerB.call("post", "projects", { code: "PAY-B", name: "Payroll B" })).body,
    ).project.id;
    site1 = await site(owner, p1, "Main plot", 0);
    site2 = await site(owner, p2, "Second plot", 900);
    await join(pm, "project_manager", [p1, p2]);
    await join(agent, "site_agent", [p1]);
    await join(foreman, "foreman", [p1]);
    await fresh(finance);
    await join(finance, "finance", []);

    // Labour: general labourers on daily and hourly rates, a piece-rate labourer and one with no
    // rate; W2 also works on project two. Opening rates start 40 days back (D4.1).
    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const general = {
      trade: setup.trades.find((trade) => trade.key === "general_labourer")!.id,
      level: setup.skillLevels.find((level) => level.key === "unskilled")!.id,
    };
    const electrician = {
      trade: setup.trades.find((trade) => trade.key === "electrician")!.id,
      level: general.level,
    };
    await register("W1", general, {
      kraPin: "A000000001Z",
      nssfNumber: "NSSF0001",
      shaNumber: "SHA0001",
    });
    for (const key of ["W2", "W3", "W4"]) await register(key, general);
    await register("W5", general, { rateBasis: "hourly" });
    await register("W6", general, { engagementType: "piece_rate" });
    await register("W7", electrician);
    const engaged = await owner.call("post", `labour/labourers/${workers.W2}/engagements`, {
      projectId: p2,
      startDate: addCalendarDays(today, -40),
    });
    expect(engaged.status, JSON.stringify(engaged.body)).toBe(201);
    for (const [basis, rateMinor] of [
      ["daily", 100_000],
      ["hourly", 15_000],
    ] as const) {
      const rate = await owner.call("post", "labour/rates", {
        tradeId: general.trade,
        basis,
        rateMinor,
        effectiveFrom: addCalendarDays(today, -40),
      });
      expect(rate.status, JSON.stringify(rate.body)).toBe(201);
    }

    // Attendance: rules, weekly periods ending tomorrow's weekday, two approved weeks on project
    // one and one on project two.
    const { sourceReference, ...values } = DEMO_TIMESHEET_RULE;
    const rule = await owner.call("post", "attendance/rules", {
      ...values,
      restDays: [7],
      sourceReference,
      effectiveFrom: addCalendarDays(today, -60),
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const periods = await owner.call("put", "attendance/settings/periods", {
      weekEndsOn,
      cutoffTime: "18:00",
      paydayWeekday: 5,
      version: 0,
    });
    expect(periods.status, JSON.stringify(periods.body)).toBe(200);
    for (const date of workdays(P2))
      await recordDay(agent, pm, p1, site1, date, [
        ...["W1", "W2", "W3", "W4", "W5", "W6"].map((key) => present(key)),
        ...(date === workdays(P2)[0] ? [present("W7")] : []),
      ]);
    for (const date of workdays(P1))
      await recordDay(agent, pm, p1, site1, date, [
        date === workdays(P1)[1] ? present("W1", "07:00", "18:00") : present("W1"),
        ...(isoWeekday(date) <= 5 ? [present("W2")] : []),
        date === workdays(P1)[2] ? present("W3", "07:00", "11:00", "half_day") : present("W3"),
        present("W4"),
        present("W5", "07:00", "15:00"),
        present("W6"),
      ]);
    await recordDay(agent, pm, p1, site1, sundayP1, [present("W1", "07:00", "12:30")]);
    await recordDay(owner, pm, p2, site2, saturdayP1, [present("W2")]);
    await approvePeriod(agent, pm, p1, P2.start);
    await approvePeriod(agent, pm, p1, P1.start);
    await approvePeriod(owner, pm, p2, P1.start);
    expect(mondayToFridayP1.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    vi.restoreAllMocks();
    await app?.close();
  });

  it("documents every payroll operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getPayrollOverview",
      "getPayrollSettings",
      "updatePayrollSettings",
      "updatePayCalendar",
      "listStatutoryRules",
      "createStatutoryRule",
      "installStatutoryRules",
      "verifyStatutoryRule",
      "deleteStatutoryRule",
      "createMinimumWage",
      "getProjectPayroll",
      "createPayrollBatch",
      "getPayrollBatch",
      "recalculatePayrollBatch",
      "submitPayrollBatch",
      "cancelPayrollBatch",
      "getPayslip",
      "getPayrollSnapshot",
      "listAllowances",
      "createAllowance",
      "endAllowance",
      "listPieceRateOutputs",
      "createPieceRateOutput",
      "approvePieceRateOutput",
      "rejectPieceRateOutput",
      "listAdvances",
      "requestAdvance",
      "approveAdvance",
      "rejectAdvance",
      "disburseAdvance",
      "cancelAdvance",
      "getPayrollExportSummary",
      "downloadPayrollExport",
    ])
      expect(operations, id).toContain(id);
  });

  it("installs unverified statutory rules and lets only another person verify one, with step-up", async () => {
    expect((await foreman.call("get", "payroll/rules")).status).toBe(403);
    const empty = payrollRulesResponseSchema.parse((await pm.call("get", "payroll/rules")).body);
    expect(empty.rules).toEqual([]);
    expect(empty.permissions).toEqual({ canManage: false, canVerify: false });
    expect((await pm.call("post", "payroll/rules/defaults", {})).status).toBe(403);
    const installed = await owner.call("post", "payroll/rules/defaults", {});
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    const rules = payrollRulesResponseSchema.parse(installed.body);
    expect(rules.rules).toHaveLength(KENYA_STATUTORY_SEED.length);
    expect(rules.rules.every((rule) => rule.status === "unverified")).toBe(true);
    expect(rules.minimumWages).toHaveLength(18);
    const nssf = rules.rules.filter((rule) => rule.kind === "nssf");
    expect(nssf.map((rule) => [rule.effectiveFrom, rule.effectiveTo, rule.inForce])).toEqual([
      ["2026-02-01", null, true],
      ["2025-02-01", "2026-01-31", false],
    ]);
    // Idempotent install: nothing is duplicated.
    const again = payrollRulesResponseSchema.parse(
      (await owner.call("post", "payroll/rules/defaults", {})).body,
    );
    expect(again.rules).toHaveLength(KENYA_STATUTORY_SEED.length);

    const year3 = nssf.find((rule) => rule.effectiveFrom === "2025-02-01")!;
    const note = { note: "Checked against the NSSF Act Third Schedule (test)" };
    expect((await pm.call("post", `payroll/rules/${year3.id}/verify`, note)).status).toBe(403);
    await stale(finance);
    const staleVerify = await finance.call("post", `payroll/rules/${year3.id}/verify`, note);
    expect([staleVerify.status, problem(staleVerify)]).toEqual([403, "step-up-required"]);
    await fresh(owner);
    const own = await owner.call("post", `payroll/rules/${year3.id}/verify`, note);
    expect([own.status, problem(own)]).toEqual([409, "same-person"]);
    expect(
      (await finance.call("post", `payroll/rules/${year3.id}/verify`, { note: "short" })).status,
    ).toBe(400);
    await fresh(finance);
    const verified = await finance.call("post", `payroll/rules/${year3.id}/verify`, note);
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(statutoryRuleResponseSchema.parse(verified.body).rule).toMatchObject({
      status: "verified",
      verifiedBy: { id: finance.auth.user.id },
      verificationNote: note.note,
    });
    const twice = await finance.call("post", `payroll/rules/${year3.id}/verify`, note);
    expect([twice.status, problem(twice)]).toEqual([409, "rule-verified"]);
    // Verified versions never change, even by direct SQL under the runtime role.
    await expect(
      readA((tx) =>
        tx.statutoryRuleVersion.update({
          where: { tenantId_id: { tenantId: tenantA, id: year3.id } },
          data: { notes: "edited" },
        }),
      ),
    ).rejects.toThrow();

    // A new version (never an edit); duplicates and invalid parameters are refused.
    const future = addCalendarDays(today, 400);
    const shif = {
      kind: "shif",
      effectiveFrom: future,
      parameters: { employeeRatePercent: "3", minimumMinor: 30_000, maximumMinor: null },
      sourceReference: "Hypothetical future regulation (test only)",
      notes: "",
    };
    expect((await finance.call("post", "payroll/rules", shif)).status).toBe(201);
    const duplicate = await finance.call("post", "payroll/rules", shif);
    expect([duplicate.status, problem(duplicate)]).toEqual([409, "rule-exists"]);
    expect(
      (
        await finance.call("post", "payroll/rules", {
          ...shif,
          effectiveFrom: addCalendarDays(future, 1),
          parameters: { employeeRatePercent: "3", minimumMinor: 500, maximumMinor: 100 },
        })
      ).status,
    ).toBe(400);
    expect((await agent.call("post", "payroll/rules", shif)).status).toBe(403);
    const created = payrollRulesResponseSchema
      .parse((await finance.call("get", "payroll/rules")).body)
      .rules.find((rule) => rule.kind === "shif" && rule.effectiveFrom === future)!;
    const verifiedDelete = await owner.call("delete", `payroll/rules/${year3.id}`);
    expect([verifiedDelete.status, problem(verifiedDelete)]).toEqual([409, "rule-verified"]);
    expect((await owner.call("delete", `payroll/rules/${created.id}`)).status).toBe(200);

    const wage = await owner.call("post", "payroll/minimum-wages", {
      effectiveFrom: "2026-05-01",
      area: "cities",
      occupation: "general_labourer",
      monthlyMinor: 1_804_740,
      source: "Regulation of Wages (General) (Amendment) Order, 2026 (test duplicate)",
    });
    expect([wage.status, problem(wage)]).toEqual([409, "minimum-wage-exists"]);
  });

  it("keeps settings and calendars behind their permissions with expected versions", async () => {
    const settings = payrollSettingsResponseSchema.parse(
      (await pm.call("get", "payroll/settings")).body,
    );
    expect(settings.canConfigure).toBe(false);
    expect(settings.settings).toMatchObject({ recoveryMaxPercent: "50", version: 0 });
    expect(settings.calendars.map((entry) => entry.project.id).sort()).toEqual([p1, p2].sort());
    const body = {
      advanceMaxMinor: 500_000,
      advanceMaxOutstandingMinor: 1_000_000,
      recoveryMaxPercent: "50",
      version: 0,
    };
    expect((await pm.call("put", "payroll/settings", body)).status).toBe(403);
    expect((await owner.call("put", "payroll/settings", body)).status).toBe(200);
    const conflict = await owner.call("put", "payroll/settings", body);
    expect([conflict.status, problem(conflict)]).toEqual([409, "version-conflict"]);

    const calendar = {
      frequency: "weekly",
      anchorDate: P2.start,
      paydayOffsetDays: 1,
      minimumWageArea: "municipalities",
      version: 0,
    };
    expect((await foreman.call("put", `payroll/projects/${p1}/calendar`, calendar)).status).toBe(
      403,
    );
    const saved = await pm.call("put", `payroll/projects/${p1}/calendar`, calendar);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const view = projectPayrollResponseSchema.parse(
      (await pm.call("get", `payroll/projects/${p1}`)).body,
    );
    expect(view.calendar).toMatchObject({ frequency: "weekly", anchorDate: P2.start, version: 1 });
    expect(view.periods[0]).toMatchObject({ startDate: current.start, ended: false });
    const approvedRow = view.periods.find((row) => row.startDate === P1.start)!;
    expect(approvedRow).toMatchObject({
      endDate: P1.end,
      payDate: addCalendarDays(P1.end, 1),
      batch: null,
      timesheetPeriods: { approved: 1, notApproved: 0 },
    });
    expect(view.permissions.canPrepare).toBe(true);
    expect((await agent.call("get", `payroll/projects/${p1}`)).status).toBe(403);
    const overview = payrollOverviewResponseSchema.parse(
      (await pm.call("get", "payroll/overview")).body,
    );
    expect(overview.projects.map((entry) => entry.project.id).sort()).toEqual([p1, p2].sort());
    expect(overview.unverifiedRuleVersions).toBe(KENYA_STATUTORY_SEED.length - 1);
  });

  it("builds a draft from approved timesheets once, even when two requests race", async () => {
    expect((await foreman.call("post", `payroll/projects/${p1}/batches`, {})).status).toBe(400);
    expect(
      (await agent.call("post", `payroll/projects/${p1}/batches`, { periodStart: P2.start }))
        .status,
    ).toBe(403);
    const misaligned = await createBatch(pm, p1, addCalendarDays(P2.start, 1));
    expect([misaligned.status, problem(misaligned)]).toEqual([400, "period-not-in-calendar"]);
    const future = await createBatch(pm, p1, addCalendarDays(current.start, 7));
    expect([future.status, problem(future)]).toEqual([409, "period-not-started"]);
    const [first, second] = await Promise.all([
      createBatch(pm, p1, P2.start),
      createBatch(pm, p1, P2.start),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409]);
    const created = first.status === 201 ? first : second;
    const refused = first.status === 201 ? second : first;
    expect(problem(refused)).toBe("batch-exists");
    batchP2 = detail(created);
    expect(batchP2.batch).toMatchObject({
      status: "draft",
      periodStart: P2.start,
      periodEnd: P2.end,
      payDate: addCalendarDays(P2.end, 1),
      statutoryMonth: statutoryMonthOf(addCalendarDays(P2.end, 1)),
      unverifiedRules: true,
      version: 1,
    });
    // W7's trade has no rate: the line is left out and stays available.
    expect(batchP2.exclusions).toEqual([
      expect.objectContaining({
        sourceKind: "timesheet_line",
        reason: "missing-rate",
        labourer: expect.objectContaining({ id: workers.W7 }),
      }),
    ]);
    // W1: six full days at KES 1,000, first batch of its statutory month.
    const w1 = lineOf(batchP2, "W1")!;
    expect(w1).toMatchObject({ days: "6", grossMinor: 600_000, statutoryWithheldMinor: 75_000 });
    expect(w1.netMinor).toBe(525_000);
    const slip = await payslip(pm, batchP2.batch.id, "W1");
    expect(slip.line.deductions.map((entry) => [entry.kind, entry.withheldMinor])).toEqual([
      ["nssf", 36_000],
      ["shif", 30_000],
      ["ahl", 9_000],
      ["paye", 0],
    ]);
    expect(slip.line.employerCosts.map((entry) => [entry.kind, entry.amountMinor])).toEqual([
      ["nssf_employer", 36_000],
      ["ahl_employer", 9_000],
      ["nita", 5_000],
    ]);
    expect(slip.line.earnings.every((row) => row.labourRateId !== null)).toBe(true);
    // W5 is paid by the hour (8 h × KES 150 a day, 6 days); W6 is engaged on piece rate.
    expect(lineOf(batchP2, "W5")).toMatchObject({ grossMinor: 6 * 8 * 15_000 });
    const w6 = lineOf(batchP2, "W6")!;
    expect(w6.grossMinor).toBe(0);
    expect(w6.warnings.map((warning) => warning.code)).toEqual([
      "piece-rate-engagement",
      "zero-pay",
    ]);
    // Totals reconcile with the line sums.
    expect(batchP2.totals.grossMinor).toBe(
      batchP2.lines.reduce((sum, line) => sum + line.grossMinor, 0),
    );
    expect(batchP2.totals.netMinor).toBe(
      batchP2.lines.reduce((sum, line) => sum + line.netMinor, 0),
    );

    // Each timesheet line is consumed once: the database refuses a second live consumption.
    const consumed = await readA((tx) =>
      tx.payrollConsumption.findFirstOrThrow({
        where: { batchId: batchP2.batch.id, sourceKind: "timesheet_line" },
      }),
    );
    const probe = await createBatch(pm, p1, P1.start, { "Idempotency-Key": "pay-p1-build-0001" });
    expect(probe.status, JSON.stringify(probe.body)).toBe(201);
    batchP1 = detail(probe);
    await expect(
      readA((tx) =>
        tx.payrollConsumption.create({
          data: {
            tenantId: tenantA,
            projectId: p1,
            batchId: batchP1.batch.id,
            sourceKind: "timesheet_line",
            timesheetLineId: consumed.timesheetLineId,
          },
        }),
      ),
    ).rejects.toThrow();
    // The later batch holds only its own week's lines.
    const consumedLines = await readA(async (tx) => {
      const rows = await tx.payrollConsumption.findMany({ where: { batchId: batchP1.batch.id } });
      return tx.timesheetLine.findMany({
        where: {
          id: { in: rows.flatMap((row) => (row.timesheetLineId ? [row.timesheetLineId] : [])) },
        },
        select: { periodId: true },
      });
    });
    const periodIds = new Set(consumedLines.map((row) => row.periodId));
    expect(periodIds.size).toBe(1);
    // Idempotency: the same key and payload replays; another payload under the key is refused.
    const replay = await createBatch(pm, p1, P1.start, { "Idempotency-Key": "pay-p1-build-0001" });
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(detail(replay).batch.id).toBe(batchP1.batch.id);
    const reused = await createBatch(pm, p1, P2.start, { "Idempotency-Key": "pay-p1-build-0001" });
    expect([reused.status, problem(reused)]).toEqual([409, "idempotency-key-reused"]);
    const exists = await createBatch(pm, p1, P1.start);
    expect([exists.status, problem(exists)]).toEqual([409, "batch-exists"]);
  });

  it("pays half days, overtime at the rule's multipliers and rest-day work once", async () => {
    const w1 = await payslip(pm, batchP1.batch.id, "W1");
    const overtime = w1.line.earnings.filter((row) => row.kind === "overtime");
    // 07:00–18:00 less the default hour's break: 120 minutes at ×1.50 of KES 1,000 ÷ 8 h.
    expect(overtime.find((row) => row.category === "weekday")).toMatchObject({
      quantity: "120",
      multiplier: "1.50",
      amountMinor: 37_500,
    });
    // Sunday 07:00–12:30 (break after 5 h): 270 minutes, all rest-day overtime at ×2.00, no day pay.
    expect(overtime.find((row) => row.category === "rest_day")).toMatchObject({
      quantity: "270",
      multiplier: "2.00",
      amountMinor: 112_500,
    });
    expect(
      w1.line.earnings.filter((row) => row.date === sundayP1 && row.kind === "attendance"),
    ).toEqual([]);
    const w3 = await payslip(pm, batchP1.batch.id, "W3");
    expect(w3.line.days).toBe("5.5");
    expect(w3.line.earnings.find((row) => row.quantity === "0.5")?.amountMinor).toBe(50_000);
    expect(w1.line.grossMinor).toBe(
      w1.line.earnings.reduce((sum, row) => sum + row.amountMinor, 0),
    );
  });

  it("recalculates drafts with expected versions and refuses stale or production submissions", async () => {
    const wrong = await pm.call("post", `payroll/batches/${batchP2.batch.id}/recalculate`, {
      version: 99,
    });
    expect([wrong.status, problem(wrong)]).toEqual([409, "version-conflict"]);
    // A new allowance changes the inputs: the draft must be recalculated before submission.
    const allowance = await pm.call("post", `payroll/projects/${p1}/allowances`, {
      code: "transport",
      nameEn: "Transport",
      nameSw: "Usafiri",
      basis: "per_day_worked",
      amountMinor: 10_000,
      taxable: true,
      effectiveFrom: addCalendarDays(today, -40),
    });
    expect(allowance.status, JSON.stringify(allowance.body)).toBe(201);
    expect(allowanceResponseSchema.parse(allowance.body).allowance.code).toBe("transport");
    expect((await agent.call("post", `payroll/projects/${p1}/allowances`, {})).status).toBe(400);
    const stale = await pm.call("post", `payroll/batches/${batchP2.batch.id}/submit`, {
      version: batchP2.batch.version,
    });
    expect([stale.status, problem(stale)]).toEqual([409, "batch-stale"]);
    const recalculated = await pm.call("post", `payroll/batches/${batchP2.batch.id}/recalculate`, {
      version: batchP2.batch.version,
    });
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    batchP2 = detail(recalculated);
    expect(batchP2.batch.version).toBe(2);
    expect(lineOf(batchP2, "W1")!.grossMinor).toBe(600_000 + 6 * 10_000);

    // Production refuses batches computed with unverified rules; development marks them.
    const production = vi.spyOn(app.get(PayrollAccess), "production", "get").mockReturnValue(true);
    try {
      const gated = await pm.call("post", `payroll/batches/${batchP2.batch.id}/submit`, {
        version: batchP2.batch.version,
      });
      expect([gated.status, problem(gated)]).toEqual([409, "rules-unverified"]);
      expect((await getBatch(pm, batchP2.batch.id)).production).toBe(true);
    } finally {
      production.mockRestore();
    }
    expect(
      (await foreman.call("post", `payroll/batches/${batchP2.batch.id}/submit`, { version: 2 }))
        .status,
    ).toBe(403);
    const [one, two] = await Promise.all([
      pm.call("post", `payroll/batches/${batchP2.batch.id}/submit`, { version: 2 }),
      pm.call("post", `payroll/batches/${batchP2.batch.id}/submit`, { version: 2 }),
    ]);
    expect([one.status, two.status].sort((a, b) => a - b)).toEqual([200, 409]);
    batchP2 = detail(one.status === 200 ? one : two);
    expect(batchP2.batch).toMatchObject({ status: "submitted", version: 3 });
    expect(batchP2.snapshot).toEqual({ digest: batchP2.batch.digest, verified: true });
    const snapshot = batchSnapshotResponseSchema.parse(
      (await pm.call("get", `payroll/batches/${batchP2.batch.id}/snapshot`)).body,
    );
    expect(snapshot).toMatchObject({ matches: true, digest: batchP2.batch.digest });
    expect((snapshot.snapshot as { lines: unknown[] }).lines).toHaveLength(batchP2.lines.length);

    // A submitted batch never changes, through the API or directly in the database.
    const after = await pm.call("post", `payroll/batches/${batchP2.batch.id}/recalculate`, {
      version: 3,
    });
    expect([after.status, problem(after)]).toEqual([409, "invalid-transition"]);
    await expect(
      readA((tx) => tx.payrollLine.deleteMany({ where: { batchId: batchP2.batch.id } })),
    ).rejects.toThrow();
    await expect(
      readA((tx) =>
        tx.payrollBatch.update({
          where: { tenantId_id: { tenantId: tenantA, id: batchP2.batch.id } },
          data: { netMinor: 1n, version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow();
    // A new rule version cannot take effect inside submitted payroll; nor can an opening rate.
    const closed = await finance.call("post", "payroll/rules", {
      kind: "nita",
      effectiveFrom: P2.start,
      parameters: { employerAmountPerEmployeeMinor: 6_000 },
      sourceReference: "Hypothetical change (test only)",
      notes: "",
    });
    expect([closed.status, problem(closed)]).toEqual([409, "rule-in-closed-period"]);
    const setup = labourSetupResponseSchema.parse((await owner.call("get", "labour/setup")).body);
    const roofer = setup.trades.find((trade) => trade.key === "roofer")!.id;
    const opening = await owner.call("post", "labour/rates", {
      projectId: p1,
      tradeId: roofer,
      basis: "daily",
      rateMinor: 90_000,
      effectiveFrom: P2.start,
    });
    expect([opening.status, problem(opening)]).toEqual([409, "labour-rule"]);
    const laterOpening = await owner.call("post", "labour/rates", {
      projectId: p1,
      tradeId: roofer,
      basis: "daily",
      rateMinor: 90_000,
      effectiveFrom: addCalendarDays(P2.end, 1),
    });
    expect(laterOpening.status, JSON.stringify(laterOpening.body)).toBe(201);
    const second = await owner.call("post", "labour/rates", {
      projectId: p1,
      tradeId: roofer,
      basis: "daily",
      rateMinor: 95_000,
      effectiveFrom: addCalendarDays(P2.end, 2),
    });
    expect([second.status, problem(second)]).toEqual([400, "rate-backdated"]);
  });

  it("subtracts what earlier submitted batches of the month withheld (cumulative method)", async () => {
    const recalculated = await pm.call("post", `payroll/batches/${batchP1.batch.id}/recalculate`, {
      version: batchP1.batch.version,
    });
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    batchP1 = detail(recalculated);
    const sameMonth = batchP1.batch.statutoryMonth === batchP2.batch.statutoryMonth;
    const earlier = await payslip(pm, batchP2.batch.id, "W4");
    const later = await payslip(pm, batchP1.batch.id, "W4");
    expect(later.line.monthToDate.priorBatches).toBe(sameMonth ? 1 : 0);
    const rules = seedRules(batchP1.batch.payDate);
    const base = (slip: typeof earlier) =>
      slip.line.earnings
        .filter((row) => row.taxable)
        .reduce((sum, row) => sum + row.amountMinor, 0);
    const kinds: EmployeeStatutory[] = ["nssf", "shif", "ahl", "paye"];
    const withheld = (slip: typeof earlier, kind: EmployeeStatutory) =>
      slip.line.deductions.find((entry) => entry.kind === kind)!.withheldMinor;
    if (sameMonth) {
      const month = monthlyStatutory(base(earlier) + base(later), rules, "casual");
      for (const kind of kinds)
        expect(withheld(earlier, kind) + withheld(later, kind), kind).toBe(month.employee[kind]);
      expect(later.line.employerCosts.find((entry) => entry.kind === "nita")?.amountMinor).toBe(0);
    } else {
      const month = monthlyStatutory(base(later), rules, "casual");
      for (const kind of kinds) expect(withheld(later, kind), kind).toBe(month.employee[kind]);
    }
  });

  it("never pays attendance and piece rate for the same labourer-day", async () => {
    const recordOutput = (browser: Browser, body: Record<string, unknown>) =>
      browser.call("post", `payroll/projects/${p1}/outputs`, {
        description: "Blockwork 200 mm",
        unit: "m2",
        quantity: "12.5",
        rateMinor: 12_000,
        ...body,
      });
    const date = mondayToFridayP1[0]!;
    expect((await foreman.call("post", `payroll/projects/${p1}/outputs`, {})).status).toBe(400);
    const future = await recordOutput(agent, {
      workDate: addCalendarDays(today, 1),
      labourerId: workers.W3,
    });
    expect([future.status, problem(future)]).toEqual([400, "date-in-future"]);
    const recorded = await recordOutput(agent, { workDate: date, labourerId: workers.W3 });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const output = outputResponseSchema.parse(recorded.body).output;
    expect(output).toMatchObject({ amountMinor: 150_000, status: "pending" });
    const self = await agent.call("post", `payroll/outputs/${output.id}/approve`, { version: 1 });
    expect(self.status).toBe(403);
    const approved = await pm.call("post", `payroll/outputs/${output.id}/approve`, { version: 1 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(outputResponseSchema.parse(approved.body).output.shares).toEqual([
      expect.objectContaining({
        amountMinor: 150_000,
        labourer: expect.objectContaining({ id: workers.W3 }),
      }),
    ]);
    // A gang's output is split equally between the members that day.
    const gang = await pm.call("post", "labour/gangs", {
      projectId: p1,
      name: "Gang P: blockwork",
    });
    expect(gang.status, JSON.stringify(gang.body)).toBe(201);
    const gangId = (gang.body as { gang: { id: string } }).gang.id;
    for (const key of ["W4", "W2"]) {
      const member = await pm.call("post", `labour/gangs/${gangId}/members`, {
        labourerId: workers[key],
        joinedOn: P2.start,
      });
      expect(member.status, JSON.stringify(member.body)).toBe(201);
    }
    const gangOutput = outputResponseSchema.parse(
      (
        await recordOutput(agent, {
          workDate: mondayToFridayP1[1],
          gangId,
          quantity: "10.001",
          rateMinor: 10_001,
        })
      ).body,
    ).output;
    const split = outputResponseSchema.parse(
      (await pm.call("post", `payroll/outputs/${gangOutput.id}/approve`, { version: 1 })).body,
    ).output;
    expect(split.shares.reduce((sum, share) => sum + share.amountMinor, 0)).toBe(split.amountMinor);
    expect(
      Math.abs(split.shares[0]!.amountMinor - split.shares[1]!.amountMinor),
    ).toBeLessThanOrEqual(1);

    // Recalculating the draft: piece rate replaces those labourers' attendance on those days.
    const view = detail(
      await pm.call("post", `payroll/batches/${batchP1.batch.id}/recalculate`, {
        version: batchP1.batch.version,
      }),
    );
    batchP1 = view;
    const w3 = await payslip(pm, batchP1.batch.id, "W3");
    expect(w3.line.earnings.filter((row) => row.date === date).map((row) => row.kind)).toEqual([
      "piece_rate",
    ]);
    expect(lineOf(view, "W3")!.warnings.map((warning) => warning.code)).toContain(
      "attendance-replaced-by-piece-rate",
    );
    // The database refuses an attendance claim for a day piece rate already pays.
    await expect(
      readA((tx) =>
        tx.payrollDayClaim.create({
          data: {
            tenantId: tenantA,
            projectId: p1,
            batchId: batchP1.batch.id,
            labourerId: workers.W3!,
            workDate: day(date),
            basis: "attendance",
          },
        }),
      ),
    ).rejects.toThrow();
    // Output for a day already paid by submitted attendance is left out of later batches.
    const paidDay = workdays(P2)[0]!;
    const late = outputResponseSchema.parse(
      (await recordOutput(agent, { workDate: paidDay, labourerId: workers.W1 })).body,
    ).output;
    expect(
      (await pm.call("post", `payroll/outputs/${late.id}/approve`, { version: 1 })).status,
    ).toBe(200);
    const recalc = detail(
      await pm.call("post", `payroll/batches/${batchP1.batch.id}/recalculate`, {
        version: batchP1.batch.version,
      }),
    );
    batchP1 = recalc;
    expect(recalc.exclusions).toContainEqual(
      expect.objectContaining({
        sourceKind: "piece_rate_share",
        reason: "day-paid-by-attendance",
        date: paidDay,
      }),
    );
    const reject = outputResponseSchema.parse(
      (await recordOutput(agent, { workDate: date, labourerId: workers.W4 })).body,
    ).output;
    const rejected = await pm.call("post", `payroll/outputs/${reject.id}/reject`, {
      version: 1,
      note: "Measured twice by mistake",
    });
    expect(outputResponseSchema.parse(rejected.body).output.status).toBe("rejected");
  });

  it("recovers disbursed advances only, within the cap, and never over-recovers", async () => {
    const request = (browser: Browser, key: string, amountMinor: number, extra = {}) =>
      browser.call("post", `payroll/projects/${p1}/advances`, {
        labourerId: workers[key],
        amountMinor,
        reason: "School fees for the term (test)",
        ...extra,
      });
    const over = await request(foreman, "W1", 600_000);
    expect([over.status, problem(over)]).toEqual([409, "advance-over-limit"]);
    const created = await request(foreman, "W1", 200_000, { instalmentMinor: 150_000 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const advance = advanceResponseSchema.parse(created.body).advance;
    expect(advance).toMatchObject({ status: "requested", displayStatus: "requested" });
    expect(
      (await foreman.call("post", `payroll/advances/${advance.id}/approve`, { version: 1 })).status,
    ).toBe(403);
    const approved = await pm.call("post", `payroll/advances/${advance.id}/approve`, {
      version: 1,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Not yet paid: no batch recovers it.
    const before = detail(
      await pm.call("post", `payroll/batches/${batchP1.batch.id}/recalculate`, {
        version: batchP1.batch.version,
      }),
    );
    batchP1 = before;
    expect(lineOf(before, "W1")!.advanceRecoveryMinor).toBe(0);
    const pay = {
      version: 2,
      method: "cash",
      reference: "PETTY-0001",
      paidOn: P1.start,
      evidenceNote: "Signed petty cash voucher (test)",
    };
    expect((await pm.call("post", `payroll/advances/${advance.id}/disburse`, pay)).status).toBe(
      403,
    );
    await stale(finance);
    const staleMfa = await finance.call("post", `payroll/advances/${advance.id}/disburse`, pay);
    expect([staleMfa.status, problem(staleMfa)]).toEqual([403, "step-up-required"]);
    await fresh(finance);
    const paid = await finance.call("post", `payroll/advances/${advance.id}/disburse`, pay);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(advanceResponseSchema.parse(paid.body).advance.status).toBe("disbursed");
    const after = detail(
      await pm.call("post", `payroll/batches/${batchP1.batch.id}/recalculate`, {
        version: batchP1.batch.version,
      }),
    );
    batchP1 = after;
    const w1 = lineOf(after, "W1")!;
    expect(w1.advanceRecoveryMinor).toBe(150_000);
    expect(w1.netMinor).toBe(w1.grossMinor - w1.statutoryWithheldMinor - 150_000);
    const slip = await payslip(pm, batchP1.batch.id, "W1");
    expect(slip.line.recoveries).toEqual([
      { advanceId: advance.id, amountMinor: 150_000, outstandingAfterMinor: 50_000 },
    ]);
    expect(slip.line.advanceBalanceMinor).toBe(50_000);
    // The database never lets recoveries exceed the advance.
    const line = await readA((tx) =>
      tx.payrollLine.findFirstOrThrow({
        where: { batchId: batchP1.batch.id, labourerId: workers.W2 },
      }),
    );
    await expect(
      readA((tx) =>
        tx.advanceRecovery.create({
          data: {
            tenantId: tenantA,
            batchId: batchP1.batch.id,
            lineId: line.id,
            advanceId: advance.id,
            amountMinor: 100_000n,
            outstandingAfterMinor: 0n,
          },
        }),
      ),
    ).rejects.toThrow();
    // Cancel and reject paths, with maker ≠ checker.
    const second = advanceResponseSchema.parse((await request(agent, "W2", 50_000)).body).advance;
    const cancelled = await agent.call("post", `payroll/advances/${second.id}/cancel`, {
      version: 1,
      reason: "Raised for the wrong labourer",
    });
    expect(advanceResponseSchema.parse(cancelled.body).advance.status).toBe("cancelled");
    const third = advanceResponseSchema.parse((await request(pm, "W3", 50_000)).body).advance;
    const ownDecision = await pm.call("post", `payroll/advances/${third.id}/reject`, {
      version: 1,
      note: "Not justified at this time",
    });
    expect([ownDecision.status, problem(ownDecision)]).toEqual([409, "same-person"]);
    const list = advancesResponseSchema.parse(
      (await finance.call("get", `payroll/advances?projectId=${p1}`)).body,
    );
    expect(list.advances.find((entry) => entry.id === advance.id)?.permissions.canDisburse).toBe(
      false,
    );
    expect((await ownerB.call("get", `payroll/advances?projectId=${p1}`)).status).toBe(404);
  });

  it("cancels a batch, releasing its sources for a new one", async () => {
    const reason = {
      version: batchP1.batch.version,
      reason: "Rebuilding after the advance was recorded",
    };
    expect(
      (
        await pm.call("post", `payroll/batches/${batchP1.batch.id}/cancel`, {
          ...reason,
          reason: "no",
        })
      ).status,
    ).toBe(400);
    const cancelled = await pm.call("post", `payroll/batches/${batchP1.batch.id}/cancel`, reason);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(detail(cancelled).batch.status).toBe("cancelled");
    const released = await readA((tx) =>
      tx.payrollConsumption.count({ where: { batchId: batchP1.batch.id, activeMarker: "active" } }),
    );
    expect(released).toBe(0);
    const rebuilt = await createBatch(pm, p1, P1.start);
    expect(rebuilt.status, JSON.stringify(rebuilt.body)).toBe(201);
    batchP1 = detail(rebuilt);
    expect(batchP1.lines.length).toBeGreaterThan(0);
    const submitted = await pm.call("post", `payroll/batches/${batchP1.batch.id}/submit`, {
      version: batchP1.batch.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    batchP1 = detail(submitted);
    // Project two's week: W2's pay there counts the month's earlier submitted batches too.
    const p2Batch = await createBatch(pm, p2, P1.start);
    if (p2Batch.status === 400) expect(problem(p2Batch)).toBe("period-not-in-calendar");
    else {
      expect(p2Batch.status, JSON.stringify(p2Batch.body)).toBe(201);
      expect(lineOf(detail(p2Batch), "W2")).toBeDefined();
    }
  });

  it("exports monthly statutory CSVs only with payroll.export and step-up, audited without values", async () => {
    const month = batchP2.batch.statutoryMonth;
    expect((await pm.call("get", `payroll/exports?month=${month}`)).status).toBe(403);
    const summary = exportSummaryResponseSchema.parse(
      (await finance.call("get", `payroll/exports?month=${month}`)).body,
    );
    expect(summary.batches.map((batch) => batch.id)).toContain(batchP2.batch.id);
    expect(summary).toMatchObject({ unverified: true, blocked: false, canExport: true });
    expect(summary.missingIdentifiers.kraPin).toBeGreaterThan(0);
    await stale(finance);
    const staleExport = await finance.call("post", "payroll/exports", { month, kind: "paye" });
    expect([staleExport.status, problem(staleExport)]).toEqual([403, "step-up-required"]);
    await fresh(finance);
    const csv = await request(app.getHttpServer())
      .post("/api/v1/payroll/exports")
      .set("Cookie", [...finance.cookies].map(([key, value]) => `${key}=${value}`).join("; "))
      .set("Origin", "http://localhost:3000")
      .set("X-CSRF-Token", finance.csrf)
      .send({ month, kind: "paye" });
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const text = csv.text;
    expect(text).toContain("UNVERIFIED RULES - NOT FOR FILING");
    expect(text).toContain("COMPLIANCE-REVIEW CR-PAY-11");
    expect(text).toContain("A000000001Z");
    for (const kind of ["nssf", "shif", "nita"]) {
      const res = await finance.call("post", "payroll/exports", { month, kind });
      expect(res.status, kind).toBe(200);
    }
    const empty = await finance.call("post", "payroll/exports", { month: "2019-01", kind: "paye" });
    expect([empty.status, problem(empty)]).toEqual([409, "nothing-to-export"]);
    const production = vi.spyOn(app.get(PayrollAccess), "production", "get").mockReturnValue(true);
    try {
      const blocked = await finance.call("post", "payroll/exports", { month, kind: "paye" });
      expect([blocked.status, problem(blocked)]).toEqual([409, "rules-unverified"]);
    } finally {
      production.mockRestore();
    }
    const events = await auditEvents();
    const exportsAudited = events.filter((event) => event.action === "payroll.export_generated");
    expect(exportsAudited.length).toBeGreaterThanOrEqual(4);
    const serialised = JSON.stringify(events);
    for (const secret of ["A000000001Z", "NSSF0001", "SHA0001", "School fees", "Signed petty cash"])
      expect(serialised).not.toContain(secret);
    for (const action of [
      "payroll.rules_installed",
      "payroll.rule_verified",
      "payroll.batch_created",
      "payroll.batch_recalculated",
      "payroll.batch_submitted",
      "payroll.batch_cancelled",
      "payroll.output_approved",
      "advance.requested",
      "advance.disbursed",
    ])
      expect(
        events.map((event) => event.action),
        action,
      ).toContain(action);
    const outbox = await readA((tx) =>
      tx.outboxEvent.findMany({ where: { topic: "payroll.batch_submitted" } }),
    );
    expect(outbox.map((event) => event.aggregateId)).toContain(batchP2.batch.id);
  });

  it("isolates company B from company A's payroll on every new table", async () => {
    await fresh(ownerB);
    for (const [method, path] of [
      ["get", `payroll/batches/${batchP2.batch.id}`],
      ["get", `payroll/projects/${p1}`],
      ["get", `payroll/batches/${batchP2.batch.id}/snapshot`],
      ["get", `payroll/projects/${p1}/allowances`],
      ["get", `payroll/projects/${p1}/outputs`],
    ] as const)
      expect((await ownerB.call(method, path)).status, path).toBe(404);
    const missing = await createBatch(ownerB, pB, payrollWeekStart(today, 4));
    expect([missing.status, problem(missing)]).toEqual([409, "rules-not-configured"]);
    expect(
      payrollRulesResponseSchema.parse((await ownerB.call("get", "payroll/rules")).body).rules,
    ).toEqual([]);
    const inB = as(ownerB, tenantB, "cross-tenant-payroll");
    const userB = ownerB.auth.user.id;
    await db.run(inB, async (tx) => {
      // One query at a time: a transaction's client runs queries sequentially.
      const counts = [
        await tx.payrollSettings.count(),
        await tx.payCalendar.count(),
        await tx.statutoryRuleVersion.count(),
        await tx.minimumWageRate.count(),
        await tx.payrollAllowance.count(),
        await tx.pieceRateOutput.count(),
        await tx.pieceRateOutputShare.count(),
        await tx.salaryAdvance.count(),
        await tx.payrollBatch.count(),
        await tx.payrollLine.count(),
        await tx.payrollEarning.count(),
        await tx.payrollDeduction.count(),
        await tx.advanceRecovery.count(),
        await tx.payrollConsumption.count(),
        await tx.payrollDayClaim.count(),
      ];
      expect(counts).toEqual(Array(15).fill(0));
    });
    const attempts: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      [
        "settings of A",
        (tx) =>
          tx.payrollSettings.create({
            data: {
              tenantId: tenantA,
              advanceMaxMinor: 100n,
              advanceMaxOutstandingMinor: 100n,
              recoveryMaxPercent: "50",
              updatedBy: userB,
            },
          }),
      ],
      [
        "calendar on A's project",
        (tx) =>
          tx.payCalendar.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              frequency: "weekly",
              anchorDate: day(P2.start),
              paydayOffsetDays: 1,
              updatedBy: userB,
            },
          }),
      ],
      [
        "rule in A",
        (tx) =>
          tx.statutoryRuleVersion.create({
            data: {
              tenantId: tenantA,
              kind: "nita",
              effectiveFrom: day("2031-01-01"),
              parameters: { employerAmountPerEmployeeMinor: 1 },
              sourceReference: "Hijack attempt",
              createdBy: userB,
            },
          }),
      ],
      [
        "minimum wage in A",
        (tx) =>
          tx.minimumWageRate.create({
            data: {
              tenantId: tenantA,
              effectiveFrom: day("2031-01-01"),
              area: "cities",
              occupation: "general_labourer",
              monthlyMinor: 1n,
              source: "Hijack attempt",
              createdBy: userB,
            },
          }),
      ],
      [
        "allowance on A's project",
        (tx) =>
          tx.payrollAllowance.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              code: "hijack",
              nameEn: "Hijack",
              nameSw: "Hijack",
              basis: "per_period",
              amountMinor: 1n,
              taxable: true,
              effectiveFrom: day(today),
              createdBy: userB,
            },
          }),
      ],
      [
        "output for A's labourer",
        (tx) =>
          tx.pieceRateOutput.create({
            data: {
              tenantId: tenantB,
              projectId: pB,
              workDate: day(today),
              labourerId: workers.W1!,
              description: "Hijack",
              unit: "m2",
              quantity: "1",
              rateMinor: 1n,
              amountMinor: 1n,
              recordedBy: userB,
            },
          }),
      ],
      [
        "advance for A's labourer",
        (tx) =>
          tx.salaryAdvance.create({
            data: {
              tenantId: tenantB,
              projectId: pB,
              labourerId: workers.W1!,
              amountMinor: 100n,
              reason: "Hijack attempt here",
              requestedBy: userB,
            },
          }),
      ],
      [
        "batch on A's project",
        (tx) =>
          tx.payrollBatch.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              periodStart: day(P2.start),
              periodEnd: day(P2.end),
              payDate: day(addCalendarDays(P2.end, 1)),
              statutoryMonth: statutoryMonthOf(addCalendarDays(P2.end, 1)),
              frequency: "weekly",
              unverifiedRules: true,
              lineCount: 0,
              grossMinor: 0n,
              totalDeductionsMinor: 0n,
              netMinor: 0n,
              employerCostMinor: 0n,
              totals: {},
              exclusions: [],
              digest: "0".repeat(64),
              calculatedBy: userB,
              createdBy: userB,
            },
          }),
      ],
      [
        "consumption of A's line",
        (tx) =>
          tx.payrollConsumption.create({
            data: {
              tenantId: tenantA,
              projectId: p1,
              batchId: batchP2.batch.id,
              sourceKind: "timesheet_line",
              timesheetLineId: batchP2.batch.id,
            },
          }),
      ],
      [
        "day claim in A",
        (tx) =>
          tx.payrollDayClaim.create({
            data: {
              tenantId: tenantA,
              projectId: p1,
              batchId: batchP2.batch.id,
              labourerId: workers.W1!,
              workDate: day(today),
              basis: "attendance",
            },
          }),
      ],
    ];
    for (const [label, attempt] of attempts)
      await expect(db.run(inB, attempt), label).rejects.toThrow();
  });
});

/** The start of the weekly period containing today for a company whose weeks end on `weekEndsOn`. */
function payrollWeekStart(today: string, weekEndsOn: number) {
  const daysToEnd = (weekEndsOn - isoWeekday(today) + 7) % 7;
  return addCalendarDays(addCalendarDays(today, daysToEnd), -6);
}
