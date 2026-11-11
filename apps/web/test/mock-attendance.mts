/**
 * Attendance and timesheet (D3.3 web slice) routes of the Playwright mock API (see mock-api.mts).
 * Requests are parsed with the shared request schemas, commands must carry an Idempotency-Key,
 * and every reply names its shared response schema, so the browser suite also checks the wire
 * contract. Hours come from the shared domain rules (computeLabourerDay, detectDayAnomalies), so
 * the screens show the same arithmetic as the API. The mock clock is fixed: today is Tuesday
 * 10/11/2026 (Africa/Nairobi). Synthetic data only.
 */
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  addCalendarDays,
  addTotals,
  computeLabourerDay,
  dayTypeOf,
  detectDayAnomalies,
  emptyTotals,
  formatHalfDays,
  parseClock,
  resolveTimesheetRule,
  subtractTotals,
  sumDays,
  timesheetDays,
  weeklyPeriodFor,
  zonedDateTime,
  type DayRecord,
  type LabourerDayResult,
  type TimesheetTotals,
} from "@pm-buddy/domain";
import {
  ANOMALY_SEVERITY,
  AUTOMATIC_ADJUSTMENT_REASON,
  DEMO_TIMESHEET_RULE,
  KENYA_PUBLIC_HOLIDAYS,
  PROJECT_STATUSES,
  type AnomalyKind,
  type IsoWeekday,
  type Permission,
} from "@pm-buddy/types";
import {
  adjustmentResponseSchema,
  adjustmentsResponseSchema,
  anomaliesResponseSchema,
  anomalyResponseSchema,
  approveDecisionRequestSchema,
  attendanceOverviewResponseSchema,
  attendanceSettingsResponseSchema,
  correctionResponseSchema,
  correctionsResponseSchema,
  createAdjustmentRequestSchema,
  createCorrectionRequestSchema,
  createHolidayRequestSchema,
  createTimesheetRuleRequestSchema,
  dayActionRequestSchema,
  holidayResponseSchema,
  labourerAttendanceResponseSchema,
  messageResponseSchema,
  musterResponseSchema,
  periodActionRequestSchema,
  periodDetailResponseSchema,
  periodsResponseSchema,
  rejectDecisionRequestSchema,
  rejectPeriodRequestSchema,
  returnDayRequestSchema,
  reviewAnomalyRequestSchema,
  saveMusterRequestSchema,
  timesheetLinesResponseSchema,
  timesheetRuleResponseSchema,
  updatePeriodSettingsRequestSchema,
  type Adjustment,
  type AttendanceEntryValues,
  type Correction,
  type TimesheetLine,
  type TimesheetRule,
  type TimesheetTotalsWire,
} from "@pm-buddy/validation";
import type { LabourState } from "./mock-labour.mts";

export type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };
export type AttendanceContext = {
  persona: "owner" | "agent";
  user: { id: string; displayName: string };
  projects: {
    id: string;
    code: string;
    name: string;
    status: (typeof PROJECT_STATUSES)[number];
    sites: { id: string; name: string }[];
  }[];
  labour: LabourState;
  idempotencyKey: string | undefined;
  stepUpFresh: () => boolean;
  fail: (status: number, code: string) => never;
};

export const MOCK_TODAY = "2026-11-10";
const MOCK_NOW = new Date("2026-11-10T07:45:00.000Z");
const RUIRU = "30000000-0000-4000-8000-000000000001";
const MAIN_PLOT = "31000000-0000-4000-8000-000000000001";
const OWNER = { id: "21000000-0000-4000-8000-000000000001", displayName: "Wanjiru Kamau" };
const PM = { id: "21000000-0000-4000-8000-000000000002", displayName: "Brian Otieno" };
const AGENT = { id: "21000000-0000-4000-8000-000000000003", displayName: "Kevin Kiprono" };
const PEOPLE = [OWNER, PM, AGENT];
const AGENT_PERMISSIONS: readonly Permission[] = [
  "attendance.view",
  "attendance.record",
  "attendance.confirm",
  "timesheets.submit",
];
const SETTINGS = { weekEndsOn: 4 as IsoWeekday, cutoffMinutes: 1080 };
const id = () => randomUUID();
const stamp = (date: string, minutes: number) => zonedDateTime(date, minutes).toISOString();
const actor = (personId: string) =>
  PEOPLE.find((person) => person.id === personId) ?? { id: personId, displayName: "—" };

type Values = AttendanceEntryValues;
type MockRule = Omit<TimesheetRule, "projectCode" | "effectiveTo" | "inForce" | "scheduled">;
type MockHoliday = {
  id: string;
  date: string;
  nameEn: string;
  nameSw: string;
  kind: "statutory" | "gazetted" | "observed" | "company";
  source: string;
};
type MockDay = {
  id: string;
  projectId: string;
  siteId: string;
  date: string;
  status: "draft" | "submitted" | "confirmed";
  version: number;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  returnedBy: string | null;
  returnedAt: string | null;
  returnReason: string | null;
};
type MockRecord = Values & {
  id: string;
  dayId: string;
  projectId: string;
  siteId: string;
  date: string;
  labourerId: string;
  version: number;
  corrected: boolean;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
};
type MockAnomaly = {
  id: string;
  recordId: string;
  kind: AnomalyKind;
  status: "open" | "resolved" | "dismissed" | "cleared";
  details: Record<string, string | number | boolean | string[]>;
  correctionId: string | null;
  detectedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  version: number;
};
type MockCorrection = {
  id: string;
  dayId: string;
  recordId: string | null;
  labourerId: string;
  proposed: Values;
  previous: Values | null;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  version: number;
};
type MockPeriod = {
  id: string;
  projectId: string;
  startDate: string;
  endDate: string;
  cutoffAt: string;
  status: "open" | "submitted" | "rejected" | "approved";
  version: number;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  submittedDigest: string | null;
  snapshot: TimesheetLine[] | null;
};
type MockAdjustment = Omit<
  Adjustment,
  "workerNo" | "fullName" | "siteName" | "requestedBy" | "decidedBy"
> & { requestedBy: string; decidedBy: string | null };

export type AttendanceState = {
  settings: {
    weekEndsOn: IsoWeekday;
    cutoffTime: string;
    paydayWeekday: IsoWeekday;
    version: number;
  };
  rules: MockRule[];
  holidays: MockHoliday[];
  days: MockDay[];
  records: MockRecord[];
  anomalies: MockAnomaly[];
  corrections: MockCorrection[];
  periods: MockPeriod[];
  adjustments: MockAdjustment[];
  idempotency: Map<string, { fingerprint: string; reply: Reply }>;
};

// Fixture ----------------------------------------------------------------------------------------

const LABOURERS = {
  amina: "42000000-0000-4000-8000-000000000001",
  joseph: "42000000-0000-4000-8000-000000000002",
  grace: "42000000-0000-4000-8000-000000000003",
  peter: "42000000-0000-4000-8000-000000000004",
  mercy: "42000000-0000-4000-8000-000000000005",
};

const present = (checkIn: string, checkOut: string, notes: string | null = null): Values => ({
  status: "present",
  checkIn,
  checkOut,
  overnight: false,
  breakMinutes: null,
  notes,
});
const absent: Values = {
  status: "absent",
  checkIn: null,
  checkOut: null,
  overnight: false,
  breakMinutes: null,
  notes: null,
};

/**
 * Ruiru Heights, Tuesday 10/11/2026: the week of 23/10 is approved (one adjustment request from
 * the project manager waits), the week of 30/10 is submitted by the project manager, and the
 * current week has confirmed days (a two-site day and an excessive-hours day among them) and
 * today's Main plot roll submitted by the site agent.
 */
export function attendanceFixture(materialsYardId: string, labour: LabourState): AttendanceState {
  const state: AttendanceState = {
    settings: { weekEndsOn: 4, cutoffTime: "18:00", paydayWeekday: 5, version: 0 },
    rules: [
      {
        id: id(),
        projectId: null,
        effectiveFrom: "2026-01-01",
        ...DEMO_TIMESHEET_RULE,
        restDays: [...DEMO_TIMESHEET_RULE.restDays],
        complianceStatus: "unverified",
        createdAt: "2026-01-01T06:00:00.000Z",
        createdBy: OWNER,
      },
    ],
    holidays: KENYA_PUBLIC_HOLIDAYS.map((holiday) => ({ id: id(), ...holiday })),
    days: [],
    records: [],
    anomalies: [],
    corrections: [],
    periods: [],
    adjustments: [],
    idempotency: new Map(),
  };
  const period = (
    startDate: string,
    status: MockPeriod["status"],
    submittedBy: string | null,
    approvedBy: string | null,
  ): MockPeriod => {
    const endDate = addCalendarDays(startDate, 6);
    return {
      id: id(),
      projectId: RUIRU,
      startDate,
      endDate,
      cutoffAt: stamp(endDate, SETTINGS.cutoffMinutes),
      status,
      version: status === "open" ? 1 : status === "submitted" ? 2 : 3,
      submittedBy,
      submittedAt: submittedBy ? stamp(addCalendarDays(endDate, 1), 9 * 60) : null,
      approvedBy,
      approvedAt: approvedBy ? stamp(addCalendarDays(endDate, 1), 11 * 60) : null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      submittedDigest: null,
      snapshot: null,
    };
  };
  const approved = period("2026-10-23", "approved", AGENT.id, PM.id);
  const submitted = period("2026-10-30", "submitted", PM.id, null);
  const current = period("2026-11-06", "open", null, null);
  state.periods.push(approved, submitted, current);

  const day = (
    siteId: string,
    date: string,
    status: MockDay["status"],
    recorder: string,
    confirmer: string | null,
    entries: [string, Values][],
  ) => {
    const row: MockDay = {
      id: id(),
      projectId: RUIRU,
      siteId,
      date,
      status,
      version: status === "confirmed" ? 3 : 2,
      createdBy: recorder,
      submittedBy: recorder,
      submittedAt: stamp(date, 17 * 60),
      confirmedBy: status === "confirmed" ? confirmer : null,
      confirmedAt: status === "confirmed" ? stamp(date, 18 * 60) : null,
      returnedBy: null,
      returnedAt: null,
      returnReason: null,
    };
    state.days.push(row);
    for (const [labourerId, values] of entries)
      state.records.push({
        id: id(),
        dayId: row.id,
        projectId: RUIRU,
        siteId,
        date,
        labourerId,
        ...values,
        version: 1,
        corrected: false,
        createdBy: recorder,
        updatedBy: recorder,
        updatedAt: stamp(date, 16 * 60),
      });
  };
  const { amina, joseph, grace, peter, mercy } = LABOURERS;
  // Week of 23/10 (approved) and week of 30/10 (submitted): no open findings.
  for (const date of ["2026-10-27", "2026-10-28"])
    day(MAIN_PLOT, date, "confirmed", AGENT.id, PM.id, [
      [amina, present("07:00", "16:00")],
      [joseph, present("07:00", "16:00")],
      [peter, absent],
    ]);
  for (const date of ["2026-11-03", "2026-11-04"])
    day(MAIN_PLOT, date, "confirmed", AGENT.id, PM.id, [
      [amina, present("07:00", "16:00")],
      [joseph, present("06:50", "17:30")],
      [peter, absent],
    ]);
  // Current week: a two-site day (Joseph on the Main plot and in the materials yard), a long
  // slab pour on Saturday, and today's roll submitted by the site agent.
  day(MAIN_PLOT, "2026-11-06", "confirmed", AGENT.id, PM.id, [
    [amina, present("07:00", "16:00")],
    [joseph, present("07:00", "13:00")],
  ]);
  day(materialsYardId, "2026-11-06", "confirmed", PM.id, AGENT.id, [
    [joseph, present("12:00", "18:00", "Offloaded blocks (synthetic)")],
  ]);
  day(MAIN_PLOT, "2026-11-07", "confirmed", AGENT.id, PM.id, [
    [joseph, present("05:30", "20:30", "Slab pour ran late (synthetic)")],
  ]);
  day(MAIN_PLOT, MOCK_TODAY, "submitted", AGENT.id, null, [
    [amina, present("07:05", "16:10")],
    [joseph, present("06:55", "17:30")],
    [grace, { ...absent, status: "leave" }],
    [peter, present("07:20", "16:00")],
    [mercy, present("07:00", "16:00")],
  ]);
  for (const record of state.records)
    refreshAnomalies(state, labour, record.labourerId, record.date);

  approved.snapshot = linesOf(state, labour, approved);
  approved.submittedDigest = digest(approved.snapshot);
  submitted.submittedDigest = digest(linesOf(state, labour, submitted));
  const peterOn28 = state.records.find(
    (record) => record.labourerId === peter && record.date === "2026-10-28",
  )!;
  state.adjustments.push({
    id: id(),
    projectId: RUIRU,
    originalPeriodId: approved.id,
    targetPeriodId: null,
    labourerId: peter,
    siteId: MAIN_PLOT,
    date: "2026-10-28",
    recordId: peterOn28.id,
    proposed: present("07:00", "16:00", "Signed the paper roll (synthetic)"),
    previous: valuesOf(peterOn28),
    reason: "Signed the paper roll at the gate; missed in the web entry (synthetic)",
    status: "pending",
    requestedBy: PM.id,
    requestedAt: "2026-11-09T07:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    delta: null,
    version: 1,
  });
  // Review fix 3 as the API shows it: an approved share that no longer matches the day is a
  // blocking anomaly on the open record, and the system proposes an adjustment (same values).
  const josephYard = state.records.find(
    (record) =>
      record.labourerId === joseph && record.date === "2026-11-06" && record.siteId !== MAIN_PLOT,
  )!;
  state.anomalies.push({
    id: id(),
    recordId: josephYard.id,
    kind: "locked_share_changed",
    status: "open",
    details: {
      lockedRecordIds: [josephYard.id],
      paidHalfDays: 2,
      idealHalfDays: 2,
      paidNormalMinutes: 360,
      idealNormalMinutes: 480,
      paidOvertimeMinutes: 120,
      idealOvertimeMinutes: 0,
    },
    correctionId: null,
    detectedAt: MOCK_NOW.toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    version: 1,
  });
  const josephOn27 = state.records.find(
    (record) => record.labourerId === joseph && record.date === "2026-10-27",
  )!;
  state.adjustments.push({
    id: id(),
    projectId: RUIRU,
    originalPeriodId: approved.id,
    targetPeriodId: null,
    labourerId: joseph,
    siteId: MAIN_PLOT,
    date: "2026-10-27",
    recordId: josephOn27.id,
    proposed: valuesOf(josephOn27),
    previous: valuesOf(josephOn27),
    reason: AUTOMATIC_ADJUSTMENT_REASON,
    status: "pending",
    requestedBy: AGENT.id,
    requestedAt: "2026-11-09T08:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    delta: null,
    version: 1,
  });
  return state;
}

// Computation ------------------------------------------------------------------------------------

const valuesOf = (record: Values): Values => ({
  status: record.status,
  checkIn: record.checkIn,
  checkOut: record.checkOut,
  overnight: record.overnight,
  breakMinutes: record.breakMinutes,
  notes: record.notes,
});

const dayRecord = (record: MockRecord): DayRecord => ({
  id: record.id,
  projectId: record.projectId,
  siteId: record.siteId,
  status: record.status,
  checkIn: record.checkIn === null ? null : parseClock(record.checkIn),
  checkOut: record.checkOut === null ? null : parseClock(record.checkOut),
  overnight: record.overnight,
  breakMinutes: record.breakMinutes,
});

const ruleFor = (state: AttendanceState, projectId: string, date: string): MockRule | null =>
  resolveTimesheetRule(state.rules, projectId, date);

const holidaySet = (state: AttendanceState) =>
  new Set(state.holidays.map((holiday) => holiday.date));

function computeDay(
  state: AttendanceState,
  labourerId: string,
  date: string,
  overlay?: { recordId: string | null; siteId: string; values: Values },
): LabourerDayResult {
  let records = state.records
    .filter((record) => record.labourerId === labourerId && record.date === date)
    .map(dayRecord);
  if (overlay) {
    const replacement = dayRecord({
      ...(state.records.find((record) => record.id === overlay.recordId) ?? {
        id: "overlay",
        dayId: "",
        projectId: RUIRU,
        siteId: overlay.siteId,
        date,
        labourerId,
        version: 0,
        corrected: false,
        createdBy: "",
        updatedBy: "",
        updatedAt: "",
      }),
      ...overlay.values,
    });
    records = [...records.filter((record) => record.id !== replacement.id), replacement];
  }
  return computeLabourerDay({
    date,
    records,
    ruleFor: (projectId) => ruleFor(state, projectId, date),
    holidays: holidaySet(state),
  });
}

export function wireTotals(totals: TimesheetTotals): TimesheetTotalsWire {
  return {
    days: formatHalfDays(totals.halfDays),
    halfDays: totals.halfDays,
    workedMinutes: totals.workedMinutes,
    normalMinutes: totals.normalMinutes,
    overtimeMinutes: { ...totals.overtimeMinutes },
    lateMinutes: totals.lateMinutes,
    statusCounts: { ...totals.statusCounts },
  };
}
const fromWire = (wire: TimesheetTotalsWire): TimesheetTotals => ({
  halfDays: wire.halfDays,
  workedMinutes: wire.workedMinutes,
  normalMinutes: wire.normalMinutes,
  overtimeMinutes: { ...wire.overtimeMinutes },
  lateMinutes: wire.lateMinutes,
  statusCounts: { ...wire.statusCounts },
});

function person(labour: LabourState, labourerId: string) {
  return labour.labourers.find((row) => row.id === labourerId);
}

/** The computed lines of a period: attendance per labourer plus approved adjustments landing in it. */
function linesOf(state: AttendanceState, labour: LabourState, period: MockPeriod): TimesheetLine[] {
  const records = state.records.filter(
    (record) =>
      record.projectId === period.projectId &&
      record.date >= period.startDate &&
      record.date <= period.endDate,
  );
  const labourerIds = [...new Set(records.map((record) => record.labourerId))];
  const lines: TimesheetLine[] = labourerIds.map((labourerId) => {
    const dates = [
      ...new Set(records.filter((r) => r.labourerId === labourerId).map((r) => r.date)),
    ].sort();
    const days = timesheetDays(
      dates.map((date) => computeDay(state, labourerId, date)),
      period.projectId,
    );
    const row = person(labour, labourerId);
    return {
      labourerId,
      workerNo: row?.workerNo ?? "—",
      fullName: row?.fullName ?? "—",
      kind: "attendance" as const,
      adjustmentId: null,
      originalPeriodId: null,
      totals: wireTotals(sumDays(days)),
      ruleVersionIds: [...new Set(days.map((day) => day.ruleId).filter(Boolean))],
      recordIds: days.flatMap((day) => day.recordIds),
      days: days.map((day) => ({
        date: day.date,
        dayType: day.dayType,
        ruleVersionId: day.ruleId || null,
        totals: wireTotals(day.totals),
        recordIds: day.recordIds,
      })),
    };
  });
  for (const adjustment of state.adjustments.filter(
    (entry) => entry.targetPeriodId === period.id && entry.status === "approved" && entry.delta,
  )) {
    const row = person(labour, adjustment.labourerId);
    lines.push({
      labourerId: adjustment.labourerId,
      workerNo: row?.workerNo ?? "—",
      fullName: row?.fullName ?? "—",
      kind: "adjustment",
      adjustmentId: adjustment.id,
      originalPeriodId: adjustment.originalPeriodId,
      totals: adjustment.delta!,
      ruleVersionIds: [],
      recordIds: adjustment.recordId ? [adjustment.recordId] : [],
      days: [],
    });
  }
  return lines.sort((a, b) => (a.workerNo < b.workerNo ? -1 : a.workerNo > b.workerNo ? 1 : 0));
}

const digest = (lines: TimesheetLine[]) =>
  createHash("sha256").update(JSON.stringify(lines)).digest("hex");

function sumLines(lines: TimesheetLine[]): TimesheetTotalsWire {
  return wireTotals(
    lines.reduce((total, line) => addTotals(total, fromWire(line.totals)), emptyTotals()),
  );
}

function engagedOn(labour: LabourState, labourerId: string, projectId: string, date: string) {
  return (
    person(labour, labourerId)?.engagements.some(
      (engagement) =>
        engagement.projectId === projectId &&
        engagement.startDate <= date &&
        (engagement.endDate === null || engagement.endDate >= date),
    ) ?? false
  );
}

/** Re-evaluates the anomaly rules for one labourer-day; findings that no longer hold are cleared. */
function refreshAnomalies(
  state: AttendanceState,
  labour: LabourState,
  labourerId: string,
  date: string,
) {
  const records = state.records.filter(
    (record) => record.labourerId === labourerId && record.date === date,
  );
  const row = person(labour, labourerId);
  if (!row) return;
  const skill = labour.skillLevels.find((level) => level.id === row.skillLevelId);
  const found = detectDayAnomalies({
    records: records.map((record) => ({
      ...dayRecord(record),
      engaged: engagedOn(labour, labourerId, record.projectId, date),
    })),
    result: computeDay(state, labourerId, date),
    labourer: {
      status: row.status,
      doNotRehire: row.flag.flagged,
      accreditationExpected: skill?.accreditationExpected ?? false,
      cards: row.cards.map((card) => ({ issuedOn: card.issuedOn, expiresOn: card.expiresOn })),
    },
    date,
  });
  const ids = new Set(records.map((record) => record.id));
  for (const anomaly of state.anomalies)
    if (
      ids.has(anomaly.recordId) &&
      anomaly.status === "open" &&
      anomaly.kind !== "manual_override" &&
      !found.some((entry) => entry.recordId === anomaly.recordId && entry.kind === anomaly.kind)
    ) {
      anomaly.status = "cleared";
      anomaly.version += 1;
    }
  for (const entry of found) {
    const existing = state.anomalies.find(
      (anomaly) =>
        anomaly.recordId === entry.recordId &&
        anomaly.kind === entry.kind &&
        anomaly.status !== "cleared",
    );
    if (existing) {
      if (existing.status === "open") existing.details = entry.details;
      continue;
    }
    state.anomalies.push({
      id: id(),
      recordId: entry.recordId,
      kind: entry.kind,
      status: "open",
      details: entry.details,
      correctionId: null,
      detectedAt: MOCK_NOW.toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      version: 1,
    });
  }
}

// Projections ------------------------------------------------------------------------------------

function can(ctx: AttendanceContext, projectId: string, permission: Permission): boolean {
  if (ctx.persona === "owner") return ctx.projects.some((project) => project.id === projectId);
  return projectId === RUIRU && AGENT_PERMISSIONS.includes(permission);
}

function projectOf(ctx: AttendanceContext, projectId: string, permission: Permission) {
  const project = ctx.projects.find((entry) => entry.id === projectId);
  if (!project || !can(ctx, projectId, "attendance.view")) return ctx.fail(404, "not-found");
  if (!can(ctx, projectId, permission)) return ctx.fail(403, "forbidden");
  return project;
}

function wireRule(
  state: AttendanceState,
  rule: MockRule,
  codes: Map<string, string>,
): TimesheetRule {
  const next = state.rules
    .filter(
      (other) => other.projectId === rule.projectId && other.effectiveFrom > rule.effectiveFrom,
    )
    .map((other) => other.effectiveFrom)
    .sort()[0];
  const effectiveTo = next ? addCalendarDays(next, -1) : null;
  return {
    ...rule,
    restDays: [...rule.restDays].sort((a, b) => a - b),
    projectCode: rule.projectId ? (codes.get(rule.projectId) ?? null) : null,
    effectiveTo,
    inForce:
      rule.effectiveFrom <= MOCK_TODAY && (effectiveTo === null || effectiveTo >= MOCK_TODAY),
    scheduled: rule.effectiveFrom > MOCK_TODAY,
  };
}

const periodLocked = (state: AttendanceState, date: string) =>
  state.periods.some(
    (period) =>
      (period.status === "submitted" || period.status === "approved") &&
      period.startDate <= date &&
      period.endDate >= date,
  );

function settingsView(state: AttendanceState, ctx: AttendanceContext) {
  const codes = new Map(ctx.projects.map((project) => [project.id, project.code]));
  return {
    today: MOCK_TODAY,
    periodSettings: { frequency: "weekly" as const, ...state.settings },
    rules: state.rules
      .filter((rule) => rule.projectId === null || can(ctx, rule.projectId, "attendance.view"))
      .sort((a, b) =>
        a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0,
      )
      .map((rule) => wireRule(state, rule, codes)),
    holidays: [...state.holidays]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((holiday) => ({
        ...holiday,
        complianceStatus: "unverified" as const,
        locked: periodLocked(state, holiday.date),
      })),
    canConfigure: ctx.persona === "owner",
    ruleProjects: ctx.projects
      .filter((project) => can(ctx, project.id, "timesheets.manage_rules"))
      .map(({ id: projectId, code, name }) => ({ id: projectId, code, name })),
  };
}

const coveringPeriod = (state: AttendanceState, projectId: string, date: string) =>
  state.periods.find(
    (period) =>
      period.projectId === projectId && period.startDate <= date && period.endDate >= date,
  );

function periodSummary(state: AttendanceState, projectId: string, date: string) {
  const period = coveringPeriod(state, projectId, date);
  const window = weeklyPeriodFor(date, SETTINGS);
  const cutoffAt = period?.cutoffAt ?? window.cutoffAt.toISOString();
  return {
    id: period?.id ?? null,
    startDate: period?.startDate ?? window.startDate,
    endDate: period?.endDate ?? window.endDate,
    cutoffAt,
    status: period?.status ?? ("open" as const),
    due: new Date(cutoffAt).getTime() <= MOCK_NOW.getTime(),
  };
}

function ensurePeriod(state: AttendanceState, projectId: string, date: string): MockPeriod {
  const existing = coveringPeriod(state, projectId, date);
  if (existing) return existing;
  const window = weeklyPeriodFor(date, SETTINGS);
  const period: MockPeriod = {
    id: id(),
    projectId,
    startDate: window.startDate,
    endDate: window.endDate,
    cutoffAt: window.cutoffAt.toISOString(),
    status: "open",
    version: 1,
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    submittedDigest: null,
    snapshot: null,
  };
  state.periods.push(period);
  return period;
}

function wireCorrection(
  labour: LabourState,
  state: AttendanceState,
  row: MockCorrection,
): Correction {
  const day = state.days.find((entry) => entry.id === row.dayId)!;
  const who = person(labour, row.labourerId);
  return {
    id: row.id,
    dayId: row.dayId,
    recordId: row.recordId,
    labourerId: row.labourerId,
    workerNo: who?.workerNo ?? "—",
    fullName: who?.fullName ?? "—",
    siteId: day.siteId,
    date: day.date,
    proposed: row.proposed,
    previous: row.previous,
    reason: row.reason,
    status: row.status,
    requestedBy: actor(row.requestedBy),
    requestedAt: row.requestedAt,
    decidedBy: row.decidedBy ? actor(row.decidedBy) : null,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    version: row.version,
  };
}

function siteName(ctx: AttendanceContext, siteId: string) {
  for (const project of ctx.projects)
    for (const site of project.sites) if (site.id === siteId) return site.name;
  return "—";
}

function musterView(
  state: AttendanceState,
  ctx: AttendanceContext,
  projectId: string,
  siteId: string,
  date: string,
  gangId: string | null,
) {
  const project = projectOf(ctx, projectId, "attendance.view");
  const site = project.sites.find((entry) => entry.id === siteId);
  if (!site) return ctx.fail(404, "not-found");
  const labour = ctx.labour;
  const day = state.days.find((entry) => entry.siteId === siteId && entry.date === date) ?? null;
  const records = day ? state.records.filter((record) => record.dayId === day.id) : [];
  const gangs = labour.gangs.filter(
    (gang) => gang.projectId === projectId && gang.status === "active",
  );
  const gangOf = (labourerId: string) =>
    gangs.find((gang) =>
      gang.members.some(
        (member) =>
          member.labourerId === labourerId &&
          member.joinedOn <= date &&
          (member.leftOn === null || member.leftOn >= date),
      ),
    ) ?? null;
  const ids = new Set([
    ...labour.labourers
      .filter((row) => engagedOn(labour, row.id, projectId, date))
      .map((row) => row.id),
    ...records.map((record) => record.labourerId),
  ]);
  const rule = ruleFor(state, projectId, date);
  const holiday = state.holidays.find((entry) => entry.date === date) ?? null;
  const summary = periodSummary(state, projectId, date);
  const lock =
    project.status === "closed" || project.status === "cancelled"
      ? ("project-read-only" as const)
      : date > MOCK_TODAY
        ? ("future-date" as const)
        : summary.status === "approved"
          ? ("period-approved" as const)
          : summary.status === "submitted"
            ? ("period-submitted" as const)
            : day?.status === "submitted"
              ? ("day-submitted" as const)
              : day?.status === "confirmed"
                ? ("day-confirmed" as const)
                : null;
  const permissions = {
    canRecord: can(ctx, projectId, "attendance.record"),
    canConfirm: can(ctx, projectId, "attendance.confirm"),
    canOverride: can(ctx, projectId, "attendance.override"),
    canReview: can(ctx, projectId, "attendance.review_anomalies"),
  };
  const codes = new Map(ctx.projects.map((entry) => [entry.id, entry.code]));
  const rows = labour.labourers
    .filter((row) => ids.has(row.id))
    .filter((row) => !gangId || gangOf(row.id)?.id === gangId)
    .sort((a, b) => (a.workerNo < b.workerNo ? -1 : 1))
    .map((row) => {
      const record = records.find((entry) => entry.labourerId === row.id) ?? null;
      const trade = labour.trades.find((entry) => entry.id === row.tradeId);
      const result = record ? computeDay(state, row.id, date) : null;
      const allocation = result?.records.find((entry) => entry.recordId === record?.id);
      const gang = gangOf(row.id);
      return {
        labourer: {
          id: row.id,
          workerNo: row.workerNo,
          fullName: row.fullName,
          tradeNameEn: trade?.nameEn ?? "—",
          tradeNameSw: trade?.nameSw ?? "—",
          status: row.status,
          doNotRehire: row.flag.flagged,
          gangId: gang?.id ?? null,
          gangName: gang?.name ?? null,
          engaged: engagedOn(labour, row.id, projectId, date),
        },
        record: record
          ? {
              id: record.id,
              ...valuesOf(record),
              captureMethod: "web_manual" as const,
              corrected: record.corrected,
              version: record.version,
              recordedBy: actor(record.updatedBy),
              updatedAt: record.updatedAt,
              computed:
                allocation && result?.dayType && !result.missingRule
                  ? {
                      dayType: result.dayType,
                      halfDays: allocation.halfDays,
                      workedMinutes: allocation.workedMinutes,
                      normalMinutes: allocation.normalMinutes,
                      overtimeMinutes: allocation.overtimeMinutes,
                      lateMinutes: allocation.lateMinutes,
                      breakMinutes: allocation.breakMinutes,
                    }
                  : null,
            }
          : null,
        anomalies: state.anomalies
          .filter((anomaly) => anomaly.recordId === record?.id && anomaly.status === "open")
          .map((anomaly) => ({
            id: anomaly.id,
            kind: anomaly.kind,
            severity: ANOMALY_SEVERITY[anomaly.kind],
            status: "open" as const,
          })),
        otherSites: state.records
          .filter(
            (other) =>
              other.labourerId === row.id && other.date === date && other.siteId !== siteId,
          )
          .map((other) => ({
            siteId: other.siteId,
            siteName: siteName(ctx, other.siteId),
            projectCode: codes.get(other.projectId) ?? "—",
            status: other.status,
          })),
      };
    });
  return {
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    site,
    sites: project.sites,
    gangs: gangs.map((gang) => ({ id: gang.id, name: gang.name })),
    gangId,
    date,
    today: MOCK_TODAY,
    dayType: rule ? dayTypeOf(date, rule.restDays, holidaySet(state)) : null,
    holiday: holiday ? { nameEn: holiday.nameEn, nameSw: holiday.nameSw } : null,
    rule: rule ? wireRule(state, rule, codes) : null,
    period: summary,
    day: day
      ? {
          id: day.id,
          status: day.status,
          version: day.version,
          submittedBy: day.submittedBy ? actor(day.submittedBy) : null,
          submittedAt: day.submittedAt,
          confirmedBy: day.confirmedBy ? actor(day.confirmedBy) : null,
          confirmedAt: day.confirmedAt,
          returnedBy: day.returnedBy ? actor(day.returnedBy) : null,
          returnedAt: day.returnedAt,
          returnReason: day.returnReason,
          recorders: [...new Set(records.flatMap((r) => [r.createdBy, r.updatedBy]))].map(actor),
        }
      : null,
    rows,
    corrections: state.corrections
      .filter((correction) => correction.dayId === day?.id)
      .map((correction) => wireCorrection(labour, state, correction)),
    editable: lock === null && permissions.canRecord,
    locked: lock,
    permissions,
  };
}

function wirePeriod(period: MockPeriod) {
  return {
    id: period.id,
    projectId: period.projectId,
    startDate: period.startDate,
    endDate: period.endDate,
    cutoffAt: period.cutoffAt,
    status: period.status,
    due: new Date(period.cutoffAt).getTime() <= MOCK_NOW.getTime(),
    version: period.version,
    submittedBy: period.submittedBy ? actor(period.submittedBy) : null,
    submittedAt: period.submittedAt,
    approvedBy: period.approvedBy ? actor(period.approvedBy) : null,
    approvedAt: period.approvedAt,
    rejectedBy: period.rejectedBy ? actor(period.rejectedBy) : null,
    rejectedAt: period.rejectedAt,
    rejectionReason: period.rejectionReason,
    submittedDigest: period.submittedDigest,
  };
}

function wireAdjustment(ctx: AttendanceContext, adjustment: MockAdjustment): Adjustment {
  const who = person(ctx.labour, adjustment.labourerId);
  return {
    ...adjustment,
    workerNo: who?.workerNo ?? "—",
    fullName: who?.fullName ?? "—",
    siteName: siteName(ctx, adjustment.siteId),
    requestedBy: actor(adjustment.requestedBy),
    decidedBy: adjustment.decidedBy ? actor(adjustment.decidedBy) : null,
  };
}

const anomaliesOfPeriod = (state: AttendanceState, period: MockPeriod) =>
  state.anomalies.filter((anomaly) => {
    const record = state.records.find((entry) => entry.id === anomaly.recordId);
    return (
      anomaly.status === "open" &&
      record?.projectId === period.projectId &&
      record.date >= period.startDate &&
      record.date <= period.endDate
    );
  }).length;

function periodDetail(state: AttendanceState, ctx: AttendanceContext, period: MockPeriod) {
  const project = projectOf(ctx, period.projectId, "attendance.view");
  const lines = period.snapshot ?? linesOf(state, ctx.labour, period);
  const days = state.days.filter(
    (day) =>
      day.projectId === period.projectId &&
      day.date >= period.startDate &&
      day.date <= period.endDate,
  );
  const ruleIds = new Set(lines.flatMap((line) => line.ruleVersionIds));
  const codes = new Map(ctx.projects.map((entry) => [entry.id, entry.code]));
  const rules = state.rules.filter((rule) => ruleIds.has(rule.id));
  const missingRuleDates = [...new Set(days.map((day) => day.date))].filter(
    (date) => !ruleFor(state, period.projectId, date),
  );
  const can_ = (permission: Permission) => can(ctx, period.projectId, permission);
  return {
    project: { id: project.id, code: project.code, name: project.name },
    period: wirePeriod(period),
    source: period.status === "approved" ? ("snapshot" as const) : ("live" as const),
    lines,
    totals: sumLines(lines),
    rules: rules.map((rule) => wireRule(state, rule, codes)),
    holidays: state.holidays
      .filter((holiday) => holiday.date >= period.startDate && holiday.date <= period.endDate)
      .map(({ date, nameEn, nameSw }) => ({ date, nameEn, nameSw })),
    blockers: {
      notDue: new Date(period.cutoffAt).getTime() > MOCK_NOW.getTime(),
      unconfirmedDays: days
        .filter((day) => day.status !== "confirmed")
        .map((day) => ({
          dayId: day.id,
          siteId: day.siteId,
          siteName: siteName(ctx, day.siteId),
          date: day.date,
          status: day.status,
        })),
      openAnomalies: anomaliesOfPeriod(state, period),
      missingRuleDates,
      pendingCorrections: state.corrections.filter(
        (correction) =>
          correction.status === "pending" && days.some((day) => day.id === correction.dayId),
      ).length,
      rulesUnverified: rules.some((rule) => rule.complianceStatus !== "approved"),
    },
    adjustments: {
      requested: state.adjustments
        .filter((entry) => entry.originalPeriodId === period.id)
        .map((entry) => wireAdjustment(ctx, entry)),
      landed: state.adjustments
        .filter((entry) => entry.targetPeriodId === period.id)
        .map((entry) => wireAdjustment(ctx, entry)),
    },
    permissions: {
      canSubmit: can_("timesheets.submit") && period.status === "open",
      canApprove:
        can_("timesheets.approve") &&
        period.status === "submitted" &&
        period.submittedBy !== ctx.user.id,
      canReopen: can_("timesheets.submit") && period.status === "rejected",
      canRequestAdjustment: can_("attendance.override") && period.status === "approved",
      canDecideAdjustments: can_("timesheets.approve"),
    },
  };
}

function wireAnomaly(state: AttendanceState, ctx: AttendanceContext, anomaly: MockAnomaly) {
  const record = state.records.find((entry) => entry.id === anomaly.recordId)!;
  const who = person(ctx.labour, record.labourerId);
  return {
    id: anomaly.id,
    projectId: record.projectId,
    projectCode: ctx.projects.find((entry) => entry.id === record.projectId)?.code ?? "—",
    siteId: record.siteId,
    siteName: siteName(ctx, record.siteId),
    recordId: record.id,
    labourerId: record.labourerId,
    workerNo: who?.workerNo ?? "—",
    fullName: who?.fullName ?? "—",
    date: record.date,
    kind: anomaly.kind,
    severity: ANOMALY_SEVERITY[anomaly.kind],
    status: anomaly.status,
    details: anomaly.details,
    correctionId: anomaly.correctionId,
    detectedAt: anomaly.detectedAt,
    recordedBy: actor(record.createdBy),
    reviewedBy: anomaly.reviewedBy ? actor(anomaly.reviewedBy) : null,
    reviewedAt: anomaly.reviewedAt,
    reviewNote: anomaly.reviewNote,
    version: anomaly.version,
  };
}

function totalsFor(
  state: AttendanceState,
  ctx: AttendanceContext,
  labourerId: string,
  projectId: string,
  dates: string[],
): TimesheetTotals {
  const days = timesheetDays(
    dates.map((date) => computeDay(state, labourerId, date)),
    projectId,
  );
  return sumDays(days);
}

// Routes -----------------------------------------------------------------------------------------

function parse<T>(ctx: AttendanceContext, schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) ctx.fail(400, "validation-error");
  return result.data!;
}

/**
 * Commands need an Idempotency-Key; a replay with the same key and body answers the stored reply
 * (as the API does), a different body with the same key is refused.
 */
function command(
  state: AttendanceState,
  ctx: AttendanceContext,
  operation: string,
  body: unknown,
  run: () => Reply,
): Reply {
  const key = ctx.idempotencyKey;
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return ctx.fail(400, "invalid-idempotency-key");
  const fingerprint = JSON.stringify({ operation, user: ctx.user.id, body });
  const stored = state.idempotency.get(key);
  if (stored) {
    if (stored.fingerprint !== fingerprint) return ctx.fail(409, "idempotency-key-reused");
    return stored.reply;
  }
  const reply = run();
  state.idempotency.set(key, { fingerprint, reply });
  return reply;
}

const conflict = (ctx: AttendanceContext, code: string): never => ctx.fail(409, code);

export function handleAttendance(
  ctx: AttendanceContext,
  state: AttendanceState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  if (!path.startsWith("/attendance/")) return null;
  const labour = ctx.labour;
  const visible = ctx.projects.filter((project) => can(ctx, project.id, "attendance.view"));

  if (path === "/attendance/overview" && method === "GET") {
    return {
      body: {
        today: MOCK_TODAY,
        projects: visible.map((project) => {
          const projectAnomalies = state.anomalies.filter(
            (anomaly) =>
              anomaly.status === "open" &&
              state.records.find((record) => record.id === anomaly.recordId)?.projectId ===
                project.id,
          );
          return {
            id: project.id,
            code: project.code,
            name: project.name,
            status: project.status,
            sites: project.sites.map((site) => {
              const day = state.days.find(
                (entry) => entry.siteId === site.id && entry.date === MOCK_TODAY,
              );
              return {
                id: site.id,
                name: site.name,
                today: {
                  dayId: day?.id ?? null,
                  status: day?.status ?? null,
                  records: day ? state.records.filter((r) => r.dayId === day.id).length : 0,
                },
              };
            }),
            openAnomalies: projectAnomalies.length,
            pendingCorrections: state.corrections.filter(
              (correction) =>
                correction.status === "pending" &&
                state.days.find((day) => day.id === correction.dayId)?.projectId === project.id,
            ).length,
            pendingAdjustments: state.adjustments.filter(
              (entry) => entry.projectId === project.id && entry.status === "pending",
            ).length,
            periodsAwaitingApproval: state.periods.filter(
              (period) => period.projectId === project.id && period.status === "submitted",
            ).length,
            currentPeriod: periodSummary(state, project.id, MOCK_TODAY),
            canRecord: can(ctx, project.id, "attendance.record"),
          };
        }),
      },
      schema: attendanceOverviewResponseSchema,
    };
  }

  if (path === "/attendance/settings" && method === "GET")
    return { body: settingsView(state, ctx), schema: attendanceSettingsResponseSchema };
  if (path === "/attendance/settings/periods" && method === "PUT") {
    const input = parse(ctx, updatePeriodSettingsRequestSchema, body);
    return command(state, ctx, "settings.periods", input, () => {
      if (ctx.persona !== "owner") return ctx.fail(403, "forbidden");
      if (input.version !== state.settings.version) return conflict(ctx, "version-conflict");
      state.settings = {
        weekEndsOn: input.weekEndsOn,
        cutoffTime: input.cutoffTime,
        paydayWeekday: input.paydayWeekday,
        version: state.settings.version + 1,
      };
      return { body: settingsView(state, ctx), schema: attendanceSettingsResponseSchema };
    });
  }
  if (path === "/attendance/rules" && method === "POST") {
    const input = parse(ctx, createTimesheetRuleRequestSchema, body);
    return command(state, ctx, "rules.create", input, () => {
      if (
        input.projectId
          ? !can(ctx, input.projectId, "timesheets.manage_rules")
          : ctx.persona !== "owner"
      )
        return ctx.fail(403, "forbidden");
      if (
        state.rules.some(
          (rule) =>
            rule.projectId === input.projectId && rule.effectiveFrom === input.effectiveFrom,
        )
      )
        return conflict(ctx, "rule-exists");
      if (periodLocked(state, input.effectiveFrom)) return conflict(ctx, "period-locked");
      const rule: MockRule = {
        id: id(),
        ...input,
        complianceStatus: "unverified",
        createdAt: MOCK_NOW.toISOString(),
        createdBy: actor(ctx.user.id),
      };
      state.rules.push(rule);
      const codes = new Map(ctx.projects.map((entry) => [entry.id, entry.code]));
      return {
        status: 201,
        body: { rule: wireRule(state, rule, codes) },
        schema: timesheetRuleResponseSchema,
      };
    });
  }
  const ruleMatch = /^\/attendance\/rules\/([^/]+)$/.exec(path);
  if (ruleMatch && method === "DELETE")
    return command(state, ctx, "rules.delete", ruleMatch[1], () => {
      const rule = state.rules.find((entry) => entry.id === ruleMatch[1]);
      if (!rule) return ctx.fail(404, "not-found");
      if (
        rule.projectId
          ? !can(ctx, rule.projectId, "timesheets.manage_rules")
          : ctx.persona !== "owner"
      )
        return ctx.fail(403, "forbidden");
      if (rule.effectiveFrom <= MOCK_TODAY) return conflict(ctx, "rule-in-force");
      state.rules = state.rules.filter((entry) => entry !== rule);
      return { body: { message: "Rule version cancelled." }, schema: messageResponseSchema };
    });
  if (path === "/attendance/holidays" && method === "POST") {
    const input = parse(ctx, createHolidayRequestSchema, body);
    return command(state, ctx, "holidays.create", input, () => {
      if (ctx.persona !== "owner") return ctx.fail(403, "forbidden");
      if (state.holidays.some((holiday) => holiday.date === input.date))
        return conflict(ctx, "holiday-exists");
      if (periodLocked(state, input.date)) return conflict(ctx, "period-locked");
      const holiday = { id: id(), ...input };
      state.holidays.push(holiday);
      return {
        status: 201,
        body: { holiday: { ...holiday, complianceStatus: "unverified", locked: false } },
        schema: holidayResponseSchema,
      };
    });
  }
  const holidayMatch = /^\/attendance\/holidays\/([^/]+)$/.exec(path);
  if (holidayMatch && method === "DELETE")
    return command(state, ctx, "holidays.delete", holidayMatch[1], () => {
      if (ctx.persona !== "owner") return ctx.fail(403, "forbidden");
      const holiday = state.holidays.find((entry) => entry.id === holidayMatch[1]);
      if (!holiday) return ctx.fail(404, "not-found");
      if (periodLocked(state, holiday.date)) return conflict(ctx, "period-locked");
      state.holidays = state.holidays.filter((entry) => entry !== holiday);
      return { body: { message: "Holiday removed." }, schema: messageResponseSchema };
    });
  if (path === "/attendance/holidays/defaults" && method === "POST")
    return command(state, ctx, "holidays.defaults", {}, () => {
      if (ctx.persona !== "owner") return ctx.fail(403, "forbidden");
      for (const holiday of KENYA_PUBLIC_HOLIDAYS)
        if (!state.holidays.some((entry) => entry.date === holiday.date))
          state.holidays.push({ id: id(), ...holiday });
      return { body: settingsView(state, ctx), schema: attendanceSettingsResponseSchema };
    });
  if (path === "/attendance/rules/defaults" && method === "POST")
    return command(state, ctx, "rules.defaults", {}, () => {
      if (ctx.persona !== "owner") return ctx.fail(403, "forbidden");
      return { body: settingsView(state, ctx), schema: attendanceSettingsResponseSchema };
    });

  const musterMatch = /^\/attendance\/projects\/([^/]+)\/muster$/.exec(path);
  if (musterMatch && method === "GET") {
    const siteId = query.get("siteId");
    const date = query.get("date");
    if (!siteId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return ctx.fail(400, "validation-error");
    return {
      body: musterView(state, ctx, musterMatch[1]!, siteId, date, query.get("gangId")),
      schema: musterResponseSchema,
    };
  }
  if (musterMatch && method === "PUT") {
    const input = parse(ctx, saveMusterRequestSchema, body);
    const projectId = musterMatch[1]!;
    return command(state, ctx, "muster.save", input, () => {
      const project = projectOf(ctx, projectId, "attendance.record");
      if (!project.sites.some((site) => site.id === input.siteId))
        return ctx.fail(400, "site-not-in-project");
      if (input.date > MOCK_TODAY) return ctx.fail(400, "date-in-future");
      if (periodLocked(state, input.date)) return conflict(ctx, "period-locked");
      let day = state.days.find(
        (entry) => entry.siteId === input.siteId && entry.date === input.date,
      );
      if ((day?.version ?? 0) !== input.dayVersion) return conflict(ctx, "version-conflict");
      if (day && day.status !== "draft") return conflict(ctx, "day-not-draft");
      for (const entry of input.entries)
        if (!engagedOn(labour, entry.labourerId, projectId, input.date))
          return conflict(ctx, "not-engaged");
      ensurePeriod(state, projectId, input.date);
      if (!day) {
        day = {
          id: id(),
          projectId,
          siteId: input.siteId,
          date: input.date,
          status: "draft",
          version: 0,
          createdBy: ctx.user.id,
          submittedBy: null,
          submittedAt: null,
          confirmedBy: null,
          confirmedAt: null,
          returnedBy: null,
          returnedAt: null,
          returnReason: null,
        };
        state.days.push(day);
      }
      const current = day;
      for (const entry of input.entries) {
        const existing = state.records.find(
          (record) => record.dayId === current.id && record.labourerId === entry.labourerId,
        );
        if ((existing?.version ?? 0) !== entry.version) return conflict(ctx, "version-conflict");
        const { labourerId } = entry;
        const values = valuesOf(entry);
        if (existing) {
          Object.assign(existing, values, {
            version: existing.version + 1,
            updatedBy: ctx.user.id,
            updatedAt: MOCK_NOW.toISOString(),
          });
        } else
          state.records.push({
            id: id(),
            dayId: current.id,
            projectId,
            siteId: input.siteId,
            date: input.date,
            labourerId,
            ...values,
            version: 1,
            corrected: false,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
            updatedAt: MOCK_NOW.toISOString(),
          });
        refreshAnomalies(state, labour, labourerId, input.date);
      }
      current.version += 1;
      return {
        body: musterView(state, ctx, projectId, input.siteId, input.date, null),
        schema: musterResponseSchema,
      };
    });
  }

  const dayMatch = /^\/attendance\/days\/([^/]+)\/(submit|confirm|return|corrections)$/.exec(path);
  if (dayMatch && method === "POST") {
    const day = state.days.find((entry) => entry.id === dayMatch[1]);
    const action = dayMatch[2]!;
    if (action === "corrections") {
      const input = parse(ctx, createCorrectionRequestSchema, body);
      return command(state, ctx, "correction.create", { day: dayMatch[1], input }, () => {
        if (!day) return ctx.fail(404, "not-found");
        projectOf(ctx, day.projectId, "attendance.override");
        if (!ctx.stepUpFresh()) return ctx.fail(403, "step-up-required");
        if (day.status === "draft") return conflict(ctx, "use-correction");
        if (periodLocked(state, day.date)) return conflict(ctx, "period-locked");
        const record =
          state.records.find(
            (entry) => entry.dayId === day.id && entry.labourerId === input.labourerId,
          ) ?? null;
        if ((record?.version ?? 0) !== input.recordVersion)
          return conflict(ctx, "version-conflict");
        if (
          state.corrections.some(
            (entry) =>
              entry.dayId === day.id &&
              entry.labourerId === input.labourerId &&
              entry.status === "pending",
          )
        )
          return conflict(ctx, "correction-pending");
        const { labourerId, reason } = input;
        const values = valuesOf(input);
        const correction: MockCorrection = {
          id: id(),
          dayId: day.id,
          recordId: record?.id ?? null,
          labourerId,
          proposed: values,
          previous: record ? valuesOf(record) : null,
          reason,
          status: "pending",
          requestedBy: ctx.user.id,
          requestedAt: MOCK_NOW.toISOString(),
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
          version: 1,
        };
        state.corrections.push(correction);
        return {
          status: 201,
          body: { correction: wireCorrection(labour, state, correction) },
          schema: correctionResponseSchema,
        };
      });
    }
    const input = parse(
      ctx,
      action === "return" ? returnDayRequestSchema : dayActionRequestSchema,
      body,
    ) as { version: number; reason?: string };
    return command(state, ctx, `day.${action}`, { day: dayMatch[1], input }, () => {
      if (!day) return ctx.fail(404, "not-found");
      projectOf(
        ctx,
        day.projectId,
        action === "submit" ? "attendance.record" : "attendance.confirm",
      );
      if (day.version !== input.version) return conflict(ctx, "version-conflict");
      if (action === "submit") {
        if (day.status !== "draft") return conflict(ctx, "invalid-transition");
        if (!state.records.some((record) => record.dayId === day.id))
          return conflict(ctx, "day-empty");
        Object.assign(day, {
          status: "submitted",
          submittedBy: ctx.user.id,
          submittedAt: MOCK_NOW.toISOString(),
        });
      } else {
        if (day.status !== "submitted") return conflict(ctx, "invalid-transition");
        if (day.submittedBy === ctx.user.id) return conflict(ctx, "same-person");
        if (
          action === "return" &&
          state.corrections.some(
            (correction) => correction.dayId === day.id && correction.status === "pending",
          )
        )
          return conflict(ctx, "pending-corrections");
        if (
          action === "confirm" &&
          state.records.some(
            (record) =>
              record.dayId === day.id &&
              (record.createdBy === ctx.user.id || record.updatedBy === ctx.user.id),
          )
        )
          return conflict(ctx, "same-person");
        if (action === "confirm")
          Object.assign(day, {
            status: "confirmed",
            confirmedBy: ctx.user.id,
            confirmedAt: MOCK_NOW.toISOString(),
          });
        else
          Object.assign(day, {
            status: "draft",
            returnedBy: ctx.user.id,
            returnedAt: MOCK_NOW.toISOString(),
            returnReason: input.reason ?? null,
          });
      }
      day.version += 1;
      return {
        body: musterView(state, ctx, day.projectId, day.siteId, day.date, null),
        schema: musterResponseSchema,
      };
    });
  }

  const correctionsMatch = /^\/attendance\/projects\/([^/]+)\/corrections$/.exec(path);
  if (correctionsMatch && method === "GET") {
    projectOf(ctx, correctionsMatch[1]!, "attendance.view");
    const status = query.get("status");
    return {
      body: {
        corrections: state.corrections
          .filter(
            (correction) =>
              state.days.find((day) => day.id === correction.dayId)?.projectId ===
                correctionsMatch[1] &&
              (!status || correction.status === status),
          )
          .map((correction) => wireCorrection(labour, state, correction)),
      },
      schema: correctionsResponseSchema,
    };
  }
  const decideMatch = /^\/attendance\/(corrections|adjustments)\/([^/]+)\/(approve|reject)$/.exec(
    path,
  );
  if (decideMatch && method === "POST") {
    const [, kind, targetId, decision] = decideMatch;
    const input = parse(
      ctx,
      decision === "approve" ? approveDecisionRequestSchema : rejectDecisionRequestSchema,
      body,
    ) as { version: number; note?: string };
    return command(state, ctx, `${kind}.${decision}`, { targetId, input }, () => {
      if (kind === "corrections") {
        const correction = state.corrections.find((entry) => entry.id === targetId);
        if (!correction) return ctx.fail(404, "not-found");
        const day = state.days.find((entry) => entry.id === correction.dayId)!;
        projectOf(ctx, day.projectId, "attendance.confirm");
        if (correction.version !== input.version) return conflict(ctx, "version-conflict");
        if (correction.status !== "pending") return conflict(ctx, "invalid-transition");
        if (correction.requestedBy === ctx.user.id) return conflict(ctx, "same-person");
        if (decision === "approve") {
          const current = state.records.find(
            (entry) => entry.dayId === day.id && entry.labourerId === correction.labourerId,
          );
          const unchanged = correction.previous
            ? current !== undefined &&
              JSON.stringify(valuesOf(current)) === JSON.stringify(correction.previous)
            : current === undefined;
          if (day.status === "draft" || !unchanged) return conflict(ctx, "correction-outdated");
        }
        Object.assign(correction, {
          status: decision === "approve" ? "approved" : "rejected",
          decidedBy: ctx.user.id,
          decidedAt: MOCK_NOW.toISOString(),
          decisionNote: input.note ?? null,
          version: correction.version + 1,
        });
        if (decision === "approve") {
          const record = state.records.find(
            (entry) => entry.dayId === day.id && entry.labourerId === correction.labourerId,
          );
          if (record)
            Object.assign(record, correction.proposed, {
              corrected: true,
              version: record.version + 1,
              updatedBy: ctx.user.id,
            });
          refreshAnomalies(state, labour, correction.labourerId, day.date);
        }
        return {
          body: { correction: wireCorrection(labour, state, correction) },
          schema: correctionResponseSchema,
        };
      }
      const adjustment = state.adjustments.find((entry) => entry.id === targetId);
      if (!adjustment) return ctx.fail(404, "not-found");
      projectOf(ctx, adjustment.projectId, "timesheets.approve");
      if (adjustment.version !== input.version) return conflict(ctx, "version-conflict");
      if (adjustment.status !== "pending") return conflict(ctx, "invalid-transition");
      if (adjustment.requestedBy === ctx.user.id) return conflict(ctx, "same-person");
      if (decision === "approve") {
        const target = state.periods
          .filter(
            (period) =>
              period.projectId === adjustment.projectId &&
              period.status === "open" &&
              period.startDate > adjustment.date,
          )
          .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))[0];
        if (!target) return conflict(ctx, "no-target-period");
        const before = totalsFor(state, ctx, adjustment.labourerId, adjustment.projectId, [
          adjustment.date,
        ]);
        const after = sumDays(
          timesheetDays(
            [
              computeDay(state, adjustment.labourerId, adjustment.date, {
                recordId: adjustment.recordId,
                siteId: adjustment.siteId,
                values: adjustment.proposed,
              }),
            ],
            adjustment.projectId,
          ),
        );
        adjustment.delta = wireTotals(subtractTotals(after, before));
        adjustment.targetPeriodId = target.id;
      }
      Object.assign(adjustment, {
        status: decision === "approve" ? "approved" : "rejected",
        decidedBy: ctx.user.id,
        decidedAt: MOCK_NOW.toISOString(),
        decisionNote: input.note ?? null,
        version: adjustment.version + 1,
      });
      return {
        body: { adjustment: wireAdjustment(ctx, adjustment) },
        schema: adjustmentResponseSchema,
      };
    });
  }

  if (path === "/attendance/anomalies" && method === "GET") {
    const projectId = query.get("projectId");
    const status = query.get("status");
    const kind = query.get("kind");
    const from = query.get("from");
    const to = query.get("to");
    const all = state.anomalies
      .map((anomaly) => wireAnomaly(state, ctx, anomaly))
      .filter((anomaly) => can(ctx, anomaly.projectId, "attendance.view"));
    const anomalies = all
      .filter((anomaly) => !projectId || anomaly.projectId === projectId)
      .filter((anomaly) => !status || anomaly.status === status)
      .filter((anomaly) => !kind || anomaly.kind === kind)
      .filter((anomaly) => !from || anomaly.date >= from)
      .filter((anomaly) => !to || anomaly.date <= to)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const open = all.filter((anomaly) => anomaly.status === "open");
    return {
      body: {
        anomalies,
        counts: {
          open: open.length,
          critical: open.filter((anomaly) => anomaly.severity === "critical").length,
        },
        reviewableProjectIds: visible
          .filter((project) => can(ctx, project.id, "attendance.review_anomalies"))
          .map((project) => project.id),
        projects: visible.map(({ id: projectId_, code, name }) => ({ id: projectId_, code, name })),
      },
      schema: anomaliesResponseSchema,
    };
  }
  const reviewMatch = /^\/attendance\/anomalies\/([^/]+)\/review$/.exec(path);
  if (reviewMatch && method === "POST") {
    const input = parse(ctx, reviewAnomalyRequestSchema, body);
    return command(state, ctx, "anomaly.review", { id: reviewMatch[1], input }, () => {
      const anomaly = state.anomalies.find((entry) => entry.id === reviewMatch[1]);
      if (!anomaly) return ctx.fail(404, "not-found");
      const record = state.records.find((entry) => entry.id === anomaly.recordId)!;
      projectOf(ctx, record.projectId, "attendance.review_anomalies");
      if (anomaly.version !== input.version) return conflict(ctx, "version-conflict");
      if (anomaly.status !== "open") return conflict(ctx, "invalid-transition");
      if (record.createdBy === ctx.user.id || record.updatedBy === ctx.user.id)
        return conflict(ctx, "same-person");
      Object.assign(anomaly, {
        status: input.decision === "resolve" ? "resolved" : "dismissed",
        reviewedBy: ctx.user.id,
        reviewedAt: MOCK_NOW.toISOString(),
        reviewNote: input.note,
        version: anomaly.version + 1,
      });
      return { body: { anomaly: wireAnomaly(state, ctx, anomaly) }, schema: anomalyResponseSchema };
    });
  }

  const periodsMatch = /^\/attendance\/projects\/([^/]+)\/periods$/.exec(path);
  if (periodsMatch && method === "GET") {
    const project = projectOf(ctx, periodsMatch[1]!, "attendance.view");
    return {
      body: {
        project: { id: project.id, code: project.code, name: project.name },
        periods: state.periods
          .filter((period) => period.projectId === project.id)
          .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))
          .map((period) => {
            const days = state.days.filter(
              (day) =>
                day.projectId === project.id &&
                day.date >= period.startDate &&
                day.date <= period.endDate,
            );
            return {
              period: wirePeriod(period),
              days: days.length,
              unconfirmedDays: days.filter((day) => day.status !== "confirmed").length,
              openAnomalies: anomaliesOfPeriod(state, period),
              labourers: new Set(
                state.records
                  .filter((record) => days.some((day) => day.id === record.dayId))
                  .map((record) => record.labourerId),
              ).size,
            };
          }),
        settings: { frequency: "weekly", ...state.settings },
        pendingAdjustments: state.adjustments.filter(
          (entry) => entry.projectId === project.id && entry.status === "pending",
        ).length,
      },
      schema: periodsResponseSchema,
    };
  }
  const periodMatch =
    /^\/attendance\/periods\/([^/]+)(?:\/(lines|submit|approve|reject|reopen|adjustments))?$/.exec(
      path,
    );
  if (periodMatch) {
    const period = state.periods.find((entry) => entry.id === periodMatch[1]);
    const action = periodMatch[2];
    if (!action && method === "GET") {
      if (!period) return ctx.fail(404, "not-found");
      return { body: periodDetail(state, ctx, period), schema: periodDetailResponseSchema };
    }
    if (action === "lines" && method === "GET") {
      if (!period) return ctx.fail(404, "not-found");
      const project = projectOf(ctx, period.projectId, "attendance.view");
      if (period.status !== "approved") return conflict(ctx, "period-not-approved");
      const lines = period.snapshot ?? [];
      const ids = new Set(lines.flatMap((line) => line.ruleVersionIds));
      const codes = new Map(ctx.projects.map((entry) => [entry.id, entry.code]));
      return {
        body: {
          project: { id: project.id, code: project.code, name: project.name },
          period: wirePeriod(period),
          lines,
          ruleVersions: state.rules
            .filter((rule) => ids.has(rule.id))
            .map((rule) => wireRule(state, rule, codes)),
          holidays: state.holidays
            .filter((holiday) => holiday.date >= period.startDate && holiday.date <= period.endDate)
            .map(({ date, nameEn, nameSw }) => ({ date, nameEn, nameSw })),
        },
        schema: timesheetLinesResponseSchema,
      };
    }
    if (action === "adjustments" && method === "POST") {
      const input = parse(ctx, createAdjustmentRequestSchema, body);
      return command(state, ctx, "adjustment.create", { period: periodMatch[1], input }, () => {
        if (!period) return ctx.fail(404, "not-found");
        projectOf(ctx, period.projectId, "attendance.override");
        if (!ctx.stepUpFresh()) return ctx.fail(403, "step-up-required");
        if (period.status !== "approved") return conflict(ctx, "period-not-approved");
        if (input.date < period.startDate || input.date > period.endDate)
          return conflict(ctx, "date-outside-period");
        if (
          state.adjustments.some(
            (entry) =>
              entry.labourerId === input.labourerId &&
              entry.date === input.date &&
              entry.status === "pending",
          )
        )
          return conflict(ctx, "adjustment-pending");
        const record =
          state.records.find(
            (entry) =>
              entry.labourerId === input.labourerId &&
              entry.siteId === input.siteId &&
              entry.date === input.date,
          ) ?? null;
        const { labourerId, siteId, date, reason, ...values } = input;
        const adjustment: MockAdjustment = {
          id: id(),
          projectId: period.projectId,
          originalPeriodId: period.id,
          targetPeriodId: null,
          labourerId,
          siteId,
          date,
          recordId: record?.id ?? null,
          proposed: values,
          previous: record ? valuesOf(record) : null,
          reason,
          status: "pending",
          requestedBy: ctx.user.id,
          requestedAt: MOCK_NOW.toISOString(),
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
          delta: null,
          version: 1,
        };
        state.adjustments.push(adjustment);
        return {
          status: 201,
          body: { adjustment: wireAdjustment(ctx, adjustment) },
          schema: adjustmentResponseSchema,
        };
      });
    }
    if (action && action !== "lines" && action !== "adjustments" && method === "POST") {
      const input = parse(
        ctx,
        action === "reject" ? rejectPeriodRequestSchema : periodActionRequestSchema,
        body,
      ) as { version: number; reason?: string };
      return command(state, ctx, `period.${action}`, { period: periodMatch[1], input }, () => {
        if (!period) return ctx.fail(404, "not-found");
        projectOf(
          ctx,
          period.projectId,
          action === "submit" || action === "reopen" ? "timesheets.submit" : "timesheets.approve",
        );
        if (period.version !== input.version) return conflict(ctx, "version-conflict");
        if (action === "submit") {
          if (period.status !== "open") return conflict(ctx, "invalid-transition");
          if (new Date(period.cutoffAt).getTime() > MOCK_NOW.getTime())
            return conflict(ctx, "period-not-due");
          if (
            state.days.some(
              (day) =>
                day.projectId === period.projectId &&
                day.date >= period.startDate &&
                day.date <= period.endDate &&
                day.status !== "confirmed",
            )
          )
            return conflict(ctx, "unconfirmed-days");
          Object.assign(period, {
            status: "submitted",
            submittedBy: ctx.user.id,
            submittedAt: MOCK_NOW.toISOString(),
            submittedDigest: digest(linesOf(state, labour, period)),
          });
        } else if (action === "approve" || action === "reject") {
          if (period.status !== "submitted") return conflict(ctx, "invalid-transition");
          if (period.submittedBy === ctx.user.id) return conflict(ctx, "same-person");
          if (action === "approve") {
            if (anomaliesOfPeriod(state, period)) return conflict(ctx, "open-anomalies");
            const lines = linesOf(state, labour, period);
            if (digest(lines) !== period.submittedDigest) return conflict(ctx, "period-changed");
            Object.assign(period, {
              status: "approved",
              approvedBy: ctx.user.id,
              approvedAt: MOCK_NOW.toISOString(),
              snapshot: lines,
            });
          } else
            Object.assign(period, {
              status: "rejected",
              rejectedBy: ctx.user.id,
              rejectedAt: MOCK_NOW.toISOString(),
              rejectionReason: input.reason ?? null,
            });
        } else {
          if (period.status !== "rejected") return conflict(ctx, "invalid-transition");
          Object.assign(period, { status: "open", submittedDigest: null });
        }
        period.version += 1;
        return { body: periodDetail(state, ctx, period), schema: periodDetailResponseSchema };
      });
    }
  }
  const adjustmentsMatch = /^\/attendance\/projects\/([^/]+)\/adjustments$/.exec(path);
  if (adjustmentsMatch && method === "GET") {
    projectOf(ctx, adjustmentsMatch[1]!, "attendance.view");
    return {
      body: {
        adjustments: state.adjustments
          .filter((entry) => entry.projectId === adjustmentsMatch[1])
          .map((entry) => wireAdjustment(ctx, entry)),
      },
      schema: adjustmentsResponseSchema,
    };
  }
  const summaryMatch = /^\/attendance\/labourers\/([^/]+)\/summary$/.exec(path);
  if (summaryMatch && method === "GET") {
    const labourerId = summaryMatch[1]!;
    if (!person(labour, labourerId)) return ctx.fail(404, "not-found");
    if (!visible.length) return ctx.fail(403, "forbidden");
    const to = MOCK_TODAY;
    const from = addCalendarDays(to, -55);
    return {
      body: {
        labourerId,
        from,
        to,
        projects: visible
          .map((project) => {
            const records = state.records.filter(
              (record) =>
                record.labourerId === labourerId &&
                record.projectId === project.id &&
                record.date >= from &&
                record.date <= to,
            );
            const approvedDates = new Set<string>();
            const pendingDates = new Set<string>();
            for (const record of records)
              (coveringPeriod(state, project.id, record.date)?.status === "approved"
                ? approvedDates
                : pendingDates
              ).add(record.date);
            const worked = records
              .filter((record) => record.status === "present" || record.status === "half_day")
              .map((record) => record.date)
              .sort();
            return {
              projectId: project.id,
              code: project.code,
              name: project.name,
              approved: wireTotals(
                totalsFor(state, ctx, labourerId, project.id, [...approvedDates]),
              ),
              pending: wireTotals(totalsFor(state, ctx, labourerId, project.id, [...pendingDates])),
              lastWorkedOn: worked.at(-1) ?? null,
              count: records.length,
            };
          })
          .filter((entry) => entry.count > 0)
          .map((entry) => {
            const { projectId, code, name, approved, pending, lastWorkedOn } = entry;
            return { projectId, code, name, approved, pending, lastWorkedOn };
          }),
        openAnomalies: state.anomalies.filter(
          (anomaly) =>
            anomaly.status === "open" &&
            state.records.find((record) => record.id === anomaly.recordId)?.labourerId ===
              labourerId,
        ).length,
      },
      schema: labourerAttendanceResponseSchema,
    };
  }
  return ctx.fail(404, "not-found");
}
