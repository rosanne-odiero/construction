/**
 * The D6.2 schedule for the mock API: activities, dependencies, the calendar, frozen baselines and
 * the versioned delay log, computed with the shared CPM engine (packages/domain) and returned in
 * the shared response schemas, so the browser tests exercise the real wire contract. The data
 * date is fixed (MOCK_TODAY) so dates and variance are the same on every run. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  checkActivityProgress,
  checkDelayDays,
  computeSchedule,
  countWorkingDays,
  dependencyCreatesCycle,
  scheduleProgress,
  workingCalendar,
  workingDayVariance,
  type ScheduledItem,
  type ScheduleItemInput,
} from "@pm-buddy/domain";
import { DEFAULT_WORKING_WEEKDAYS, type DelayCause } from "@pm-buddy/types";
import {
  activityProgressRequestSchema,
  amendDelayRequestSchema,
  createActivityRequestSchema,
  createBaselineRequestSchema,
  createDelayRequestSchema,
  createDependencyRequestSchema,
  messageResponseSchema,
  scheduleActivityResponseSchema,
  scheduleBaselineResponseSchema,
  scheduleBaselinesResponseSchema,
  scheduleCalendarResponseSchema,
  scheduleDelayResponseSchema,
  scheduleDelaysResponseSchema,
  scheduleDependencyResponseSchema,
  scheduleResponseSchema,
  updateActivityRequestSchema,
  updateDependencyRequestSchema,
  updateScheduleCalendarRequestSchema,
  withdrawDelayRequestSchema,
  type Milestone,
  type ScheduleBaselineItem,
  type ScheduleBaselineSummary,
  type ScheduleDelay,
  type ScheduleDelayVersion,
  type ScheduleDependency,
  type ScheduleItem,
  type ScheduleItemRef,
  type ScheduleResponse,
  type WbsNode,
} from "@pm-buddy/validation";

/** The mock's "today" in Nairobi: remaining work is scheduled from here. */
export const MOCK_TODAY = "2026-11-10";
const HOLIDAYS = [
  "2026-04-03",
  "2026-04-06",
  "2026-05-01",
  "2026-06-01",
  "2026-10-10",
  "2026-10-20",
  "2026-12-12",
  "2026-12-25",
  "2026-12-26",
  "2027-01-01",
];

type Activity = {
  id: string;
  code: string;
  name: string;
  wbsNodeId: string | null;
  bqItem: ScheduleItem["bqItem"];
  durationDays: number;
  startNoEarlierThan: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  progress: NonNullable<ScheduleItem["progress"]>;
  version: number;
};
type Dependency = Omit<ScheduleDependency, "driving" | "critical" | "permissions">;
type Baseline = {
  summary: Omit<ScheduleBaselineSummary, "current">;
  items: ScheduleBaselineItem[];
};
type Delay = {
  id: string;
  number: number;
  versions: ScheduleDelayVersion[];
  createdAt: string;
  createdBy: { id: string; displayName: string };
};
export type ProjectSchedule = {
  calendar: { workingWeekdays: number[]; includePublicHolidays: boolean; version: number };
  activities: Activity[];
  dependencies: Dependency[];
  baselines: Baseline[];
  delays: Delay[];
};
export type ScheduleState = Map<string, ProjectSchedule>;

export type ScheduleDeps = {
  project: { id: string; status: string; startDate: string | null };
  milestones: Milestone[];
  wbs: WbsNode[];
  canEdit: boolean;
  actor: { id: string; displayName: string };
  fail: (status: number, code: string) => Error;
  parse: <T>(schema: z.ZodType<T>, body: unknown) => T;
};
type Reply = { status?: number; body: unknown; schema: z.ZodType<unknown> };

const physical = (percentComplete: number | null = null): Activity["progress"] => ({
  basis: "physical",
  percentComplete,
  quantityDone: null,
  quantityTotal: null,
  quantityUnit: null,
});
const emptySchedule = (): ProjectSchedule => ({
  calendar: {
    workingWeekdays: [...DEFAULT_WORKING_WEEKDAYS],
    includePublicHolidays: true,
    version: 0,
  },
  activities: [],
  dependencies: [],
  baselines: [],
  delays: [],
});

/** Ruiru Heights: a slipped schedule with a frozen contract programme and one weather delay. */
export function initialSchedule(
  project: ScheduleDeps["project"],
  milestones: Milestone[],
  wbs: WbsNode[],
  owner: { id: string; displayName: string },
): ProjectSchedule {
  const node = (code: string) => wbs.find((entry) => entry.code === code)?.id ?? null;
  const activity = (
    code: string,
    name: string,
    wbsCode: string,
    durationDays: number,
    actual: { start?: string; finish?: string; percent?: number } = {},
  ): Activity => ({
    id: randomUUID(),
    code,
    name,
    wbsNodeId: node(wbsCode),
    bqItem: null,
    durationDays,
    startNoEarlierThan: null,
    actualStart: actual.start ?? null,
    actualFinish: actual.finish ?? null,
    progress: physical(actual.finish ? 100 : (actual.percent ?? null)),
    version: 1,
  });
  const activities = [
    activity("A10", "Site establishment", "1", 10),
    activity("A20", "Excavation", "2", 15),
    activity("A30", "Foundations", "2", 20),
    activity("A40", "Ground floor slab", "2", 12),
    activity("A50", "Ground floor columns and walls", "3.1", 30),
    activity("A60", "First floor slab", "3.2", 20),
    activity("A70", "Roof structure", "3", 25),
    activity("A80", "Finishes", "4", 40),
  ];
  const [a10, a20, a30, a40, a50, a60, a70, a80] = activities as [
    Activity,
    Activity,
    Activity,
    Activity,
    Activity,
    Activity,
    Activity,
    Activity,
  ];
  const substructure = milestones.find((entry) => entry.name === "Substructure complete");
  const roof = milestones.find((entry) => entry.name === "Roof covered");
  const task = (entry: Activity): ScheduleItemRef => ({ kind: "task", id: entry.id });
  const mark = (entry: Milestone | undefined): ScheduleItemRef => ({
    kind: "milestone",
    id: entry!.id,
  });
  const link = (
    predecessor: ScheduleItemRef,
    successor: ScheduleItemRef,
    type: Dependency["type"] = "FS",
    lagDays = 0,
  ): Dependency => ({ id: randomUUID(), predecessor, successor, type, lagDays, version: 1 });
  const schedule: ProjectSchedule = {
    calendar: {
      workingWeekdays: [...DEFAULT_WORKING_WEEKDAYS],
      includePublicHolidays: true,
      version: 1,
    },
    activities,
    dependencies: [
      link(task(a10), task(a20)),
      link(task(a20), task(a30)),
      link(task(a30), task(a40)),
      link(task(a40), mark(substructure)),
      link(mark(substructure), task(a50)),
      link(task(a50), task(a60)),
      link(task(a60), task(a70)),
      link(task(a70), mark(roof)),
      link(task(a60), task(a80), "SS", 10),
    ],
    baselines: [],
    delays: [],
  };
  // The contract programme, frozen on the start date before anything was achieved.
  const planMilestones = milestones.map((entry) => ({
    ...entry,
    status: entry.status === "cancelled" ? entry.status : ("planned" as const),
    actualDate: null,
  }));
  const plan = compute(schedule, project, planMilestones, project.startDate ?? MOCK_TODAY);
  schedule.baselines.push(
    freeze(
      schedule,
      plan,
      planMilestones,
      owner,
      1,
      {
        name: "Contract programme",
        reason: "Agreed with the client at the site handover meeting",
      },
      "2026-03-02T07:00:00.000Z",
    ),
  );
  Object.assign(a10, {
    actualStart: "2026-03-02",
    actualFinish: "2026-03-13",
    progress: physical(100),
  });
  Object.assign(a20, {
    actualStart: "2026-03-16",
    actualFinish: "2026-04-08",
    progress: physical(100),
  });
  Object.assign(a30, {
    actualStart: "2026-04-09",
    actualFinish: "2026-05-12",
    progress: physical(100),
  });
  Object.assign(a40, {
    actualStart: "2026-05-13",
    actualFinish: "2026-06-25",
    progress: physical(100),
  });
  Object.assign(a50, { actualStart: "2026-06-29", progress: physical(80) });
  for (const entry of [a10, a20, a30, a40, a50]) entry.version = 2;
  schedule.delays.push({
    id: randomUUID(),
    number: 1,
    createdAt: "2026-04-18T15:00:00.000Z",
    createdBy: owner,
    versions: [
      {
        version: 1,
        status: "recorded",
        cause: "weather",
        startDate: "2026-04-13",
        endDate: "2026-04-18",
        workingDaysLost: 4.5,
        description: "Synthetic: long rains flooded the foundation trenches",
        siteDiary: null,
        claimFlag: "excusable",
        activities: [{ id: a20.id, code: a20.code, name: a20.name }],
        changeReason: null,
        recordedAt: "2026-04-18T15:00:00.000Z",
        recordedBy: owner,
      },
    ],
  });
  return schedule;
}

const keyOf = (ref: ScheduleItemRef) => `${ref.kind}:${ref.id}`;

function calendarOf(schedule: ProjectSchedule) {
  return workingCalendar(
    schedule.calendar.workingWeekdays,
    schedule.calendar.includePublicHolidays ? HOLIDAYS : [],
  );
}

function compute(
  schedule: ProjectSchedule,
  project: ScheduleDeps["project"],
  milestones: Milestone[],
  dataDate: string,
) {
  const live = milestones.filter((entry) => entry.status !== "cancelled");
  const liveKeys = new Set(live.map((entry) => `milestone:${entry.id}`));
  const items: ScheduleItemInput[] = [
    ...schedule.activities.map((entry): ScheduleItemInput => ({
      id: `task:${entry.id}`,
      kind: "task",
      durationDays: entry.durationDays,
      startNoEarlierThan: entry.startNoEarlierThan,
      actualStart: entry.actualStart,
      actualFinish: entry.actualFinish,
      percentComplete: entry.progress.percentComplete,
    })),
    ...live.map((entry): ScheduleItemInput => ({
      id: `milestone:${entry.id}`,
      kind: "milestone",
      targetDate: entry.dueDate,
      actualDate: entry.status === "achieved" ? entry.actualDate : null,
    })),
  ];
  const result = computeSchedule({
    calendar: calendarOf(schedule),
    start: project.startDate ?? MOCK_TODAY,
    dataDate,
    items,
    dependencies: schedule.dependencies
      .filter(
        (entry) =>
          (entry.predecessor.kind === "task" || liveKeys.has(keyOf(entry.predecessor))) &&
          (entry.successor.kind === "task" || liveKeys.has(keyOf(entry.successor))),
      )
      .map((entry) => ({
        id: entry.id,
        predecessorId: keyOf(entry.predecessor),
        successorId: keyOf(entry.successor),
        type: entry.type,
        lagDays: entry.lagDays,
      })),
  });
  if (!result.ok) throw new Error(`mock schedule failed: ${result.error}`);
  return result;
}

function freeze(
  schedule: ProjectSchedule,
  result: Extract<ReturnType<typeof computeSchedule>, { ok: true }>,
  milestones: Milestone[],
  actor: { id: string; displayName: string },
  number: number,
  input: { name: string; reason: string },
  createdAt = new Date().toISOString(),
): Baseline {
  const scheduled = new Map(result.items.map((entry) => [entry.id, entry]));
  const snapshot = (kind: "task" | "milestone", id: string, code: string | null, name: string) => {
    const entry = scheduled.get(`${kind}:${id}`)!;
    return {
      kind,
      id,
      code,
      name,
      start: entry.start,
      finish: entry.finish,
      durationDays: entry.durationDays,
      totalFloatDays: entry.totalFloatDays,
      critical: entry.critical,
    };
  };
  const items = [
    ...schedule.activities.map((entry) => snapshot("task", entry.id, entry.code, entry.name)),
    ...milestones
      .filter((entry) => entry.status !== "cancelled")
      .map((entry) => snapshot("milestone", entry.id, null, entry.name)),
  ];
  return {
    summary: {
      id: randomUUID(),
      number,
      name: input.name,
      reason: input.reason,
      dataDate: createdAt.slice(0, 10) <= MOCK_TODAY ? createdAt.slice(0, 10) : MOCK_TODAY,
      projectFinish: result.finish,
      itemCount: items.length,
      createdAt,
      createdBy: actor,
      permissions: { canEdit: false, canDelete: false },
    },
    items,
  };
}

function summaryOf(schedule: ProjectSchedule, baseline: Baseline): ScheduleBaselineSummary {
  return { ...baseline.summary, current: baseline === schedule.baselines.at(-1) };
}

function view(
  schedule: ProjectSchedule,
  deps: ScheduleDeps,
  baselineId: string | null,
): ScheduleResponse {
  const result = compute(schedule, deps.project, deps.milestones, MOCK_TODAY);
  const calendar = calendarOf(schedule);
  const scheduled = new Map<string, ScheduledItem>(result.items.map((entry) => [entry.id, entry]));
  const flags = new Map(result.dependencies.map((entry) => [entry.id, entry]));
  const compared = baselineId
    ? schedule.baselines.find((entry) => entry.summary.id === baselineId)
    : schedule.baselines.at(-1);
  if (baselineId && !compared) throw deps.fail(404, "not-found");
  const base = new Map(
    (compared?.items ?? []).map((entry) => [`${entry.kind}:${entry.id}`, entry]),
  );
  const against = (
    kind: "task" | "milestone",
    id: string,
    planned: { start: string; finish: string },
  ) => {
    const entry = base.get(`${kind}:${id}`);
    return entry
      ? {
          baseline: { start: entry.start, finish: entry.finish },
          variance: {
            startDays:
              kind === "task" ? workingDayVariance(calendar, entry.start, planned.start) : null,
            finishDays: workingDayVariance(calendar, entry.finish, planned.finish),
          },
        }
      : { baseline: null, variance: { startDays: null, finishDays: null } };
  };
  const order = (nodeId: string | null) => {
    const index = deps.wbs.findIndex((entry) => entry.id === nodeId);
    return index < 0 ? 10_000 : index;
  };
  const delayed = new Set(
    schedule.delays.flatMap((delay) =>
      delay.versions.flatMap((version) => version.activities.map((entry) => entry.id)),
    ),
  );
  const rows: { item: ScheduleItem; key: [number, string, number] }[] = [];
  for (const entry of schedule.activities) {
    const computed = scheduled.get(`task:${entry.id}`)!;
    const planned = { start: computed.start, finish: computed.finish };
    rows.push({
      key: [order(entry.wbsNodeId), planned.start, 0],
      item: {
        kind: "task",
        id: entry.id,
        activityId: entry.id,
        code: entry.code,
        name: entry.name,
        wbsNodeId: entry.wbsNodeId,
        bqItem: entry.bqItem,
        durationDays: entry.durationDays,
        startNoEarlierThan: entry.startNoEarlierThan,
        dueDate: null,
        milestoneStatus: null,
        actualStart: entry.actualStart,
        actualFinish: entry.actualFinish,
        progress: entry.progress,
        status: computed.status,
        planned,
        late: { start: computed.lateStart, finish: computed.lateFinish },
        totalFloatDays: computed.totalFloatDays,
        critical: computed.critical,
        ...against("task", entry.id, planned),
        version: entry.version,
        permissions: {
          canEdit: deps.canEdit,
          canRecordProgress: deps.canEdit,
          canDelete: deps.canEdit && !entry.actualStart && !delayed.has(entry.id),
        },
      },
    });
  }
  for (const entry of deps.milestones) {
    if (entry.status === "cancelled") continue;
    const computed = scheduled.get(`milestone:${entry.id}`)!;
    const planned = { start: computed.start, finish: computed.finish };
    rows.push({
      key: [order(entry.wbsNodeId), planned.finish, 1],
      item: {
        kind: "milestone",
        id: entry.id,
        activityId: null,
        code: null,
        name: entry.name,
        wbsNodeId: entry.wbsNodeId,
        bqItem: null,
        durationDays: 0,
        startNoEarlierThan: null,
        dueDate: entry.dueDate,
        milestoneStatus: entry.status,
        actualStart: null,
        actualFinish: entry.status === "achieved" ? entry.actualDate : null,
        progress: null,
        status: computed.status,
        planned,
        late: { start: computed.lateStart, finish: computed.lateFinish },
        totalFloatDays: computed.totalFloatDays,
        critical: computed.critical,
        ...against("milestone", entry.id, planned),
        version: null,
        permissions: { canEdit: false, canRecordProgress: false, canDelete: false },
      },
    });
  }
  rows.sort(({ key: a }, { key: b }) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2]);
  const present = new Set(rows.map(({ item }) => `${item.kind}:${item.id}`));
  const baselineFinish = compared?.summary.projectFinish ?? null;
  return {
    projectId: deps.project.id,
    calendar: {
      ...schedule.calendar,
      holidaysApplied: schedule.calendar.includePublicHolidays ? HOLIDAYS.length : 0,
    },
    start: deps.project.startDate
      ? { date: deps.project.startDate, source: "project_start" }
      : { date: MOCK_TODAY, source: "today" },
    dataDate: MOCK_TODAY,
    items: rows.map(({ item }) => item),
    dependencies: schedule.dependencies.map((entry) => ({
      ...entry,
      driving: flags.get(entry.id)?.driving ?? false,
      critical: flags.get(entry.id)?.critical ?? false,
      permissions: { canEdit: deps.canEdit, canDelete: deps.canEdit },
    })),
    finish: result.finish,
    baseline: compared ? summaryOf(schedule, compared) : null,
    currentBaselineId: schedule.baselines.at(-1)?.summary.id ?? null,
    projectVariance: {
      baselineFinish,
      finish: result.finish,
      finishDays: workingDayVariance(calendar, baselineFinish, result.finish),
    },
    removedSinceBaseline: (compared?.items ?? [])
      .filter((entry) => !present.has(`${entry.kind}:${entry.id}`))
      .map(({ kind, id, code, name }) => ({ kind, id, code, name })),
    progress: {
      basis: "duration_weighted_physical",
      ratio: scheduleProgress(
        schedule.activities.map((entry) => ({
          durationDays: entry.durationDays,
          status: scheduled.get(`task:${entry.id}`)!.status,
          percentComplete: entry.progress.percentComplete,
        })),
      ),
    },
    permissions: { canEdit: deps.canEdit, canBaseline: deps.canEdit, canRecordDelay: deps.canEdit },
  };
}

function delayView(schedule: ProjectSchedule, delay: Delay, deps: ScheduleDeps): ScheduleDelay {
  const current = delay.versions.at(-1)!;
  const editable = deps.canEdit && current.status === "recorded";
  return {
    id: delay.id,
    number: delay.number,
    ...current,
    workingDaysInPeriod: countWorkingDays(
      calendarOf(schedule),
      current.startDate,
      current.endDate ?? MOCK_TODAY,
    ),
    createdAt: delay.createdAt,
    createdBy: delay.createdBy,
    permissions: { canAmend: editable, canWithdraw: editable },
  };
}

const delayDetail = (schedule: ProjectSchedule, delay: Delay, deps: ScheduleDeps) => ({
  body: {
    delay: delayView(schedule, delay, deps),
    history: [...delay.versions].reverse(),
  },
  schema: scheduleDelayResponseSchema,
});

export function handleSchedule(
  deps: ScheduleDeps,
  state: ScheduleState,
  method: string,
  rest: string,
  query: URLSearchParams,
  body: unknown,
): Reply | null {
  if (rest !== "schedule" && !rest.startsWith("schedule/")) return null;
  const path = rest.slice("schedule".length);
  let schedule = state.get(deps.project.id);
  if (!schedule) {
    schedule = emptySchedule();
    state.set(deps.project.id, schedule);
  }
  const { fail, parse } = deps;
  const write = () => {
    if (!deps.canEdit)
      throw fail(
        ["closed", "cancelled"].includes(deps.project.status) ? 409 : 403,
        ["closed", "cancelled"].includes(deps.project.status) ? "project-read-only" : "forbidden",
      );
  };
  const itemReply = (id: string, status = 200): Reply => ({
    status,
    body: {
      item: view(schedule, deps, null).items.find(
        (entry) => entry.kind === "task" && entry.id === id,
      ),
    },
    schema: scheduleActivityResponseSchema,
  });
  const activity = (id: string) => {
    const found = schedule.activities.find((entry) => entry.id === id);
    if (!found) throw fail(404, "not-found");
    return found;
  };

  if (path === "" && method === "GET")
    return {
      body: view(schedule, deps, query.get("baselineId")),
      schema: scheduleResponseSchema,
    };
  if (path === "/calendar" && method === "PUT") {
    write();
    const input = parse(updateScheduleCalendarRequestSchema, body);
    if (input.version !== schedule.calendar.version) throw fail(409, "version-conflict");
    schedule.calendar = {
      workingWeekdays: input.workingWeekdays,
      includePublicHolidays: input.includePublicHolidays,
      version: schedule.calendar.version + 1,
    };
    return {
      body: { calendar: view(schedule, deps, null).calendar },
      schema: scheduleCalendarResponseSchema,
    };
  }
  if (path === "/activities" && method === "POST") {
    write();
    const input = parse(createActivityRequestSchema, body);
    if (schedule.activities.some((entry) => entry.code === input.code))
      throw fail(409, "activity-code-taken");
    const created: Activity = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      wbsNodeId: input.wbsNodeId ?? null,
      bqItem: null,
      durationDays: input.durationDays,
      startNoEarlierThan: input.startNoEarlierThan ?? null,
      actualStart: null,
      actualFinish: null,
      progress: physical(),
      version: 1,
    };
    schedule.activities.push(created);
    return itemReply(created.id, 201);
  }
  const activityMatch = /^\/activities\/([^/]+)(\/progress)?$/.exec(path);
  if (activityMatch) {
    write();
    const found = activity(activityMatch[1]!);
    if (activityMatch[2] && method === "PUT") {
      const input = parse(activityProgressRequestSchema, body);
      if (input.version !== found.version) throw fail(409, "version-conflict");
      const check = checkActivityProgress(
        {
          actualStart: input.actualStart,
          actualFinish: input.actualFinish,
          basis: input.basis,
          percentComplete: input.percentComplete ?? null,
          quantityDone: input.quantityDone ?? null,
          quantityTotal: input.quantityTotal ?? null,
          quantityUnit: input.quantityUnit ?? null,
        },
        MOCK_TODAY,
      );
      if (!check.ok) throw fail(400, check.error);
      Object.assign(found, {
        actualStart: input.actualStart,
        actualFinish: input.actualFinish,
        progress: {
          basis: input.basis,
          percentComplete: check.percentComplete,
          quantityDone: check.quantityDone,
          quantityTotal: check.quantityTotal,
          quantityUnit: check.quantityUnit,
        },
        version: found.version + 1,
      });
      return itemReply(found.id);
    }
    if (method === "DELETE") {
      if (Number(query.get("version")) !== found.version) throw fail(409, "version-conflict");
      if (found.actualStart) throw fail(409, "activity-started");
      schedule.activities = schedule.activities.filter((entry) => entry !== found);
      schedule.dependencies = schedule.dependencies.filter(
        (entry) => entry.predecessor.id !== found.id && entry.successor.id !== found.id,
      );
      return { body: { message: "Activity removed." }, schema: messageResponseSchema };
    }
    if (method === "PATCH") {
      const { version, ...fields } = parse(updateActivityRequestSchema, body);
      if (version !== found.version) throw fail(409, "version-conflict");
      if (
        fields.code !== undefined &&
        schedule.activities.some((entry) => entry !== found && entry.code === fields.code)
      )
        throw fail(409, "activity-code-taken");
      for (const [key, value] of Object.entries(fields))
        if (value !== undefined && key !== "bqItemLineageId")
          (found as Record<string, unknown>)[key] = value;
      found.version += 1;
      return itemReply(found.id);
    }
  }
  if (path === "/dependencies" && method === "POST") {
    write();
    const input = parse(createDependencyRequestSchema, body);
    for (const ref of [input.predecessor, input.successor]) {
      if (ref.kind === "task") activity(ref.id);
      else {
        const milestone = deps.milestones.find((entry) => entry.id === ref.id);
        if (!milestone) throw fail(404, "not-found");
        if (milestone.status === "cancelled") throw fail(409, "milestone-cancelled");
      }
    }
    const links = schedule.dependencies.map((entry) => ({
      predecessorId: keyOf(entry.predecessor),
      successorId: keyOf(entry.successor),
    }));
    const from = keyOf(input.predecessor);
    const to = keyOf(input.successor);
    if (links.some((entry) => entry.predecessorId === from && entry.successorId === to))
      throw fail(409, "dependency-exists");
    if (dependencyCreatesCycle(links, from, to)) throw fail(409, "schedule-cycle");
    const created: Dependency = { id: randomUUID(), ...input, version: 1 };
    schedule.dependencies.push(created);
    return {
      status: 201,
      body: {
        dependency: view(schedule, deps, null).dependencies.find(
          (entry) => entry.id === created.id,
        ),
      },
      schema: scheduleDependencyResponseSchema,
    };
  }
  const dependencyMatch = /^\/dependencies\/([^/]+)$/.exec(path);
  if (dependencyMatch) {
    write();
    const found = schedule.dependencies.find((entry) => entry.id === dependencyMatch[1]);
    if (!found) throw fail(404, "not-found");
    if (method === "DELETE") {
      if (Number(query.get("version")) !== found.version) throw fail(409, "version-conflict");
      schedule.dependencies = schedule.dependencies.filter((entry) => entry !== found);
      return { body: { message: "Dependency removed." }, schema: messageResponseSchema };
    }
    const input = parse(updateDependencyRequestSchema, body);
    if (input.version !== found.version) throw fail(409, "version-conflict");
    if (input.type) found.type = input.type;
    if (input.lagDays !== undefined) found.lagDays = input.lagDays;
    found.version += 1;
    return {
      body: {
        dependency: view(schedule, deps, null).dependencies.find((entry) => entry.id === found.id),
      },
      schema: scheduleDependencyResponseSchema,
    };
  }
  if (path === "/baselines" && method === "GET")
    return {
      body: {
        baselines: [...schedule.baselines].reverse().map((entry) => summaryOf(schedule, entry)),
        permissions: { canBaseline: deps.canEdit },
      },
      schema: scheduleBaselinesResponseSchema,
    };
  if (path === "/baselines" && method === "POST") {
    write();
    const input = parse(createBaselineRequestSchema, body);
    const result = compute(schedule, deps.project, deps.milestones, MOCK_TODAY);
    if (!result.items.length) throw fail(409, "schedule-empty");
    const created = freeze(
      schedule,
      result,
      deps.milestones,
      deps.actor,
      schedule.baselines.length + 1,
      input,
    );
    schedule.baselines.push(created);
    return {
      status: 201,
      body: { baseline: summaryOf(schedule, created), items: created.items },
      schema: scheduleBaselineResponseSchema,
    };
  }
  const baselineMatch = /^\/baselines\/([^/]+)$/.exec(path);
  if (baselineMatch && method === "GET") {
    const found = schedule.baselines.find((entry) => entry.summary.id === baselineMatch[1]);
    if (!found) throw fail(404, "not-found");
    return {
      body: { baseline: summaryOf(schedule, found), items: found.items },
      schema: scheduleBaselineResponseSchema,
    };
  }
  if (path === "/delays" && method === "GET") {
    const delays = [...schedule.delays].reverse().map((entry) => delayView(schedule, entry, deps));
    const recorded = delays.filter((entry) => entry.status === "recorded");
    const byCause = new Map<DelayCause, { count: number; workingDaysLost: number }>();
    for (const entry of recorded) {
      const total = byCause.get(entry.cause) ?? { count: 0, workingDaysLost: 0 };
      total.count += 1;
      total.workingDaysLost += entry.workingDaysLost;
      byCause.set(entry.cause, total);
    }
    return {
      body: {
        delays,
        totals: {
          count: recorded.length,
          workingDaysLost: recorded.reduce((sum, entry) => sum + entry.workingDaysLost, 0),
          byCause: [...byCause.entries()].map(([cause, total]) => ({ cause, ...total })),
        },
        permissions: { canRecord: deps.canEdit },
      },
      schema: scheduleDelaysResponseSchema,
    };
  }
  const versionOf = (
    input: Parameters<typeof checkDelayDays>[1] & {
      cause: DelayCause;
      description: string;
      claimFlag?: ScheduleDelayVersion["claimFlag"];
      activityIds: string[];
    },
    number: number,
    status: ScheduleDelayVersion["status"],
    changeReason: string | null,
  ): ScheduleDelayVersion => {
    const check = checkDelayDays(calendarOf(schedule), input, MOCK_TODAY);
    if (!check.ok) throw fail(400, check.error);
    return {
      version: number,
      status,
      cause: input.cause,
      startDate: input.startDate,
      endDate: input.endDate,
      workingDaysLost: input.workingDaysLost,
      description: input.description,
      siteDiary: null,
      claimFlag: input.claimFlag ?? "not_assessed",
      activities: input.activityIds.map((id) => {
        const found = activity(id);
        return { id: found.id, code: found.code, name: found.name };
      }),
      changeReason,
      recordedAt: new Date().toISOString(),
      recordedBy: deps.actor,
    };
  };
  if (path === "/delays" && method === "POST") {
    write();
    const input = parse(createDelayRequestSchema, body);
    const delay: Delay = {
      id: randomUUID(),
      number: schedule.delays.length + 1,
      createdAt: new Date().toISOString(),
      createdBy: deps.actor,
      versions: [versionOf(input, 1, "recorded", null)],
    };
    schedule.delays.push(delay);
    return { status: 201, ...delayDetail(schedule, delay, deps) };
  }
  const delayMatch = /^\/delays\/([^/]+)(\/(amend|withdraw))?$/.exec(path);
  if (delayMatch) {
    const delay = schedule.delays.find((entry) => entry.id === delayMatch[1]);
    if (!delay) throw fail(404, "not-found");
    if (method === "GET") return delayDetail(schedule, delay, deps);
    write();
    const current = delay.versions.at(-1)!;
    if (delayMatch[3] === "amend") {
      const input = parse(amendDelayRequestSchema, body);
      if (current.status === "withdrawn") throw fail(409, "delay-withdrawn");
      if (input.version !== current.version) throw fail(409, "version-conflict");
      delay.versions.push(versionOf(input, current.version + 1, "recorded", input.reason));
      return delayDetail(schedule, delay, deps);
    }
    const input = parse(withdrawDelayRequestSchema, body);
    if (current.status === "withdrawn") throw fail(409, "delay-withdrawn");
    if (input.version !== current.version) throw fail(409, "version-conflict");
    delay.versions.push({
      ...current,
      version: current.version + 1,
      status: "withdrawn",
      changeReason: input.reason,
      recordedAt: new Date().toISOString(),
      recordedBy: deps.actor,
    });
    return delayDetail(schedule, delay, deps);
  }
  throw fail(404, "not-found");
}
