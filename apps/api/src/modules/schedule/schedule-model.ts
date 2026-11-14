import { ForbiddenException, HttpException, InternalServerErrorException } from "@nestjs/common";
import {
  computeSchedule,
  isProjectReadOnly,
  nairobiDate,
  scheduleProgress,
  workingCalendar,
  workingDayVariance,
  type ScheduledItem,
  type ScheduleItemInput,
  type WorkingCalendar,
} from "@pm-buddy/domain";
import {
  DEFAULT_WORKING_WEEKDAYS,
  DELAY_LOG_READ_PERMISSIONS,
  SCHEDULE_READ_PERMISSIONS,
  type DependencyType,
  type MilestoneStatus,
  type Permission,
  type ProgressBasis,
  type ProjectStatus,
  type ScheduleItemKind,
} from "@pm-buddy/types";
import type {
  ScheduleBaselineSummary,
  ScheduleDependency,
  ScheduleItem,
  ScheduleResponse,
} from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { toCalendarDate } from "../projects/project-mappers.js";

/**
 * Loads a project's schedule and computes it with the shared CPM engine (packages/domain
 * computeSchedule): planned dates are never stored on activities; they follow from durations,
 * links, constraints, actual dates, the calendar and today's data date (Africa/Nairobi).
 */

type Tx = Prisma.TransactionClient;
export type ActivityRow = Prisma.ScheduleActivityGetPayload<{
  include: {
    bqItem: { select: { ref: true; description: true; versionId: true; lineageId: true } };
  };
}>;
export type DependencyRow = Prisma.ScheduleDependencyGetPayload<object>;
export type MilestoneRow = Prisma.MilestoneGetPayload<object>;
export type BaselineRow = Prisma.ScheduleBaselineGetPayload<object>;
export type BaselineItemRow = Prisma.ScheduleBaselineItemGetPayload<object>;

/** Stable problem codes of the schedule (the web maps them to EN/SW messages). */
export type ScheduleProblem =
  | "version-conflict"
  | "project-read-only"
  | "activity-code-taken"
  | "activity-started"
  | "activity-in-use"
  | "too-many-activities"
  | "too-many-dependencies"
  | "dependency-exists"
  | "schedule-cycle"
  | "milestone-cancelled"
  | "schedule-out-of-range"
  | "schedule-empty"
  | "too-many-baselines"
  | "bq-item-not-found"
  | "actual-date-future"
  | "finish-without-start"
  | "finish-before-start"
  | "progress-without-start"
  | "progress-inconsistent"
  | "quantity-invalid"
  | "delay-withdrawn"
  | "delay-date-future"
  | "delay-dates-invalid"
  | "delay-days-exceed-range";

export const scheduleProblem = (status: number, code: ScheduleProblem, message: string) =>
  new HttpException({ code, message }, status);
export const scheduleVersionConflict = () =>
  scheduleProblem(
    409,
    "version-conflict",
    "This record was changed by someone else. Reload and try again.",
  );

export type ScheduleProject = { id: string; status: string; startDate: Date | null };

export type ScheduleData = {
  project: ScheduleProject;
  canEdit: boolean;
  settings: { workingWeekdays: number[]; includePublicHolidays: boolean; version: number };
  holidays: string[];
  calendar: WorkingCalendar;
  start: { date: string; source: "project_start" | "today" };
  dataDate: string;
  tasks: ActivityRow[];
  links: ActivityRow[];
  milestones: MilestoneRow[];
  dependencies: DependencyRow[];
  wbsOrder: Map<string, number>;
  /** Tasks named by any delay version (they cannot be deleted). */
  delayed: Set<string>;
};

/**
 * 403 unless the caller holds one of `permissions` on the project (on top of `projects.view`):
 * the schedule is for people working on the project, the delay log for the contractor's staff.
 */
function requireAnyOf(effective: ReadonlySet<Permission>, permissions: readonly Permission[]) {
  if (!permissions.some((permission) => effective.has(permission)))
    throw new ForbiddenException(`One of these permissions is required: ${permissions.join(", ")}`);
}
export const requireScheduleReader = (effective: ReadonlySet<Permission>) =>
  requireAnyOf(effective, SCHEDULE_READ_PERMISSIONS);
export const requireDelayLogReader = (effective: ReadonlySet<Permission>) =>
  requireAnyOf(effective, DELAY_LOG_READ_PERMISSIONS);

/** Whether the caller may change this project's schedule (role ∩ assignment, project open). */
export const canEditSchedule = (
  effective: ReadonlySet<Permission>,
  project: { status: string },
): boolean =>
  effective.has("projects.manage") && !isProjectReadOnly(project.status as ProjectStatus);

/** The project's working calendar (defaults when never saved: Monday–Saturday plus holidays). */
export async function loadCalendar(tx: Tx, tenantId: string, projectId: string) {
  const [row, holidayRows] = await Promise.all([
    tx.scheduleSettings.findUnique({ where: { tenantId_projectId: { tenantId, projectId } } }),
    tx.publicHoliday.findMany({ where: { tenantId }, select: { holidayDate: true } }),
  ]);
  const settings = row
    ? {
        workingWeekdays: row.workingWeekdays,
        includePublicHolidays: row.includePublicHolidays,
        version: row.version,
      }
    : { workingWeekdays: [...DEFAULT_WORKING_WEEKDAYS], includePublicHolidays: true, version: 0 };
  const holidays = settings.includePublicHolidays
    ? holidayRows.map((holiday) => toCalendarDate(holiday.holidayDate))
    : [];
  return { settings, holidays, calendar: workingCalendar(settings.workingWeekdays, holidays) };
}

export async function loadSchedule(
  tx: Tx,
  tenantId: string,
  project: ScheduleProject,
  effective: ReadonlySet<Permission>,
): Promise<ScheduleData> {
  const projectId = project.id;
  const [calendar, activities, milestones, dependencies, nodes, delayLinks] = await Promise.all([
    loadCalendar(tx, tenantId, projectId),
    tx.scheduleActivity.findMany({
      where: { tenantId, projectId },
      include: {
        bqItem: { select: { ref: true, description: true, versionId: true, lineageId: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.milestone.findMany({
      where: { tenantId, projectId },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    }),
    tx.scheduleDependency.findMany({
      where: { tenantId, projectId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.wbsNode.findMany({
      where: { tenantId, projectId },
      select: { id: true, parentId: true, sortOrder: true, createdAt: true },
    }),
    tx.scheduleDelayActivity.findMany({
      where: { tenantId, projectId },
      select: { activityId: true },
      distinct: ["activityId"],
    }),
  ]);
  const dataDate = nairobiDate();
  return {
    project,
    canEdit: canEditSchedule(effective, project),
    ...calendar,
    start: project.startDate
      ? { date: toCalendarDate(project.startDate), source: "project_start" }
      : { date: dataDate, source: "today" },
    dataDate,
    tasks: activities.filter((row) => row.kind === "task"),
    links: activities.filter((row) => row.kind === "milestone"),
    milestones,
    dependencies,
    wbsOrder: treeOrder(nodes),
    delayed: new Set(delayLinks.map((link) => link.activityId)),
  };
}

/** WBS nodes in tree order (parents before children, siblings by sort order). */
function treeOrder(
  nodes: readonly { id: string; parentId: string | null; sortOrder: number; createdAt: Date }[],
): Map<string, number> {
  const children = new Map<string | null, (typeof nodes)[number][]>();
  for (const node of nodes)
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const order = new Map<string, number>();
  const visit = (parentId: string | null, depth: number) => {
    if (depth > 10) return;
    const siblings = [...(children.get(parentId) ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    for (const node of siblings) {
      order.set(node.id, order.size);
      visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  return order;
}

/** Engine keys: tasks by activity ID, milestones by milestone ID. */
export const taskKey = (id: string) => `task:${id}`;
export const milestoneKey = (id: string) => `milestone:${id}`;

export type Computed = {
  items: Map<string, ScheduledItem>;
  dependencies: Map<string, { driving: boolean; critical: boolean }>;
  finish: string | null;
};

/** Runs CPM over the tasks and every milestone that is not cancelled. */
export function compute(data: ScheduleData): Computed {
  const keyOfActivity = new Map<string, string>();
  for (const task of data.tasks) keyOfActivity.set(task.id, taskKey(task.id));
  const live = data.milestones.filter((milestone) => milestone.status !== "cancelled");
  const liveIds = new Set(live.map((milestone) => milestone.id));
  for (const link of data.links)
    if (link.milestoneId && liveIds.has(link.milestoneId))
      keyOfActivity.set(link.id, milestoneKey(link.milestoneId));

  const items: ScheduleItemInput[] = [
    ...data.tasks.map((task): ScheduleItemInput => ({
      id: taskKey(task.id),
      kind: "task",
      durationDays: task.durationDays,
      startNoEarlierThan: date(task.startNoEarlierThan),
      actualStart: date(task.actualStart),
      actualFinish: date(task.actualFinish),
      percentComplete: task.percentComplete === null ? null : task.percentComplete.toNumber(),
    })),
    ...live.map((milestone): ScheduleItemInput => ({
      id: milestoneKey(milestone.id),
      kind: "milestone",
      targetDate: toCalendarDate(milestone.dueDate),
      actualDate: milestone.status === "achieved" ? date(milestone.actualDate) : null,
    })),
  ];
  // Links touching a cancelled milestone stay stored but leave the network.
  const dependencies = data.dependencies.flatMap((dependency) => {
    const predecessorId = keyOfActivity.get(dependency.predecessorId);
    const successorId = keyOfActivity.get(dependency.successorId);
    return predecessorId && successorId
      ? [
          {
            id: dependency.id,
            predecessorId,
            successorId,
            type: dependency.type as DependencyType,
            lagDays: dependency.lagDays,
          },
        ]
      : [];
  });
  let result: ReturnType<typeof computeSchedule>;
  try {
    result = computeSchedule({
      calendar: data.calendar,
      start: data.start.date,
      dataDate: data.dataDate,
      items,
      dependencies,
    });
  } catch (error) {
    if (error instanceof RangeError)
      throw scheduleProblem(
        422,
        "schedule-out-of-range",
        "The schedule reaches too far from the project start; check the dates and durations",
      );
    throw error;
  }
  // The database refuses cycles, so a failure here is a defect, never a user error.
  if (!result.ok) throw new InternalServerErrorException("The stored schedule is inconsistent");
  return {
    items: new Map(result.items.map((item) => [item.id, item])),
    dependencies: new Map(
      result.dependencies.map(({ id, driving, critical }) => [id, { driving, critical }]),
    ),
    finish: result.finish,
  };
}

const date = (value: Date | null) => (value ? toCalendarDate(value) : null);

function progressOf(task: ActivityRow): ScheduleItem["progress"] {
  return {
    basis: task.progressBasis as ProgressBasis,
    percentComplete: task.percentComplete === null ? null : task.percentComplete.toNumber(),
    quantityDone: task.quantityDone === null ? null : task.quantityDone.toFixed(),
    quantityTotal: task.quantityTotal === null ? null : task.quantityTotal.toFixed(),
    quantityUnit: task.quantityUnit,
  };
}

export function baselineSummary(
  row: BaselineRow,
  currentId: string | null,
  people: ReadonlyMap<string, string>,
): ScheduleBaselineSummary {
  return {
    id: row.id,
    number: row.baselineNo,
    name: row.name,
    reason: row.reason,
    dataDate: toCalendarDate(row.dataDate),
    projectFinish: date(row.projectFinish),
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy, displayName: people.get(row.createdBy) ?? "—" },
    current: row.id === currentId,
    permissions: { canEdit: false, canDelete: false },
  };
}

type SortKey = [number, string, number, string];

/** The whole schedule response: items, links, the compared baseline and its variance. */
export function assembleSchedule(
  data: ScheduleData,
  computed: Computed,
  compared: { baseline: BaselineRow; items: BaselineItemRow[] } | null,
  currentBaselineId: string | null,
  people: ReadonlyMap<string, string>,
): ScheduleResponse {
  const { calendar } = data;
  const baselineItems = new Map(
    (compared?.items ?? []).map((item) => [`${item.kind}:${item.refId}`, item]),
  );
  const against = (
    kind: ScheduleItemKind,
    id: string,
    planned: { start: string; finish: string },
  ) => {
    const base = baselineItems.get(`${kind}:${id}`);
    if (!base) return { baseline: null, variance: { startDays: null, finishDays: null } };
    const start = toCalendarDate(base.startDate);
    const finish = toCalendarDate(base.finishDate);
    return {
      baseline: { start, finish },
      variance: {
        startDays: kind === "task" ? workingDayVariance(calendar, start, planned.start) : null,
        finishDays: workingDayVariance(calendar, finish, planned.finish),
      },
    };
  };
  const wbsRank = (nodeId: string | null) =>
    nodeId ? (data.wbsOrder.get(nodeId) ?? 9_999) : 10_000;
  const linkOf = new Map(data.links.map((link) => [link.milestoneId, link.id]));
  const rows: { item: ScheduleItem; key: SortKey }[] = [];
  for (const task of data.tasks) {
    const scheduled = computed.items.get(taskKey(task.id))!;
    const planned = { start: scheduled.start, finish: scheduled.finish };
    rows.push({
      key: [wbsRank(task.wbsNodeId), planned.start, 0, task.code ?? ""],
      item: {
        kind: "task",
        id: task.id,
        activityId: task.id,
        code: task.code,
        name: task.name ?? "",
        wbsNodeId: task.wbsNodeId,
        bqItem: task.bqItem
          ? {
              lineageId: task.bqItem.lineageId,
              versionId: task.bqItem.versionId,
              ref: task.bqItem.ref,
              description: task.bqItem.description,
            }
          : null,
        durationDays: task.durationDays,
        startNoEarlierThan: date(task.startNoEarlierThan),
        dueDate: null,
        milestoneStatus: null,
        actualStart: date(task.actualStart),
        actualFinish: date(task.actualFinish),
        progress: progressOf(task),
        status: scheduled.status,
        planned,
        late: { start: scheduled.lateStart, finish: scheduled.lateFinish },
        totalFloatDays: scheduled.totalFloatDays,
        critical: scheduled.critical,
        ...against("task", task.id, planned),
        version: task.version,
        permissions: {
          canEdit: data.canEdit,
          canRecordProgress: data.canEdit,
          canDelete: data.canEdit && !task.actualStart && !data.delayed.has(task.id),
        },
      },
    });
  }
  for (const milestone of data.milestones) {
    if (milestone.status === "cancelled") continue;
    const scheduled = computed.items.get(milestoneKey(milestone.id))!;
    const planned = { start: scheduled.start, finish: scheduled.finish };
    rows.push({
      key: [wbsRank(milestone.wbsNodeId), planned.finish, 1, milestone.name],
      item: {
        kind: "milestone",
        id: milestone.id,
        activityId: linkOf.get(milestone.id) ?? null,
        code: null,
        name: milestone.name,
        wbsNodeId: milestone.wbsNodeId,
        bqItem: null,
        durationDays: 0,
        startNoEarlierThan: null,
        dueDate: toCalendarDate(milestone.dueDate),
        milestoneStatus: milestone.status as MilestoneStatus,
        actualStart: null,
        actualFinish: milestone.status === "achieved" ? date(milestone.actualDate) : null,
        progress: null,
        status: scheduled.status,
        planned,
        late: { start: scheduled.lateStart, finish: scheduled.lateFinish },
        totalFloatDays: scheduled.totalFloatDays,
        critical: scheduled.critical,
        ...against("milestone", milestone.id, planned),
        version: null,
        // Milestones are edited on the WBS tab; the schedule only links them.
        permissions: { canEdit: false, canRecordProgress: false, canDelete: false },
      },
    });
  }
  rows.sort(
    ({ key: a }, { key: b }) =>
      a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || a[3].localeCompare(b[3]),
  );

  const refOf = new Map<string, { kind: ScheduleItemKind; id: string }>();
  for (const task of data.tasks) refOf.set(task.id, { kind: "task", id: task.id });
  for (const link of data.links)
    if (link.milestoneId) refOf.set(link.id, { kind: "milestone", id: link.milestoneId });
  const dependencies: ScheduleDependency[] = data.dependencies.map((dependency) => {
    const flags = computed.dependencies.get(dependency.id) ?? { driving: false, critical: false };
    return {
      id: dependency.id,
      predecessor: refOf.get(dependency.predecessorId)!,
      successor: refOf.get(dependency.successorId)!,
      type: dependency.type as DependencyType,
      lagDays: dependency.lagDays,
      version: dependency.version,
      driving: flags.driving,
      critical: flags.critical,
      permissions: { canEdit: data.canEdit, canDelete: data.canEdit },
    };
  });

  const present = new Set(rows.map(({ item }) => `${item.kind}:${item.id}`));
  const baselineFinish = compared ? date(compared.baseline.projectFinish) : null;
  return {
    projectId: data.project.id,
    calendar: {
      workingWeekdays: [...data.settings.workingWeekdays].sort((a, b) => a - b),
      includePublicHolidays: data.settings.includePublicHolidays,
      holidaysApplied: data.holidays.length,
      version: data.settings.version,
    },
    start: data.start,
    dataDate: data.dataDate,
    items: rows.map(({ item }) => item),
    dependencies,
    finish: computed.finish,
    baseline: compared ? baselineSummary(compared.baseline, currentBaselineId, people) : null,
    currentBaselineId,
    projectVariance: {
      baselineFinish,
      finish: computed.finish,
      finishDays: workingDayVariance(calendar, baselineFinish, computed.finish),
    },
    removedSinceBaseline: (compared?.items ?? [])
      .filter((item) => !present.has(`${item.kind}:${item.refId}`))
      .map((item) => ({
        kind: item.kind as ScheduleItemKind,
        id: item.refId,
        code: item.code,
        name: item.name,
      })),
    progress: {
      basis: "duration_weighted_physical",
      ratio: scheduleProgress(
        data.tasks.map((task) => ({
          durationDays: task.durationDays,
          status: computed.items.get(taskKey(task.id))!.status,
          percentComplete: task.percentComplete === null ? null : task.percentComplete.toNumber(),
        })),
      ),
    },
    permissions: {
      canEdit: data.canEdit,
      canBaseline: data.canEdit,
      canRecordDelay: data.canEdit,
    },
  };
}
