import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addCalendarDays, isoWeekday, nairobiDate } from "@pm-buddy/domain";
import { CURRENT_CONSENT_NOTICE, DEMO_TIMESHEET_RULE } from "@pm-buddy/types";
import {
  adjustmentResponseSchema,
  anomaliesResponseSchema,
  attendanceSettingsResponseSchema,
  correctionResponseSchema,
  labourerAttendanceResponseSchema,
  labourerResponseSchema,
  labourSetupResponseSchema,
  musterResponseSchema,
  periodDetailResponseSchema,
  periodsResponseSchema,
  projectResponseSchema,
  siteResponseSchema,
  timesheetLinesResponseSchema,
  type MusterResponse,
  type PeriodDetailResponse,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import { Browser, notifications } from "./support.js";

type Method = "get" | "post" | "patch" | "put" | "delete";
const ruiru = { lat: -1.1489, lng: 36.9612 };
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("Attendance and timesheets (real runtime role)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let pm: Browser;
  let agent: Browser;
  let foreman: Browser;
  let tenantA: string;
  let tenantB: string;
  let p1: string;
  let p2: string;
  let p1Main: string;
  let p1Yard: string;
  let p2Site: string;
  let seq = 0;
  const workers: Record<string, string> = {};
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const today = nairobiDate();
  // Periods end tomorrow's weekday, so the current period is never due during the run.
  const weekEndsOn = isoWeekday(addCalendarDays(today, 1));
  const periodB = { start: addCalendarDays(today, -19), end: addCalendarDays(today, -13) };
  const periodA = { start: addCalendarDays(today, -12), end: addCalendarDays(today, -6) };
  const periodC = { start: addCalendarDays(today, -26), end: addCalendarDays(today, -20) };
  const datesOf = (period: { start: string }) =>
    Array.from({ length: 7 }, (_, index) => addCalendarDays(period.start, index));
  const sunday = datesOf(periodB).find((date) => isoWeekday(date) === 7)!;
  const weekdaysB = datesOf(periodB).filter((date) => isoWeekday(date) !== 7);
  const holiday = weekdaysB[2]!;
  const wd1 = weekdaysB[0]!;
  const wd2 = weekdaysB[1]!;
  const dA = datesOf(periodA).find((date) => isoWeekday(date) !== 7)!;
  const dA2 = datesOf(periodA).filter((date) => isoWeekday(date) !== 7)[1]!;
  const dC = datesOf(periodC).find((date) => isoWeekday(date) !== 7)!;

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
  /** Direct database reads of company A under the runtime role (RLS needs the tenant context). */
  const readA = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.run(as(owner, tenantA, "e2e-read"), query);
  const muster = (res: request.Response) => musterResponseSchema.parse(res.body);
  const period = (res: request.Response) => periodDetailResponseSchema.parse(res.body);
  const row = (view: MusterResponse, key: string) =>
    view.rows.find((entry) => entry.labourer.id === workers[key]);
  const line = (view: PeriodDetailResponse, key: string, kind = "attendance") =>
    view.lines.find((entry) => entry.labourerId === workers[key] && entry.kind === kind);

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
  /** Registers a synthetic labourer engaged on `projectId` from 40 days ago. */
  const register = async (
    browser: Browser,
    key: string,
    projectId: string | undefined,
    setup: { trade: string; level: string },
    extra: Record<string, unknown> = {},
  ) => {
    seq += 1;
    const n = String(seq).padStart(7, "0");
    const res = await browser.call("post", "labour/labourers", {
      fullName: `Mfanyakazi Majaribio ${key}`,
      dateOfBirth: "1990-05-17",
      gender: "male",
      tradeId: setup.trade,
      skillLevelId: setup.level,
      engagementType: "casual",
      rateBasis: "daily",
      idType: "national_id",
      idNumber: `8${n}`,
      ...(projectId ? { projectId, engagementStartDate: addCalendarDays(today, -40) } : {}),
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
    return workers[key];
  };
  const entry = (key: string, values: Record<string, unknown>, version = 0) => ({
    labourerId: workers[key],
    version,
    ...values,
  });
  const present = (checkIn = "07:00", checkOut = "16:00", extra: Record<string, unknown> = {}) => ({
    status: "present",
    checkIn,
    checkOut,
    ...extra,
  });
  const getMuster = async (browser: Browser, projectId: string, siteId: string, date: string) => {
    const res = await browser.call(
      "get",
      `attendance/projects/${projectId}/muster?siteId=${siteId}&date=${date}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return muster(res);
  };
  const save = async (
    browser: Browser,
    projectId: string,
    siteId: string,
    date: string,
    entries: object[],
    headers: Record<string, string> = {},
  ) => {
    const current = await getMuster(browser, projectId, siteId, date);
    return browser.call(
      "put",
      `attendance/projects/${projectId}/muster`,
      { siteId, date, dayVersion: current.day?.version ?? 0, entries },
      true,
      headers,
    );
  };
  /** Records, submits (recorder) and confirms (confirmer) a day. */
  const recordDay = async (
    recorder: Browser,
    confirmer: Browser | null,
    projectId: string,
    siteId: string,
    date: string,
    entries: object[],
  ) => {
    const saved = await save(recorder, projectId, siteId, date, entries);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const view = muster(saved);
    const submitted = await recorder.call("post", `attendance/days/${view.day!.id}/submit`, {
      version: view.day!.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    if (!confirmer) return muster(submitted);
    const confirmed = await confirmer.call("post", `attendance/days/${view.day!.id}/confirm`, {
      version: muster(submitted).day!.version,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return muster(confirmed);
  };
  const periodFor = async (browser: Browser, projectId: string, date: string) => {
    const res = await browser.call("get", `attendance/projects/${projectId}/periods`);
    expect(res.status).toBe(200);
    const found = periodsResponseSchema
      .parse(res.body)
      .periods.find((item) => item.period.startDate <= date && item.period.endDate >= date);
    expect(found, date).toBeDefined();
    return found!.period;
  };
  const openAnomalies = async (browser: Browser, projectId: string) => {
    const res = await browser.call(
      "get",
      `attendance/anomalies?projectId=${projectId}&status=open`,
    );
    expect(res.status).toBe(200);
    return anomaliesResponseSchema.parse(res.body).anomalies;
  };
  /** Every audit event of company A (the API lists only the latest 100). */
  const auditEvents = () =>
    db.run(as(owner, tenantA, "audit-check"), (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA },
        select: { action: true, metadata: true },
      }),
    );

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
    for (const browser of [owner, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [pm, agent, foreman]) await browser.register();
    const a = await owner.call("post", "tenants", { name: "Attendance company A" });
    const b = await ownerB.call("post", "tenants", { name: "Attendance company B" });
    expect([a.status, b.status]).toEqual([201, 201]);
    tenantA = (a.body as { tenant: { id: string } }).tenant.id;
    tenantB = (b.body as { tenant: { id: string } }).tenant.id;
    await fresh(owner);
    p1 = projectResponseSchema.parse(
      (await owner.call("post", "projects", { code: "ATT-ONE", name: "Attendance one" })).body,
    ).project.id;
    p2 = projectResponseSchema.parse(
      (await owner.call("post", "projects", { code: "ATT-TWO", name: "Attendance two" })).body,
    ).project.id;
    p1Main = await site(owner, p1, "Main plot", 0);
    p1Yard = await site(owner, p1, "Yard", 300);
    p2Site = await site(owner, p2, "Second plot", 900);
    await join(pm, "project_manager", [p1]);
    await join(agent, "site_agent", [p1]);
    await join(foreman, "foreman", [p1]);

    const setup = labourSetupResponseSchema.parse(
      (await owner.call("post", "labour/setup/defaults", {})).body,
    );
    const general = {
      trade: setup.trades.find((trade) => trade.key === "general_labourer")!.id,
      level: setup.skillLevels.find((level) => level.key === "unskilled")!.id,
    };
    const skilled = {
      trade: setup.trades.find((trade) => trade.key === "mason")!.id,
      level: setup.skillLevels.find((level) => level.key === "skilled")!.id,
    };
    for (const key of ["W1", "W2", "W3", "W5", "W6", "W7"]) await register(owner, key, p1, general);
    await register(owner, "W4", p1, general);
    await register(owner, "W8", p1, skilled);
    await register(owner, "LATE", undefined, general);
    // W4 and W1 also work on project two.
    for (const key of ["W4", "W1"]) {
      const engaged = await owner.call("post", `labour/labourers/${workers[key]}/engagements`, {
        projectId: p2,
        startDate: addCalendarDays(today, -40),
      });
      expect(engaged.status, JSON.stringify(engaged.body)).toBe(201);
    }
    // LATE is engaged on project one only from yesterday.
    const late = await owner.call("post", `labour/labourers/${workers.LATE}/engagements`, {
      projectId: p1,
      startDate: addCalendarDays(today, -1),
    });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    const ownerSetupB = labourSetupResponseSchema.parse(
      (await ownerB.call("post", "labour/setup/defaults", {})).body,
    );
    expect(ownerSetupB.trades.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents every attendance operation in OpenAPI", async () => {
    const openApi = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (openApi.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "getAttendanceOverview",
      "getAttendanceSettings",
      "updatePeriodSettings",
      "createTimesheetRule",
      "installDefaultTimesheetRule",
      "deleteTimesheetRule",
      "createPublicHoliday",
      "installPublicHolidays",
      "deletePublicHoliday",
      "getMuster",
      "saveMuster",
      "submitAttendanceDay",
      "confirmAttendanceDay",
      "returnAttendanceDay",
      "createAttendanceCorrection",
      "listAttendanceCorrections",
      "approveAttendanceCorrection",
      "rejectAttendanceCorrection",
      "listAttendanceAnomalies",
      "reviewAttendanceAnomaly",
      "listTimesheetPeriods",
      "getTimesheetPeriod",
      "getTimesheetLines",
      "submitTimesheetPeriod",
      "approveTimesheetPeriod",
      "rejectTimesheetPeriod",
      "reopenTimesheetPeriod",
      "createTimesheetAdjustment",
      "listTimesheetAdjustments",
      "approveTimesheetAdjustment",
      "rejectTimesheetAdjustment",
      "getLabourerAttendance",
    ])
      expect(operations, id).toContain(id);
  });

  it("configures rules, the cut-off and the holiday calendar by permission", async () => {
    const settings = await pm.call("get", "attendance/settings");
    expect(settings.status).toBe(200);
    const view = attendanceSettingsResponseSchema.parse(settings.body);
    expect(view.canConfigure).toBe(false);
    expect(view.ruleProjects.map((project) => project.id)).toEqual([p1]);
    expect(view.periodSettings).toMatchObject({
      weekEndsOn: 4,
      cutoffTime: "18:00",
      paydayWeekday: 5,
      version: 0,
    });
    const rule = (overrides: Record<string, unknown> = {}) => {
      const { sourceReference, ...values } = DEMO_TIMESHEET_RULE;
      return {
        ...values,
        restDays: [7],
        sourceReference,
        effectiveFrom: addCalendarDays(today, -60),
        ...overrides,
      };
    };
    expect((await agent.call("post", "attendance/rules", rule())).status).toBe(403);
    expect((await agent.call("post", "attendance/rules", rule({ projectId: p1 }))).status).toBe(
      403,
    );
    expect((await pm.call("post", "attendance/rules", rule())).status).toBe(403);
    expect((await foreman.call("post", "attendance/rules/defaults", {})).status).toBe(403);
    // Q-C3 demonstration values, installed as the unverified company default.
    const installed = await owner.call("post", "attendance/rules/defaults", {});
    expect(installed.status, JSON.stringify(installed.body)).toBe(200);
    const defaults = attendanceSettingsResponseSchema.parse(installed.body).rules;
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      projectId: null,
      effectiveFrom: today,
      normalMinutes: 480,
      otWeekdayMultiplier: "1.50",
      otRestDayMultiplier: "2.00",
      otHolidayMultiplier: "2.00",
      complianceStatus: "unverified",
      inForce: true,
    });
    // A company version for the earlier days the tests record (backdating is allowed while no
    // submitted or approved period would be affected).
    const company = await owner.call("post", "attendance/rules", rule());
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    expect((await owner.call("post", "attendance/rules", rule())).status).toBe(409);
    expect(problem(await owner.call("post", "attendance/rules", rule()))).toBe("rule-exists");
    const invalid = await owner.call(
      "post",
      "attendance/rules",
      rule({ halfDayThresholdMinutes: 500, effectiveFrom: addCalendarDays(today, 3) }),
    );
    expect(invalid.status).toBe(400);
    expect(
      (
        await owner.call(
          "post",
          "attendance/rules",
          rule({ otWeekdayMultiplier: "1.5", effectiveFrom: addCalendarDays(today, 3) }),
        )
      ).status,
    ).toBe(400);
    // A project manager adds a project override; the most specific scope wins.
    const override = await pm.call(
      "post",
      "attendance/rules",
      rule({ projectId: p1, effectiveFrom: addCalendarDays(today, 30), normalMinutes: 540 }),
    );
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    const overrideId = (override.body as { rule: { id: string; scheduled: boolean } }).rule;
    expect(overrideId.scheduled).toBe(true);
    // Only a version that has not started can be cancelled.
    expect((await pm.call("delete", `attendance/rules/${overrideId.id}`)).status).toBe(200);
    const inForce = attendanceSettingsResponseSchema
      .parse((await owner.call("get", "attendance/settings")).body)
      .rules.find((entry) => entry.effectiveFrom === today)!;
    expect(problem(await owner.call("delete", `attendance/rules/${inForce.id}`))).toBe(
      "rule-in-force",
    );

    // Period settings: weekly, ending tomorrow's weekday at 18:00 for this test run.
    expect(
      (
        await pm.call("put", "attendance/settings/periods", {
          weekEndsOn,
          cutoffTime: "18:00",
          paydayWeekday: 5,
          version: 0,
        })
      ).status,
    ).toBe(403);
    const periods = await owner.call("put", "attendance/settings/periods", {
      weekEndsOn,
      cutoffTime: "18:00",
      paydayWeekday: 5,
      version: 0,
    });
    expect(periods.status, JSON.stringify(periods.body)).toBe(200);
    expect(attendanceSettingsResponseSchema.parse(periods.body).periodSettings.version).toBe(1);
    expect(
      problem(
        await owner.call("put", "attendance/settings/periods", {
          weekEndsOn,
          cutoffTime: "18:00",
          paydayWeekday: 5,
          version: 0,
        }),
      ),
    ).toBe("version-conflict");

    // The Kenyan calendar, then a company holiday inside period B.
    expect((await pm.call("post", "attendance/holidays/defaults", {})).status).toBe(403);
    const calendar = await owner.call("post", "attendance/holidays/defaults", {});
    expect(calendar.status).toBe(200);
    const holidays = attendanceSettingsResponseSchema.parse(calendar.body).holidays;
    expect(holidays.find((entry) => entry.date === "2026-03-20")?.nameEn).toBe("Idd-ul-Fitr");
    expect(holidays.find((entry) => entry.date === "2027-12-13")?.kind).toBe("observed");
    const again = attendanceSettingsResponseSchema.parse(
      (await owner.call("post", "attendance/holidays/defaults", {})).body,
    );
    expect(again.holidays).toHaveLength(holidays.length);
    // Keep the tested weeks free of real public holidays so day types are predictable.
    for (const entry of holidays.filter(
      (candidate) =>
        candidate.date >= addCalendarDays(today, -30) &&
        candidate.date <= addCalendarDays(today, 2),
    ))
      expect((await owner.call("delete", `attendance/holidays/${entry.id}`)).status).toBe(200);
    const added = await owner.call("post", "attendance/holidays", {
      date: holiday,
      nameEn: "Test site holiday",
      nameSw: "Sikukuu ya majaribio",
      kind: "company",
      source: "Company decision (e2e test)",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(
      problem(
        await owner.call("post", "attendance/holidays", {
          date: holiday,
          nameEn: "Duplicate",
          nameSw: "Nakala",
          kind: "company",
          source: "Company decision",
        }),
      ),
    ).toBe("holiday-exists");
    const temporary = await owner.call("post", "attendance/holidays", {
      date: addCalendarDays(today, 200),
      nameEn: "Temporary",
      nameSw: "Ya muda",
      kind: "company",
      source: "Company decision",
    });
    const temporaryId = (temporary.body as { holiday: { id: string } }).holiday.id;
    expect((await pm.call("delete", `attendance/holidays/${temporaryId}`)).status).toBe(403);
    expect((await owner.call("delete", `attendance/holidays/${temporaryId}`)).status).toBe(200);
  });

  it("records a muster roll for engaged labourers only, with versions and validation", async () => {
    const view = await getMuster(foreman, p1, p1Main, dA2);
    expect(view.day).toBeNull();
    expect(view.editable).toBe(true);
    expect(view.dayType).toBe("weekday");
    expect(view.rule?.normalMinutes).toBe(480);
    expect(view.period.id).toBeNull();
    const listed = view.rows.map((entry) => entry.labourer.id);
    expect(listed).toContain(workers.W1);
    expect(listed).not.toContain(workers.LATE);
    // The project manager may view but not record.
    expect(
      (
        await pm.call("put", `attendance/projects/${p1}/muster`, {
          siteId: p1Main,
          date: dA2,
          dayVersion: 0,
          entries: [entry("W1", present())],
        })
      ).status,
    ).toBe(403);
    const notEngaged = await save(foreman, p1, p1Main, dA2, [entry("LATE", present())]);
    expect(notEngaged.status).toBe(409);
    expect(problem(notEngaged)).toBe("not-engaged");
    expect((notEngaged.body as { match?: { labourerId: string } }).match?.labourerId).toBe(
      workers.LATE,
    );
    expect(
      (await save(foreman, p1, p1Main, dA2, [entry("W1", present("16:00", "07:00"))])).status,
    ).toBe(400);
    expect(
      (await save(foreman, p1, p1Main, dA2, [entry("W1", { status: "absent", checkIn: "07:00" })]))
        .status,
    ).toBe(400);
    expect(
      problem(await save(foreman, p1, p1Main, addCalendarDays(today, 1), [entry("W1", present())])),
    ).toBe("date-in-future");
    expect(
      problem(
        await foreman.call("put", `attendance/projects/${p1}/muster`, {
          siteId: p2Site,
          date: dA2,
          dayVersion: 0,
          entries: [entry("W1", present())],
        }),
      ),
    ).toBe("site-not-in-project");

    // W5 works far longer than plausible; W2 is absent with a note.
    const saved = await save(foreman, p1, p1Main, dA2, [
      entry("W5", present("05:00", "20:00")),
      entry("W2", { status: "absent", notes: "Sent word through the foreman" }),
      entry("W6", present()),
      entry("W8", present()),
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = muster(saved);
    expect(after.day).toMatchObject({ status: "draft", version: 2 });
    expect(after.period.id).not.toBeNull();
    const w5 = row(after, "W5")!;
    expect(w5.record).toMatchObject({
      status: "present",
      checkIn: "05:00",
      checkOut: "20:00",
      captureMethod: "web_manual",
      version: 1,
      computed: { workedMinutes: 840, normalMinutes: 480, overtimeMinutes: 360, halfDays: 2 },
    });
    expect(w5.anomalies.map((anomaly) => anomaly.kind)).toEqual(["excess_hours"]);
    expect(row(after, "W2")!.record).toMatchObject({ status: "absent", checkIn: null });
    expect(row(after, "W8")!.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      "accreditation_invalid",
    ]);
    // Stale versions are refused (the day and the record).
    expect(
      problem(
        await foreman.call("put", `attendance/projects/${p1}/muster`, {
          siteId: p1Main,
          date: dA2,
          dayVersion: 1,
          entries: [entry("W1", present())],
        }),
      ),
    ).toBe("version-conflict");
    expect(problem(await save(foreman, p1, p1Main, dA2, [entry("W5", present(), 0)]))).toBe(
      "version-conflict",
    );
    // Fixing the times clears the excess-hours flag.
    const fixed = await save(foreman, p1, p1Main, dA2, [entry("W5", present(), 1)]);
    expect(fixed.status).toBe(200);
    expect(row(muster(fixed), "W5")!.anomalies).toEqual([]);
    const cleared = await readA((tx) =>
      tx.attendanceAnomaly.findMany({
        where: { recordId: row(muster(fixed), "W5")!.record!.id },
      }),
    );
    expect(cleared.map((anomaly) => [anomaly.kind, anomaly.status])).toEqual([
      ["excess_hours", "cleared"],
    ]);
  });

  it("makes commands idempotent with keys bound to caller and payload", async () => {
    const current = await getMuster(foreman, p1, p1Yard, dA2);
    const body = {
      siteId: p1Yard,
      date: dA2,
      dayVersion: current.day?.version ?? 0,
      entries: [entry("W3", present("07:00", "15:00"))],
    };
    const key = { "Idempotency-Key": "muster-yard-0001" };
    const first = await foreman.call("put", `attendance/projects/${p1}/muster`, body, true, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await foreman.call("put", `attendance/projects/${p1}/muster`, body, true, key);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(
      await readA((tx) =>
        tx.attendanceRecord.count({ where: { siteId: p1Yard, labourerId: workers.W3 } }),
      ),
    ).toBe(1);
    const changed = await foreman.call(
      "put",
      `attendance/projects/${p1}/muster`,
      { ...body, entries: [entry("W3", present("07:00", "16:00"))] },
      true,
      key,
    );
    expect(changed.status).toBe(409);
    expect(problem(changed)).toBe("idempotency-key-reused");
    // Another person cannot replay someone else's key either.
    const other = await agent.call("put", `attendance/projects/${p1}/muster`, body, true, key);
    expect(problem(other)).toBe("idempotency-key-reused");
    const invalid = await foreman.call("put", `attendance/projects/${p1}/muster`, body, true, {
      "Idempotency-Key": "short",
    });
    expect(problem(invalid)).toBe("invalid-idempotency-key");
  });

  it("requires a different person to confirm a submitted day (maker ≠ checker)", async () => {
    const view = await getMuster(foreman, p1, p1Main, dA2);
    const submitted = await foreman.call("post", `attendance/days/${view.day!.id}/submit`, {
      version: view.day!.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const day = muster(submitted).day!;
    expect(day.status).toBe("submitted");
    expect(muster(submitted).locked).toBe("day-submitted");
    // A submitted day is no longer edited directly.
    expect(problem(await save(foreman, p1, p1Main, dA2, [entry("W1", present())]))).toBe(
      "day-not-draft",
    );
    // The foreman cannot confirm (no attendance.confirm); the confirmer cannot be a recorder.
    expect(
      (await foreman.call("post", `attendance/days/${day.id}/confirm`, { version: day.version }))
        .status,
    ).toBe(403);
    const yard = await recordDay(agent, null, p1, p1Yard, dA, [entry("W2", present())]);
    const own = await agent.call("post", `attendance/days/${yard.day!.id}/confirm`, {
      version: yard.day!.version,
    });
    expect(own.status).toBe(409);
    expect(problem(own)).toBe("same-person");
    // The submitter cannot return their own day either; someone else returns it with a reason.
    expect(
      problem(
        await agent.call("post", `attendance/days/${yard.day!.id}/return`, {
          version: yard.day!.version,
          reason: "Please add the yard crew",
        }),
      ),
    ).toBe("same-person");
    const returned = await pm.call("post", `attendance/days/${yard.day!.id}/return`, {
      version: yard.day!.version,
      reason: "Please add the yard crew",
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    expect(muster(returned).day).toMatchObject({
      status: "draft",
      submittedBy: null,
      returnReason: "Please add the yard crew",
    });
    // The project manager confirms the foreman's day; stale versions are refused.
    expect(
      problem(
        await pm.call("post", `attendance/days/${day.id}/confirm`, { version: day.version - 1 }),
      ),
    ).toBe("version-conflict");
    const confirmed = await pm.call("post", `attendance/days/${day.id}/confirm`, {
      version: day.version,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(muster(confirmed).day).toMatchObject({ status: "confirmed" });
    expect(muster(confirmed).day!.confirmedBy?.id).toBe(pm.auth.user.id);
    const outbox = await readA((tx) => tx.outboxEvent.findMany({ where: { aggregateId: day.id } }));
    expect(outbox.map((event) => event.topic)).toEqual(["attendance.day_confirmed"]);
    // The database refuses the same person on both sides, and edits of a confirmed day.
    const inA = as(owner, tenantA, "maker-checker");
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceDay.update({
          where: { id: yard.day!.id },
          data: { status: "submitted", submittedBy: agent.auth.user.id, version: { increment: 1 } },
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceDay.update({
          where: { id: yard.day!.id },
          data: { status: "confirmed", confirmedBy: agent.auth.user.id, version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceRecord.updateMany({
          where: { dayId: day.id },
          data: { notes: "Edited behind the API", version: { increment: 1 } },
        }),
      ),
    ).rejects.toThrow();
    // Return it to draft through the API for later tests.
    const yardNow = await getMuster(pm, p1, p1Yard, dA);
    expect(
      (
        await pm.call("post", `attendance/days/${yard.day!.id}/return`, {
          version: yardNow.day!.version,
          reason: "Recorded in the second test step",
        })
      ).status,
    ).toBe(200);
  });

  it("stores web entries without capture evidence and refuses impossible shifts in the database", async () => {
    const view = await getMuster(foreman, p1, p1Main, dA2);
    const record = row(view, "W1")?.record ?? row(view, "W5")!.record!;
    const inA = as(owner, tenantA, "capture-evidence");
    // Evidence columns are reserved for the site app, kiosk and terminals.
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceRecord.create({
          data: {
            tenantId: tenantA,
            dayId: view.day!.id,
            projectId: p1,
            siteId: p1Main,
            workDate: day(dA2),
            labourerId: workers.W7!,
            status: "present",
            checkInMinutes: 420,
            checkOutMinutes: 960,
            latitude: "-1.148900",
            longitude: "36.961200",
            createdBy: owner.auth.user.id,
            updatedBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    const draft = await getMuster(foreman, p1, p1Yard, dA);
    for (const data of [
      { status: "present", checkInMinutes: 960, checkOutMinutes: 420 },
      { status: "absent", checkInMinutes: 420, checkOutMinutes: null },
      { status: "present", checkInMinutes: 420, checkOutMinutes: 960, breakMinutes: 540 },
    ])
      await expect(
        db.run(inA, (tx) =>
          tx.attendanceRecord.create({
            data: {
              tenantId: tenantA,
              dayId: draft.day!.id,
              projectId: p1,
              siteId: p1Yard,
              workDate: day(dA),
              labourerId: workers.W7!,
              ...data,
              createdBy: owner.auth.user.id,
              updatedBy: owner.auth.user.id,
            } as Prisma.AttendanceRecordUncheckedCreateInput,
          }),
        ),
      ).rejects.toThrow();
    // A labourer not engaged that day cannot be stored even by direct SQL.
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceRecord.create({
          data: {
            tenantId: tenantA,
            dayId: draft.day!.id,
            projectId: p1,
            siteId: p1Yard,
            workDate: day(dA),
            labourerId: workers.LATE!,
            status: "absent",
            createdBy: owner.auth.user.id,
            updatedBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    // Identity and capture method never change.
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceRecord.update({
          where: { id: record.id },
          data: { captureMethod: "face" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("flags two sites, overlapping times, inactive and do-not-rehire labourers", async () => {
    // W6 is made inactive; W7 is flagged do not rehire.
    const w6 = labourerResponseSchema.parse(
      (await owner.call("get", `labour/labourers/${workers.W6}`)).body,
    ).labourer;
    expect(
      (
        await owner.call("post", `labour/labourers/${workers.W6}/status`, {
          to: "inactive",
          reason: "Sick leave pending documents",
          version: w6.version,
        })
      ).status,
    ).toBe(200);
    const w7 = labourerResponseSchema.parse(
      (await owner.call("get", `labour/labourers/${workers.W7}`)).body,
    ).labourer;
    await fresh(owner);
    expect(
      (
        await owner.call("put", `labour/labourers/${workers.W7}/do-not-rehire`, {
          flagged: true,
          reason: "Synthetic test case for attendance flags",
          version: w7.version,
        })
      ).status,
    ).toBe(200);
    const saved = await save(foreman, p1, p1Main, dA, [
      entry("W4", present("07:00", "12:00")),
      entry("W6", present()),
      entry("W7", present()),
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(row(muster(saved), "W6")!.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      "labourer_inactive",
    ]);
    expect(row(muster(saved), "W7")!.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      "do_not_rehire",
    ]);
    // The owner records W4 on project two the same day, overlapping the morning.
    const other = await save(owner, p2, p2Site, dA, [entry("W4", present("11:00", "17:00"))]);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const w4 = row(muster(other), "W4")!;
    expect(w4.anomalies.map((anomaly) => anomaly.kind).sort()).toEqual([
      "overlapping_times",
      "two_sites",
    ]);
    expect(w4.otherSites).toEqual([
      { siteId: p1Main, siteName: "Main plot", projectCode: "ATT-ONE", status: "present" },
    ]);
    const onP1 = await getMuster(foreman, p1, p1Main, dA);
    expect(
      row(onP1, "W4")!
        .anomalies.map((anomaly) => anomaly.kind)
        .sort(),
    ).toEqual(["overlapping_times", "two_sites"]);
    // The day is counted once: 540 worked minutes, two half days shared between the projects.
    expect(row(onP1, "W4")!.record!.computed).toMatchObject({ workedMinutes: 300, halfDays: 1 });
    expect(w4.record!.computed).toMatchObject({
      workedMinutes: 240,
      normalMinutes: 180,
      overtimeMinutes: 60,
      halfDays: 1,
    });

    const list = await openAnomalies(pm, p1);
    expect(list.map((anomaly) => anomaly.kind)).toEqual(
      expect.arrayContaining([
        "two_sites",
        "overlapping_times",
        "labourer_inactive",
        "do_not_rehire",
      ]),
    );
    const twoSites = list.find(
      (anomaly) => anomaly.kind === "two_sites" && anomaly.labourerId === workers.W4,
    )!;
    expect(twoSites).toMatchObject({ severity: "critical", projectCode: "ATT-ONE" });
    // Review needs attendance.review_anomalies, a reason and someone who did not record it.
    expect(
      (
        await foreman.call("post", `attendance/anomalies/${twoSites.id}/review`, {
          decision: "dismiss",
          note: "Checked with the gate book",
          version: twoSites.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await pm.call("post", `attendance/anomalies/${twoSites.id}/review`, {
          decision: "dismiss",
          note: "short",
          version: twoSites.version,
        })
      ).status,
    ).toBe(400);
    const onP2 = (await openAnomalies(owner, p2)).find((anomaly) => anomaly.kind === "two_sites")!;
    expect(
      problem(
        await owner.call("post", `attendance/anomalies/${onP2.id}/review`, {
          decision: "resolve",
          note: "I recorded this myself",
          version: onP2.version,
        }),
      ),
    ).toBe("same-person");
    const dismissed = await pm.call("post", `attendance/anomalies/${twoSites.id}/review`, {
      decision: "dismiss",
      note: "Morning on plot one, afternoon on plot two",
      version: twoSites.version,
    });
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(dismissed.body).toMatchObject({
      anomaly: { status: "dismissed", reviewedBy: { id: pm.auth.user.id } },
    });
    expect(
      problem(
        await pm.call("post", `attendance/anomalies/${twoSites.id}/review`, {
          decision: "resolve",
          note: "Second decision attempt",
          version: twoSites.version + 1,
        }),
      ),
    ).toBe("invalid-transition");
    // A dismissed finding stays dismissed while its record does not change, even when the
    // labourer's day is evaluated again because another record changed.
    const renote = await save(owner, p2, p2Site, dA, [
      entry("W4", present("11:00", "17:00", { notes: "Same times, note added" }), 1),
    ]);
    expect(renote.status, JSON.stringify(renote.body)).toBe(200);
    await save(foreman, p1, p1Main, dA, [entry("W6", { status: "leave" }, 1)]);
    const still = await readA((tx) =>
      tx.attendanceAnomaly.findMany({
        where: { recordId: twoSites.recordId, kind: "two_sites" },
      }),
    );
    expect(still.map((anomaly) => anomaly.status)).toEqual(["dismissed"]);
    // Leave is not worked time: the inactive flag clears.
    expect(row(await getMuster(foreman, p1, p1Main, dA), "W6")!.anomalies).toEqual([]);
  });

  it("corrects a confirmed day only with a reason, step-up and a second person", async () => {
    const view = await getMuster(pm, p1, p1Main, dA2);
    expect(view.day!.status).toBe("confirmed");
    const record = row(view, "W2")!.record!;
    const body = {
      labourerId: workers.W2,
      status: "present",
      checkIn: "07:00",
      checkOut: "16:00",
      reason: "Gate book shows he worked the full day",
      recordVersion: record.version,
    };
    // The project manager holds attendance.override but has no MFA to step up with.
    expect(
      problem(await pm.call("post", `attendance/days/${view.day!.id}/corrections`, body)),
    ).toBe("mfa-required");
    expect(
      (await foreman.call("post", `attendance/days/${view.day!.id}/corrections`, body)).status,
    ).toBe(403);
    await stale(owner);
    expect(
      problem(await owner.call("post", `attendance/days/${view.day!.id}/corrections`, body)),
    ).toBe("step-up-required");
    await fresh(owner);
    expect(
      (
        await owner.call("post", `attendance/days/${view.day!.id}/corrections`, {
          ...body,
          reason: "Too short",
        })
      ).status,
    ).toBe(400);
    const requested = await owner.call("post", `attendance/days/${view.day!.id}/corrections`, body);
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const correction = correctionResponseSchema.parse(requested.body).correction;
    expect(correction).toMatchObject({
      status: "pending",
      previous: { status: "absent" },
      proposed: { status: "present", checkIn: "07:00" },
    });
    // Flagged for review; the record is unchanged until someone else approves.
    const flagged = await getMuster(pm, p1, p1Main, dA2);
    expect(row(flagged, "W2")!.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      "manual_override",
    ]);
    expect(row(flagged, "W2")!.record!.status).toBe("absent");
    expect(flagged.corrections.map((entry) => entry.status)).toEqual(["pending"]);
    expect(
      problem(await owner.call("post", `attendance/days/${view.day!.id}/corrections`, body)),
    ).toBe("correction-pending");
    const override = (await openAnomalies(pm, p1)).find(
      (anomaly) => anomaly.kind === "manual_override",
    )!;
    expect(
      problem(
        await pm.call("post", `attendance/anomalies/${override.id}/review`, {
          decision: "resolve",
          note: "Resolved through the anomaly list",
          version: override.version,
        }),
      ),
    ).toBe("use-correction");
    expect(
      problem(
        await owner.call("post", `attendance/corrections/${correction.id}/approve`, {
          version: correction.version,
        }),
      ),
    ).toBe("same-person");
    expect(
      (
        await foreman.call("post", `attendance/corrections/${correction.id}/approve`, {
          version: correction.version,
        })
      ).status,
    ).toBe(403);
    const approved = await pm.call("post", `attendance/corrections/${correction.id}/approve`, {
      version: correction.version,
      note: "Checked the gate book",
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      correction: { status: "approved", decidedBy: { id: pm.auth.user.id } },
    });
    const corrected = row(await getMuster(pm, p1, p1Main, dA2), "W2")!;
    expect(corrected.record).toMatchObject({ status: "present", corrected: true });
    expect(corrected.anomalies).toEqual([]);

    // A rejected correction leaves the record as it was.
    const second = await owner.call("post", `attendance/days/${view.day!.id}/corrections`, {
      ...body,
      checkOut: "18:00",
      reason: "Claimed overtime not in the gate book",
      recordVersion: corrected.record!.version,
    });
    expect(second.status).toBe(201);
    const secondId = correctionResponseSchema.parse(second.body).correction;
    expect(
      (
        await pm.call("post", `attendance/corrections/${secondId.id}/reject`, {
          version: secondId.version,
          note: "short",
        })
      ).status,
    ).toBe(400);
    const rejected = await pm.call("post", `attendance/corrections/${secondId.id}/reject`, {
      version: secondId.version,
      note: "No evidence of overtime that evening",
    });
    expect(rejected.body).toMatchObject({ correction: { status: "rejected" } });
    expect(row(await getMuster(pm, p1, p1Main, dA2), "W2")!.record!.checkOut).toBe("16:00");
    // Draft days are edited directly, not corrected.
    const draft = await getMuster(pm, p1, p1Yard, dA);
    expect(
      problem(
        await owner.call("post", `attendance/days/${draft.day!.id}/corrections`, {
          ...body,
          recordVersion: 0,
        }),
      ),
    ).toBe("correction-not-needed");
    const listed = await pm.call("get", `attendance/projects/${p1}/corrections`);
    expect(listed.status).toBe(200);
    expect((listed.body as { corrections: unknown[] }).corrections).toHaveLength(2);
  });

  it("computes the timesheet and walks the period: cut-off, submit, approve, snapshot, lock", async () => {
    // Period B: a long weekday, a Sunday, a public holiday, a half day, a late arrival.
    await recordDay(foreman, pm, p1, p1Main, wd1, [
      entry("W1", present("07:00", "18:00")),
      entry("W2", { status: "half_day", checkIn: "07:00", checkOut: "11:00" }),
      entry("W3", { status: "absent" }),
    ]);
    await recordDay(foreman, pm, p1, p1Main, wd2, [
      entry("W2", present("07:30", "16:00")),
      entry("W3", { status: "leave" }),
    ]);
    await recordDay(foreman, pm, p1, p1Main, sunday, [entry("W1", present("07:00", "12:00"))]);
    const draftHoliday = await save(foreman, p1, p1Main, holiday, [entry("W1", present())]);
    expect(muster(draftHoliday).dayType).toBe("public_holiday");
    expect(muster(draftHoliday).holiday?.nameEn).toBe("Test site holiday");

    const target = await periodFor(pm, p1, wd1);
    expect(target).toMatchObject({
      startDate: periodB.start,
      endDate: periodB.end,
      status: "open",
      due: true,
    });
    const live = period(await pm.call("get", `attendance/periods/${target.id}`));
    expect(live.source).toBe("live");
    expect(live.blockers.unconfirmedDays.map((entry) => entry.date)).toEqual([holiday]);
    expect(live.blockers.rulesUnverified).toBe(true);
    expect(line(live, "W1")!.totals).toMatchObject({
      days: "3",
      halfDays: 6,
      workedMinutes: 1380,
      normalMinutes: 480,
      overtimeMinutes: { weekday: 120, rest_day: 300, public_holiday: 480 },
    });
    expect(line(live, "W2")!.totals).toMatchObject({
      days: "1.5",
      halfDays: 3,
      workedMinutes: 690,
      normalMinutes: 690,
      lateMinutes: 30,
      statusCounts: { present: 1, half_day: 1 },
    });
    expect(line(live, "W3")!.totals).toMatchObject({
      halfDays: 0,
      statusCounts: { absent: 1, leave: 1 },
    });
    expect(
      problem(
        await agent.call("post", `attendance/periods/${target.id}/submit`, {
          version: target.version,
        }),
      ),
    ).toBe("unconfirmed-days");
    const holidayDay = await getMuster(foreman, p1, p1Main, holiday);
    const submittedDay = await foreman.call(
      "post",
      `attendance/days/${holidayDay.day!.id}/submit`,
      {
        version: holidayDay.day!.version,
      },
    );
    await pm.call("post", `attendance/days/${holidayDay.day!.id}/confirm`, {
      version: muster(submittedDay).day!.version,
    });
    // The current period is not due yet; a foreman cannot submit periods at all.
    const current = await (async () => {
      await save(foreman, p1, p1Main, today, [entry("W1", present())]);
      return periodFor(pm, p1, today);
    })();
    expect(current.due).toBe(false);
    expect(
      problem(
        await agent.call("post", `attendance/periods/${current.id}/submit`, {
          version: current.version,
        }),
      ),
    ).toBe("period-not-due");
    expect(
      (
        await foreman.call("post", `attendance/periods/${target.id}/submit`, {
          version: target.version,
        })
      ).status,
    ).toBe(403);

    const submitted = await agent.call("post", `attendance/periods/${target.id}/submit`, {
      version: target.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const pending = period(submitted);
    expect(pending.period).toMatchObject({
      status: "submitted",
      submittedBy: { id: agent.auth.user.id },
    });
    expect(pending.period.submittedDigest).toMatch(/^[0-9a-f]{64}$/);
    // Locked while submitted: no recording, no rules or holidays inside it.
    expect(problem(await save(foreman, p1, p1Yard, wd1, [entry("W1", present())]))).toBe(
      "period-locked",
    );
    expect(
      problem(
        await owner.call("post", "attendance/holidays", {
          date: wd2,
          nameEn: "Late holiday",
          nameSw: "Sikukuu ya kuchelewa",
          kind: "company",
          source: "Company decision",
        }),
      ),
    ).toBe("period-locked");
    const { sourceReference, ...values } = DEMO_TIMESHEET_RULE;
    expect(
      problem(
        await owner.call("post", "attendance/rules", {
          ...values,
          restDays: [6, 7],
          sourceReference,
          effectiveFrom: wd1,
        }),
      ),
    ).toBe("period-locked");
    // The submitter cannot approve; the site agent cannot approve at all.
    expect(
      (
        await agent.call("post", `attendance/periods/${target.id}/approve`, {
          version: pending.period.version,
        })
      ).status,
    ).toBe(403);
    // Open anomalies block approval (W8 skilled without a card on wd1? none here), so approve.
    const approved = await pm.call("post", `attendance/periods/${target.id}/approve`, {
      version: pending.period.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const locked = period(approved);
    expect(locked.source).toBe("snapshot");
    expect(locked.period).toMatchObject({
      status: "approved",
      approvedBy: { id: pm.auth.user.id },
    });
    expect(line(locked, "W1")!.totals).toEqual(line(live, "W1")!.totals);
    expect(line(locked, "W1")!.ruleVersionIds).toHaveLength(1);
    expect(line(locked, "W1")!.recordIds).toHaveLength(3);
    const lines = await pm.call("get", `attendance/periods/${target.id}/lines`);
    expect(lines.status).toBe(200);
    const payroll = timesheetLinesResponseSchema.parse(lines.body);
    expect(payroll.lines).toEqual(locked.lines);
    expect(payroll.ruleVersions[0]).toMatchObject({ otWeekdayMultiplier: "1.50" });
    expect(payroll.holidays.map((entry) => entry.date)).toEqual([holiday]);
    expect(
      (await readA((tx) => tx.outboxEvent.findMany({ where: { aggregateId: target.id } }))).map(
        (event) => event.topic,
      ),
    ).toEqual(["timesheet.period_approved"]);
    // After approval: the muster is locked and late attendance must become an adjustment.
    expect((await getMuster(foreman, p1, p1Main, wd1)).locked).toBe("period-approved");
    expect(problem(await save(foreman, p1, p1Yard, wd2, [entry("W1", present())]))).toBe(
      "period-locked",
    );
    expect(problem(await pm.call("get", `attendance/periods/${current.id}/lines`))).toBe(
      "period-not-approved",
    );
    // The database refuses changes to the approved period, its records and its snapshot.
    const inA = as(owner, tenantA, "locked-period");
    await expect(
      db.run(inA, (tx) =>
        tx.timesheetPeriod.update({ where: { id: target.id }, data: { status: "open" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) =>
        tx.attendanceRecord.updateMany({
          where: { workDate: day(wd1), projectId: p1 },
          data: { notes: "Late edit" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) =>
        tx.timesheetLine.updateMany({ where: { periodId: target.id }, data: { halfDays: 99 } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) => tx.timesheetLine.deleteMany({ where: { periodId: target.id } })),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) =>
        tx.timesheetLine.create({
          data: {
            tenantId: tenantA,
            projectId: p1,
            periodId: current.id!,
            labourerId: workers.W1!,
            lineKey: "attendance",
            kind: "attendance",
            halfDays: 2,
            workedMinutes: 480,
            normalMinutes: 480,
            otWeekdayMinutes: 0,
            otRestDayMinutes: 0,
            otHolidayMinutes: 0,
            lateMinutes: 0,
            presentCount: 1,
            halfDayCount: 0,
            absentCount: 0,
            leaveCount: 0,
            sickCount: 0,
            days: [],
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(inA, (tx) =>
        tx.timesheetRuleVersion.create({
          data: {
            tenantId: tenantA,
            effectiveFrom: day(wd1),
            ...values,
            restDays: [7],
            sourceReference,
            createdBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("binds approval to the submitted content and supports reject and reopen", async () => {
    await recordDay(foreman, pm, p1, p1Main, dC, [entry("W1", present())]);
    const target = await periodFor(agent, p1, dC);
    const submitted = await agent.call("post", `attendance/periods/${target.id}/submit`, {
      version: target.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const submittedPeriod = period(submitted).period;
    // The site agent holds no timesheets.approve.
    expect(
      (
        await agent.call("post", `attendance/periods/${target.id}/reject`, {
          version: submittedPeriod.version,
          reason: "Wrong week chosen",
        })
      ).status,
    ).toBe(403);
    // W1 also worked on project two earlier that morning: the project-one share changes.
    const morning = await save(owner, p2, p2Site, dC, [entry("W1", present("05:00", "07:00"))]);
    expect(morning.status, JSON.stringify(morning.body)).toBe(200);
    expect(
      problem(
        await pm.call("post", `attendance/periods/${target.id}/approve`, {
          version: submittedPeriod.version,
        }),
      ),
    ).toBe("open-anomalies");
    for (const anomaly of (await openAnomalies(pm, p1)).filter((entry) => entry.date === dC))
      expect(
        (
          await pm.call("post", `attendance/anomalies/${anomaly.id}/review`, {
            decision: "dismiss",
            note: "Early pour on plot two, then plot one",
            version: anomaly.version,
          })
        ).status,
      ).toBe(200);
    const changed = await pm.call("post", `attendance/periods/${target.id}/approve`, {
      version: submittedPeriod.version,
    });
    expect(changed.status).toBe(409);
    expect(problem(changed)).toBe("period-changed");
    const rejected = await pm.call("post", `attendance/periods/${target.id}/reject`, {
      version: submittedPeriod.version,
      reason: "Recompute after the plot-two record",
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const rejectedPeriod = period(rejected).period;
    expect(rejectedPeriod).toMatchObject({
      status: "rejected",
      rejectionReason: "Recompute after the plot-two record",
    });
    expect(
      problem(
        await agent.call("post", `attendance/periods/${target.id}/submit`, {
          version: rejectedPeriod.version,
        }),
      ),
    ).toBe("invalid-transition");
    const reopened = await agent.call("post", `attendance/periods/${target.id}/reopen`, {
      version: rejectedPeriod.version,
    });
    expect(reopened.status).toBe(200);
    const resubmitted = await agent.call("post", `attendance/periods/${target.id}/submit`, {
      version: period(reopened).period.version,
    });
    expect(resubmitted.status, JSON.stringify(resubmitted.body)).toBe(200);
    expect(line(period(resubmitted), "W1")!.totals).toMatchObject({
      normalMinutes: 360,
      overtimeMinutes: { weekday: 120 },
    });
    const approved = await pm.call("post", `attendance/periods/${target.id}/approve`, {
      version: period(resubmitted).period.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Project two's period now gets only what remains of W1's day: never paid twice.
    const p2Period = await periodFor(owner, p2, dC);
    const p2View = period(await owner.call("get", `attendance/periods/${p2Period.id}`));
    expect(line(p2View, "W1")!.totals).toMatchObject({ normalMinutes: 120, halfDays: 0 });

    // Whoever submits a period can neither approve nor reject it (period A, by the PM).
    const confirmDay = async (
      submitter: Browser,
      confirmer: Browser,
      siteId: string,
      date: string,
    ) => {
      const view = await getMuster(submitter, p1, siteId, date);
      if (view.day!.status === "confirmed") return;
      let version = view.day!.version;
      if (view.day!.status === "draft") {
        const submittedDay = await submitter.call(
          "post",
          `attendance/days/${view.day!.id}/submit`,
          {
            version,
          },
        );
        expect(submittedDay.status, JSON.stringify(submittedDay.body)).toBe(200);
        version = muster(submittedDay).day!.version;
      }
      const confirmed = await confirmer.call("post", `attendance/days/${view.day!.id}/confirm`, {
        version,
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    };
    await confirmDay(foreman, agent, p1Main, dA);
    await confirmDay(agent, pm, p1Yard, dA);
    await confirmDay(foreman, agent, p1Yard, dA2);
    const periodANow = await periodFor(pm, p1, dA);
    const byPm = await pm.call("post", `attendance/periods/${periodANow.id}/submit`, {
      version: periodANow.version,
    });
    expect(byPm.status, JSON.stringify(byPm.body)).toBe(200);
    const versionA = period(byPm).period.version;
    expect(
      problem(
        await pm.call("post", `attendance/periods/${periodANow.id}/approve`, { version: versionA }),
      ),
    ).toBe("same-person");
    expect(
      problem(
        await pm.call("post", `attendance/periods/${periodANow.id}/reject`, {
          version: versionA,
          reason: "Rejecting my own submission",
        }),
      ),
    ).toBe("same-person");
    expect(period(byPm).permissions.canApprove).toBe(false);
  });

  it("adjusts an approved period without touching it (late attendance)", async () => {
    const original = await periodFor(pm, p1, wd1);
    expect(original.status).toBe("approved");
    const before = await readA((tx) =>
      tx.timesheetLine.findMany({
        where: { periodId: original.id },
        orderBy: { id: "asc" },
      }),
    );
    const body = {
      labourerId: workers.W3,
      siteId: p1Main,
      date: wd1,
      status: "present",
      checkIn: "07:00",
      checkOut: "16:00",
      reason: "Signed in on the paper roll; the clerk missed it",
    };
    expect(
      (await pm.call("post", `attendance/periods/${original.id}/adjustments`, body)).status,
    ).toBe(403);
    await fresh(owner);
    const current = await periodFor(pm, p1, today);
    expect(
      problem(
        await owner.call("post", `attendance/periods/${current.id}/adjustments`, {
          ...body,
          date: today,
        }),
      ),
    ).toBe("period-not-approved");
    expect(
      problem(
        await owner.call("post", `attendance/periods/${original.id}/adjustments`, {
          ...body,
          date: dA,
        }),
      ),
    ).toBe("date-outside-period");
    const requested = await owner.call(
      "post",
      `attendance/periods/${original.id}/adjustments`,
      body,
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const adjustment = adjustmentResponseSchema.parse(requested.body).adjustment;
    expect(adjustment).toMatchObject({
      status: "pending",
      previous: { status: "absent" },
      delta: null,
      targetPeriodId: null,
    });
    expect(
      problem(await owner.call("post", `attendance/periods/${original.id}/adjustments`, body)),
    ).toBe("adjustment-pending");
    expect(
      problem(
        await owner.call("post", `attendance/adjustments/${adjustment.id}/approve`, {
          version: adjustment.version,
        }),
      ),
    ).toBe("same-person");
    expect(
      (
        await agent.call("post", `attendance/adjustments/${adjustment.id}/approve`, {
          version: adjustment.version,
        })
      ).status,
    ).toBe(403);
    const approved = await pm.call("post", `attendance/adjustments/${adjustment.id}/approve`, {
      version: adjustment.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const decided = adjustmentResponseSchema.parse(approved.body).adjustment;
    expect(decided).toMatchObject({ status: "approved", targetPeriodId: current.id });
    expect(decided.delta).toMatchObject({
      halfDays: 2,
      workedMinutes: 480,
      normalMinutes: 480,
      statusCounts: { present: 1, absent: -1 },
    });
    // The approved period and its snapshot are unchanged.
    expect(
      await readA((tx) =>
        tx.timesheetLine.findMany({
          where: { periodId: original.id },
          orderBy: { id: "asc" },
        }),
      ),
    ).toEqual(before);
    const originalView = period(await pm.call("get", `attendance/periods/${original.id}`));
    expect(originalView.adjustments.requested.map((entry) => entry.status)).toEqual(["approved"]);
    // The delta lands in the current open period as an adjustment line.
    const landed = period(await pm.call("get", `attendance/periods/${current.id}`));
    expect(line(landed, "W3", "adjustment")).toMatchObject({
      adjustmentId: adjustment.id,
      originalPeriodId: original.id,
      totals: { halfDays: 2, normalMinutes: 480 },
    });
    expect(landed.adjustments.landed.map((entry) => entry.id)).toEqual([adjustment.id]);
    // A second adjustment for the same day starts from the adjusted values.
    const again = await owner.call("post", `attendance/periods/${original.id}/adjustments`, {
      ...body,
      checkOut: "18:00",
      reason: "Stayed for the evening pour as well",
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const second = adjustmentResponseSchema.parse(again.body).adjustment;
    expect(second.previous).toMatchObject({ status: "present", checkOut: "16:00" });
    const secondApproved = adjustmentResponseSchema.parse(
      (
        await pm.call("post", `attendance/adjustments/${second.id}/approve`, {
          version: second.version,
        })
      ).body,
    ).adjustment;
    expect(secondApproved.delta).toMatchObject({
      halfDays: 0,
      workedMinutes: 120,
      normalMinutes: 0,
      overtimeMinutes: { weekday: 120 },
    });
    // Rejections need a reason.
    const third = adjustmentResponseSchema.parse(
      (
        await owner.call("post", `attendance/periods/${original.id}/adjustments`, {
          ...body,
          labourerId: workers.W2,
          date: wd2,
          checkOut: "19:00",
          reason: "Claimed hours not on the roll",
        })
      ).body,
    ).adjustment;
    const rejected = await pm.call("post", `attendance/adjustments/${third.id}/reject`, {
      version: third.version,
      note: "No supporting evidence for the claim",
    });
    expect(rejected.body).toMatchObject({ adjustment: { status: "rejected", delta: null } });
    // Two simultaneous approvals of the same adjustment: exactly one lands (brief §15 I).
    const fourth = adjustmentResponseSchema.parse(
      (
        await owner.call("post", `attendance/periods/${original.id}/adjustments`, {
          ...body,
          labourerId: workers.W1,
          date: wd2,
          reason: "Worked on the yard, missed from the roll",
        })
      ).body,
    ).adjustment;
    const racing = await Promise.all([
      pm.call("post", `attendance/adjustments/${fourth.id}/approve`, { version: fourth.version }),
      pm.call("post", `attendance/adjustments/${fourth.id}/approve`, { version: fourth.version }),
    ]);
    expect(racing.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const landedTwice = period(await pm.call("get", `attendance/periods/${current.id}`));
    expect(landedTwice.lines.filter((entry) => entry.adjustmentId === fourth.id)).toHaveLength(1);
    const list = await pm.call("get", `attendance/projects/${p1}/adjustments`);
    expect((list.body as { adjustments: unknown[] }).adjustments).toHaveLength(4);
    // The database refuses an adjustment for an open period and a self-approved one.
    const inA = as(owner, tenantA, "adjustment-db");
    await expect(
      db.run(inA, (tx) =>
        tx.timesheetAdjustment.create({
          data: {
            tenantId: tenantA,
            projectId: p1,
            originalPeriodId: current.id!,
            labourerId: workers.W1!,
            siteId: p1Main,
            workDate: day(today),
            proposed: { status: "absent" },
            reason: "Direct insert for an open period",
            requestedBy: owner.auth.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("summarises a labourer's attendance and scopes reads to the caller's projects", async () => {
    const summary = await pm.call("get", `attendance/labourers/${workers.W1}/summary`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const parsed = labourerAttendanceResponseSchema.parse(summary.body);
    const onP1 = parsed.projects.find((project) => project.projectId === p1)!;
    expect(onP1.approved.halfDays).toBeGreaterThanOrEqual(6);
    expect(onP1.lastWorkedOn).toBe(today);
    // The project manager is assigned to project one only.
    expect(parsed.projects.map((project) => project.projectId)).toEqual([p1]);
    expect(
      (await foreman.call("get", `attendance/projects/${p2}/muster?siteId=${p2Site}&date=${dA}`))
        .status,
    ).toBe(403);
    expect((await foreman.call("get", `attendance/projects/${p2}/periods`)).status).toBe(403);
    const overview = await foreman.call("get", "attendance/overview");
    expect(overview.status).toBe(200);
    expect(
      (overview.body as { projects: { id: string }[] }).projects.map((project) => project.id),
    ).toEqual([p1]);
  });

  it("isolates company B from company A's attendance data on every new table", async () => {
    const view = await getMuster(pm, p1, p1Main, dA2);
    const periods = periodsResponseSchema.parse(
      (await pm.call("get", `attendance/projects/${p1}/periods`)).body,
    ).periods;
    const approved = periods.find((item) => item.period.status === "approved")!.period;
    const correction = await readA((tx) =>
      tx.attendanceCorrection.findFirstOrThrow({
        where: { tenantId: tenantA },
      }),
    );
    const anomaly = await readA((tx) =>
      tx.attendanceAnomaly.findFirstOrThrow({
        where: { tenantId: tenantA, status: "open" },
      }),
    );
    const adjustment = await readA((tx) =>
      tx.timesheetAdjustment.findFirstOrThrow({ where: { tenantId: tenantA } }),
    );
    const rule = await readA((tx) =>
      tx.timesheetRuleVersion.findFirstOrThrow({
        where: { tenantId: tenantA },
      }),
    );
    const holidayRow = await readA((tx) =>
      tx.publicHoliday.findFirstOrThrow({
        where: { tenantId: tenantA },
      }),
    );
    await fresh(ownerB);
    const guesses: [Method, string, object?][] = [
      ["get", `attendance/projects/${p1}/muster?siteId=${p1Main}&date=${dA2}`],
      [
        "put",
        `attendance/projects/${p1}/muster`,
        { siteId: p1Main, date: dA2, dayVersion: 0, entries: [entry("W1", present())] },
      ],
      ["post", `attendance/days/${view.day!.id}/submit`, { version: 1 }],
      ["post", `attendance/days/${view.day!.id}/confirm`, { version: 1 }],
      [
        "post",
        `attendance/days/${view.day!.id}/return`,
        { version: 1, reason: "Cross-company attempt" },
      ],
      [
        "post",
        `attendance/days/${view.day!.id}/corrections`,
        {
          labourerId: workers.W1,
          status: "absent",
          reason: "Cross-company attempt",
          recordVersion: 0,
        },
      ],
      ["get", `attendance/projects/${p1}/corrections`],
      ["post", `attendance/corrections/${correction.id}/approve`, { version: correction.version }],
      [
        "post",
        `attendance/corrections/${correction.id}/reject`,
        { version: correction.version, note: "Cross-company attempt" },
      ],
      [
        "post",
        `attendance/anomalies/${anomaly.id}/review`,
        { decision: "dismiss", note: "Cross-company attempt", version: anomaly.version },
      ],
      ["get", `attendance/projects/${p1}/periods`],
      ["get", `attendance/periods/${approved.id}`],
      ["get", `attendance/periods/${approved.id}/lines`],
      ["post", `attendance/periods/${approved.id}/submit`, { version: approved.version }],
      ["post", `attendance/periods/${approved.id}/approve`, { version: approved.version }],
      [
        "post",
        `attendance/periods/${approved.id}/reject`,
        { version: approved.version, reason: "Cross-company attempt" },
      ],
      ["post", `attendance/periods/${approved.id}/reopen`, { version: approved.version }],
      [
        "post",
        `attendance/periods/${approved.id}/adjustments`,
        {
          labourerId: workers.W1,
          siteId: p1Main,
          date: wd1,
          status: "absent",
          reason: "Cross-company attempt",
        },
      ],
      ["get", `attendance/projects/${p1}/adjustments`],
      ["post", `attendance/adjustments/${adjustment.id}/approve`, { version: adjustment.version }],
      [
        "post",
        `attendance/adjustments/${adjustment.id}/reject`,
        { version: adjustment.version, note: "Cross-company attempt" },
      ],
      ["delete", `attendance/rules/${rule.id}`],
      ["delete", `attendance/holidays/${holidayRow.id}`],
      ["get", `attendance/labourers/${workers.W1}/summary`],
    ];
    for (const [method, path, body] of guesses) {
      const res = await ownerB.call(method, path, body);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    const bAnomalies = anomaliesResponseSchema.parse(
      (await ownerB.call("get", `attendance/anomalies?projectId=${p1}`)).body,
    );
    expect(bAnomalies.anomalies).toEqual([]);
    const bSettings = attendanceSettingsResponseSchema.parse(
      (await ownerB.call("get", "attendance/settings")).body,
    );
    expect(bSettings.rules).toEqual([]);
    expect(bSettings.holidays).toEqual([]);

    const inB = as(ownerB, tenantB, "cross-tenant-attendance");
    const userB = ownerB.auth.user.id;
    await db.run(inB, async (tx) => {
      expect(await tx.attendanceSettings.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.timesheetRuleVersion.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.publicHoliday.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.timesheetPeriod.findMany({ where: { id: approved.id } })).toEqual([]);
      expect(await tx.attendanceDay.findMany({ where: { id: view.day!.id } })).toEqual([]);
      expect(await tx.attendanceRecord.findMany({ where: { projectId: p1 } })).toEqual([]);
      expect(await tx.attendanceCorrection.findMany({ where: { id: correction.id } })).toEqual([]);
      expect(await tx.attendanceAnomaly.findMany({ where: { id: anomaly.id } })).toEqual([]);
      expect(await tx.timesheetLine.findMany({ where: { periodId: approved.id } })).toEqual([]);
      expect(await tx.timesheetAdjustment.findMany({ where: { id: adjustment.id } })).toEqual([]);
      expect(await tx.idempotencyRecord.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(await tx.outboxEvent.findMany({ where: { tenantId: tenantA } })).toEqual([]);
      expect(
        await tx.attendanceRecord.updateMany({
          where: { projectId: p1 },
          data: { notes: "Hijack" },
        }),
      ).toEqual({ count: 0 });
    });
    const attempts: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      [
        "settings of A",
        (tx) => tx.attendanceSettings.create({ data: { tenantId: tenantA, updatedBy: userB } }),
      ],
      [
        "holiday in A",
        (tx) =>
          tx.publicHoliday.create({
            data: {
              tenantId: tenantA,
              holidayDate: day("2030-01-02"),
              nameEn: "Hijack",
              nameSw: "Hijack",
              kind: "company",
              source: "Hijack",
              createdBy: userB,
            },
          }),
      ],
      [
        "rule in A",
        (tx) =>
          tx.timesheetRuleVersion.create({
            data: {
              tenantId: tenantA,
              effectiveFrom: day("2030-01-02"),
              ...ruleValues(),
              restDays: [7],
              sourceReference: "Hijack",
              createdBy: userB,
            },
          }),
      ],
      [
        "B rule for A's project",
        (tx) =>
          tx.timesheetRuleVersion.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              effectiveFrom: day("2030-01-02"),
              ...ruleValues(),
              restDays: [7],
              sourceReference: "Hijack",
              createdBy: userB,
            },
          }),
      ],
      [
        "period on A's project",
        (tx) =>
          tx.timesheetPeriod.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              startDate: day("2030-01-02"),
              endDate: day("2030-01-08"),
              cutoffAt: new Date("2030-01-08T15:00:00Z"),
              createdBy: userB,
            },
          }),
      ],
      [
        "period in A",
        (tx) =>
          tx.timesheetPeriod.create({
            data: {
              tenantId: tenantA,
              projectId: p1,
              startDate: day("2030-01-02"),
              endDate: day("2030-01-08"),
              cutoffAt: new Date("2030-01-08T15:00:00Z"),
              createdBy: userB,
            },
          }),
      ],
      [
        "day on A's site",
        (tx) =>
          tx.attendanceDay.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              siteId: p1Main,
              workDate: day(today),
              periodId: approved.id,
              createdBy: userB,
            },
          }),
      ],
      [
        "record for A's labourer",
        (tx) =>
          tx.attendanceRecord.create({
            data: {
              tenantId: tenantB,
              dayId: view.day!.id,
              projectId: p1,
              siteId: p1Main,
              workDate: day(dA2),
              labourerId: workers.W1!,
              status: "absent",
              createdBy: userB,
              updatedBy: userB,
            },
          }),
      ],
      [
        "correction of A's day",
        (tx) =>
          tx.attendanceCorrection.create({
            data: {
              tenantId: tenantB,
              dayId: view.day!.id,
              siteId: p1Main,
              workDate: day(dA2),
              labourerId: workers.W1!,
              proposed: {},
              reason: "Hijack attempt here",
              requestedBy: userB,
            },
          }),
      ],
      [
        "anomaly on A's record",
        (tx) =>
          tx.attendanceAnomaly.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              siteId: p1Main,
              recordId: anomaly.recordId,
              labourerId: workers.W1!,
              workDate: day(dA2),
              kind: "two_sites",
              severity: "critical",
            },
          }),
      ],
      [
        "line for A's period",
        (tx) =>
          tx.timesheetLine.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              periodId: approved.id,
              labourerId: workers.W1!,
              lineKey: "attendance",
              kind: "attendance",
              halfDays: 0,
              workedMinutes: 0,
              normalMinutes: 0,
              otWeekdayMinutes: 0,
              otRestDayMinutes: 0,
              otHolidayMinutes: 0,
              lateMinutes: 0,
              presentCount: 0,
              halfDayCount: 0,
              absentCount: 0,
              leaveCount: 0,
              sickCount: 0,
              days: [],
            },
          }),
      ],
      [
        "adjustment of A's period",
        (tx) =>
          tx.timesheetAdjustment.create({
            data: {
              tenantId: tenantB,
              projectId: p1,
              originalPeriodId: approved.id,
              labourerId: workers.W1!,
              siteId: p1Main,
              workDate: day(wd1),
              proposed: {},
              reason: "Hijack attempt here",
              requestedBy: userB,
            },
          }),
      ],
      [
        "idempotency key in A",
        (tx) =>
          tx.idempotencyRecord.create({
            data: {
              tenantId: tenantA,
              operation: "attendance.hijack",
              idempotencyKey: "hijack-key-01",
              userId: userB,
              fingerprint: "0".repeat(64),
              response: {},
            },
          }),
      ],
      [
        "outbox event in A",
        (tx) =>
          tx.outboxEvent.create({
            data: { tenantId: tenantA, topic: "attendance.hijack", aggregateId: approved.id },
          }),
      ],
    ];
    for (const [label, attempt] of attempts)
      await expect(db.run(inB, attempt), label).rejects.toThrow();
  });

  it("keeps reasons and notes out of the audit log and audits every command", async () => {
    const events = await auditEvents();
    const actions = new Set(events.map((event) => event.action));
    for (const action of [
      "attendance.muster_saved",
      "attendance.day_submitted",
      "attendance.day_confirmed",
      "attendance.day_returned",
      "attendance.correction_requested",
      "attendance.correction_approved",
      "attendance.correction_rejected",
      "attendance.anomaly_dismissed",
      "timesheet.period_created",
      "timesheet.period_submitted",
      "timesheet.period_approved",
      "timesheet.period_rejected",
      "timesheet.period_reopened",
      "timesheet.adjustment_requested",
      "timesheet.adjustment_approved",
      "timesheet.adjustment_rejected",
      "timesheet.rule_created",
      "timesheet.rule_deleted",
      "attendance.settings_updated",
      "attendance.holiday_added",
      "attendance.holiday_removed",
      "attendance.holidays_installed",
    ])
      expect(actions, action).toContain(action);
    const text = JSON.stringify(events.map((event) => event.metadata ?? {}));
    for (const secret of [
      "Gate book shows he worked the full day",
      "Signed in on the paper roll",
      "Sent word through the foreman",
      "Morning on plot one",
      "Recompute after the plot-two record",
      "Please add the yard crew",
    ])
      expect(text).not.toContain(secret);
  });
});

function ruleValues() {
  const { sourceReference: _source, restDays: _restDays, ...values } = DEMO_TIMESHEET_RULE;
  return values;
}
