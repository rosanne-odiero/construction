import type { ActivityStatus, DependencyType, ScheduleItemKind } from "@pm-buddy/types";
import { WorkdayIndex, type WorkingCalendar } from "./calendar.js";

/**
 * Critical path method (CPM) for the project schedule (D6.2, brief §5.9). Pure: the API, the web
 * mock and the tests share it.
 *
 * Time model. Working days are numbered from the project start (WorkdayIndex). An item occupies
 * the half-open range [s, f) of working-day boundaries: a task of duration d starting on working
 * day s finishes at boundary f = s + d, so its finish DATE is working day f − 1. A milestone is a
 * zero-duration marker at a boundary b, shown as the END of working day b − 1 (a finish
 * milestone): "Substructure complete" after a task falls on that task's finish date, and a
 * finish-to-start successor starts the next working day.
 *
 * Forward pass (early dates), for predecessor P and successor S with lag L (working days):
 *   FS: s(S) ≥ f(P) + L   SS: s(S) ≥ s(P) + L   FF: f(S) ≥ f(P) + L   SF: f(S) ≥ s(P) + L
 * plus the project start (s ≥ 0), an optional "start no earlier than" date and, with a data
 * date, "remaining work is never scheduled before today".
 *
 * Progress (data date). A complete task keeps its actual dates. A task in progress keeps its
 * actual start and finishes after its remaining duration counted from the data date: remaining =
 * duration × (100 − % complete) ÷ 100 rounded up (at least one day); without a reported
 * percentage it keeps its planned finish, or today if that has passed. Started tasks are not
 * moved by their predecessors (progress overrides logic). An achieved milestone keeps its date;
 * a milestone without predecessors sits at its due date.
 *
 * Backward pass (late dates) from the project finish F over unfinished items whose successors
 * have not started: LF(P) ≤ LS(S) − L (FS), LS(S) − L + d(P) (SS), LF(S) − L (FF),
 * LF(S) − L + d(P) (SF). Total float = LF − f; an unfinished item with zero float is critical.
 */

export type ScheduleTaskInput = {
  id: string;
  kind: "task";
  /** Working days, at least 1. */
  durationDays: number;
  startNoEarlierThan?: string | null;
  actualStart?: string | null;
  actualFinish?: string | null;
  /** Physical progress 0–100, or null when not reported. */
  percentComplete?: number | null;
};

export type ScheduleMilestoneInput = {
  id: string;
  kind: "milestone";
  /** The achieved date: the milestone is fixed there. */
  actualDate?: string | null;
  /** The due date: where the milestone sits when nothing drives it. */
  targetDate: string;
};

export type ScheduleItemInput = ScheduleTaskInput | ScheduleMilestoneInput;

export type ScheduleDependencyInput = {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
};

export type ScheduleInput = {
  calendar: WorkingCalendar;
  /** The project start: nothing is planned earlier unless it actually started earlier. */
  start: string;
  /** Today in Africa/Nairobi; null plans without progress (no data date). */
  dataDate: string | null;
  items: readonly ScheduleItemInput[];
  dependencies: readonly ScheduleDependencyInput[];
};

export type ScheduledItem = {
  id: string;
  kind: ScheduleItemKind;
  status: ActivityStatus;
  /** Scheduled (current) dates; for a milestone start = finish. */
  start: string;
  finish: string;
  /** Working days from start to finish, inclusive (0 for a milestone). */
  durationDays: number;
  lateStart: string | null;
  lateFinish: string | null;
  /** Null once complete. */
  totalFloatDays: number | null;
  critical: boolean;
};

export type ScheduledDependency = {
  id: string;
  /** This link sets the successor's early date (or finish, for FF/SF). */
  driving: boolean;
  /** Driving between two critical items: part of the critical path. */
  critical: boolean;
};

export type ScheduleResult =
  | {
      ok: true;
      items: ScheduledItem[];
      dependencies: ScheduledDependency[];
      /** Earliest scheduled start and latest scheduled finish; null for an empty schedule. */
      start: string | null;
      finish: string | null;
      /** Critical items in date order. */
      criticalPath: string[];
    }
  | { ok: false; error: "cycle"; cycle: string[] }
  | { ok: false; error: "unknown-item"; dependencyId: string };

/**
 * Finds a dependency cycle, if any: the returned IDs form a loop in order (first → … → first).
 * Kahn's algorithm removes every item that is not on or behind a cycle; a walk from what is left
 * names one loop.
 */
export function findDependencyCycle(
  itemIds: readonly string[],
  dependencies: readonly Pick<ScheduleDependencyInput, "predecessorId" | "successorId">[],
): string[] | null {
  const successors = new Map<string, string[]>(itemIds.map((id) => [id, []]));
  const incoming = new Map<string, number>(itemIds.map((id) => [id, 0]));
  for (const { predecessorId, successorId } of dependencies) {
    successors.get(predecessorId)?.push(successorId);
    incoming.set(successorId, (incoming.get(successorId) ?? 0) + 1);
  }
  const queue = itemIds.filter((id) => incoming.get(id) === 0);
  for (let index = 0; index < queue.length; index += 1)
    for (const next of successors.get(queue[index]!) ?? []) {
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) queue.push(next);
    }
  const remaining = new Set(itemIds.filter((id) => (incoming.get(id) ?? 0) > 0));
  if (!remaining.size) return null;
  // Every remaining item has a remaining predecessor, so walking predecessors must revisit one.
  const predecessorOf = new Map<string, string>();
  for (const { predecessorId, successorId } of dependencies)
    if (remaining.has(predecessorId) && remaining.has(successorId))
      predecessorOf.set(successorId, predecessorId);
  const seen = new Map<string, number>();
  const path: string[] = [];
  let current = remaining.values().next().value!;
  while (!seen.has(current)) {
    seen.set(current, path.length);
    path.push(current);
    current = predecessorOf.get(current)!;
  }
  return path.slice(seen.get(current)).reverse();
}

/**
 * Whether adding predecessor → successor would close a loop: true when the predecessor can
 * already be reached from the successor (or they are the same item).
 */
export function dependencyCreatesCycle(
  dependencies: readonly Pick<ScheduleDependencyInput, "predecessorId" | "successorId">[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) return true;
  const successors = new Map<string, string[]>();
  for (const dependency of dependencies)
    successors.set(dependency.predecessorId, [
      ...(successors.get(dependency.predecessorId) ?? []),
      dependency.successorId,
    ]);
  const stack = [successorId];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === predecessorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(successors.get(current) ?? []));
  }
  return false;
}

/** Status from actual dates (a milestone is complete once achieved). */
export function scheduleItemStatus(item: ScheduleItemInput): ActivityStatus {
  if (item.kind === "milestone") return item.actualDate ? "complete" : "not_started";
  if (item.actualFinish) return "complete";
  return item.actualStart ? "in_progress" : "not_started";
}

type Node = {
  input: ScheduleItemInput;
  status: ActivityStatus;
  /** Planned duration in working days (0 for milestones). */
  planned: number;
  s: number;
  f: number;
  lf: number | null;
  displayStart: string;
  displayFinish: string;
};

/**
 * A milestone at boundary b shows on working day b − 1 (the end of that day), while a task's start
 * boundary is the beginning of its first day. A link from a task's start (SS or SF) to a milestone
 * therefore adds one, so the milestone shows on the day the task starts, not the day before.
 */
function startToMilestone(
  dependency: ScheduleDependencyInput,
  predecessor: ScheduleItemInput,
  successor: ScheduleItemInput,
): number {
  return (dependency.type === "SS" || dependency.type === "SF") &&
    predecessor.kind === "task" &&
    successor.kind === "milestone"
    ? 1
    : 0;
}

/** Runs the forward and backward passes. */
export function computeSchedule(input: ScheduleInput): ScheduleResult {
  const ids = input.items.map((item) => item.id);
  const byId = new Map(input.items.map((item) => [item.id, item]));
  for (const dependency of input.dependencies)
    if (!byId.has(dependency.predecessorId) || !byId.has(dependency.successorId))
      return { ok: false, error: "unknown-item", dependencyId: dependency.id };
  const cycle = findDependencyCycle(ids, input.dependencies);
  if (cycle) return { ok: false, error: "cycle", cycle };

  const index = new WorkdayIndex(input.calendar, input.start);
  const dataIndex = input.dataDate === null ? null : index.onOrAfter(input.dataDate);
  const incoming = new Map<string, ScheduleDependencyInput[]>(ids.map((id) => [id, []]));
  const outgoing = new Map<string, ScheduleDependencyInput[]>(ids.map((id) => [id, []]));
  for (const dependency of input.dependencies) {
    incoming.get(dependency.successorId)!.push(dependency);
    outgoing.get(dependency.predecessorId)!.push(dependency);
  }
  const order = topologicalOrder(ids, input.dependencies);
  const nodes = new Map<string, Node>();
  const driving = new Set<string>();

  for (const id of order) {
    const item = byId.get(id)!;
    const status = scheduleItemStatus(item);
    const planned = item.kind === "task" ? item.durationDays : 0;
    // Lower bounds on the start boundary set by each predecessor link.
    const bounds = incoming.get(id)!.map((dependency) => {
      const predecessor = nodes.get(dependency.predecessorId)!;
      const from =
        dependency.type === "FS" || dependency.type === "FF" ? predecessor.f : predecessor.s;
      const onFinish = dependency.type === "FF" || dependency.type === "SF";
      return {
        id: dependency.id,
        value:
          from +
          dependency.lagDays -
          (onFinish ? planned : 0) +
          startToMilestone(dependency, predecessor.input, item),
      };
    });
    const logic = bounds.length ? Math.max(...bounds.map((bound) => bound.value)) : null;
    let node: Node;
    if (item.kind === "task") {
      if (item.actualStart) {
        const s = index.onOrAfter(item.actualStart);
        let f: number;
        if (item.actualFinish) f = Math.max(s, index.onOrBefore(item.actualFinish) + 1);
        else if (dataIndex === null) f = s + planned;
        else if (item.percentComplete !== null && item.percentComplete !== undefined) {
          const remaining = Math.max(1, Math.ceil((planned * (100 - item.percentComplete)) / 100));
          f = Math.max(s + 1, dataIndex + remaining);
        } else f = Math.max(s + planned, dataIndex + 1);
        node = makeNode(item, status, planned, s, f, index);
        if (item.actualFinish) node.displayFinish = item.actualFinish;
        node.displayStart = item.actualStart;
      } else {
        const floor = Math.max(
          0,
          item.startNoEarlierThan ? index.onOrAfter(item.startNoEarlierThan) : 0,
          dataIndex ?? 0,
        );
        const s = Math.max(floor, logic ?? floor);
        for (const bound of bounds)
          if (bound.value === s && bound.value >= floor) driving.add(bound.id);
        node = makeNode(item, status, planned, s, s + planned, index);
      }
    } else if (item.actualDate) {
      const b = index.onOrBefore(item.actualDate) + 1;
      node = makeNode(item, status, 0, b, b, index);
      node.displayStart = node.displayFinish = item.actualDate;
    } else {
      const floor = Math.max(1, dataIndex === null ? 1 : dataIndex + 1);
      const anchored = logic === null ? index.onOrAfter(item.targetDate) + 1 : logic;
      const b = Math.max(floor, anchored);
      for (const bound of bounds)
        if (bound.value === b && bound.value >= floor) driving.add(bound.id);
      node = makeNode(item, status, 0, b, b, index);
    }
    nodes.set(id, node);
  }

  const finishBoundary = nodes.size ? Math.max(...[...nodes.values()].map((node) => node.f)) : 0;
  for (const id of [...order].reverse()) {
    const node = nodes.get(id)!;
    if (node.status === "complete") continue;
    let lf = finishBoundary;
    const duration = node.f - node.s;
    for (const dependency of outgoing.get(id)!) {
      const successor = nodes.get(dependency.successorId)!;
      if (successor.status !== "not_started" || successor.lf === null) continue;
      const ls = successor.lf - (successor.f - successor.s);
      const lag = dependency.lagDays + startToMilestone(dependency, node.input, successor.input);
      const bound =
        dependency.type === "FS"
          ? ls - lag
          : dependency.type === "SS"
            ? ls - lag + duration
            : dependency.type === "FF"
              ? successor.lf - lag
              : successor.lf - lag + duration;
      lf = Math.min(lf, bound);
    }
    node.lf = lf;
  }

  const items: ScheduledItem[] = ids.map((id) => {
    const node = nodes.get(id)!;
    const milestone = node.input.kind === "milestone";
    const float = node.lf === null ? null : node.lf - node.f;
    const ls = node.lf === null ? null : node.lf - (node.f - node.s);
    return {
      id,
      kind: node.input.kind,
      status: node.status,
      start: node.displayStart,
      finish: node.displayFinish,
      durationDays: milestone ? 0 : Math.max(0, node.f - node.s),
      lateStart:
        ls === null || node.lf === null
          ? null
          : milestone
            ? index.dateOf(Math.max(node.lf - 1, 0))
            : index.dateOf(ls),
      lateFinish:
        node.lf === null ? null : index.dateOf(Math.max(node.lf - 1, milestone ? 0 : ls!)),
      totalFloatDays: float,
      critical: float !== null && float <= 0,
    };
  });
  const scheduled = new Map(items.map((item) => [item.id, item]));
  const dependencies = input.dependencies.map((dependency) => {
    const isDriving = driving.has(dependency.id);
    return {
      id: dependency.id,
      driving: isDriving,
      critical:
        isDriving &&
        scheduled.get(dependency.predecessorId)!.critical &&
        scheduled.get(dependency.successorId)!.critical,
    };
  });
  const criticalPath = items
    .filter((item) => item.critical)
    .sort((a, b) => a.start.localeCompare(b.start) || a.finish.localeCompare(b.finish))
    .map((item) => item.id);
  return {
    ok: true,
    items,
    dependencies,
    start: items.length ? items.map((item) => item.start).reduce((a, b) => (b < a ? b : a)) : null,
    finish: items.length
      ? items.map((item) => item.finish).reduce((a, b) => (b > a ? b : a))
      : null,
    criticalPath,
  };
}

function makeNode(
  input: ScheduleItemInput,
  status: ActivityStatus,
  planned: number,
  s: number,
  f: number,
  index: WorkdayIndex,
): Node {
  // A task's dates are its first and last working day; a milestone is the end of day b − 1.
  const finish = index.dateOf(Math.max(f - 1, input.kind === "milestone" ? 0 : s));
  return {
    input,
    status,
    planned,
    s,
    f,
    lf: null,
    displayStart: input.kind === "milestone" ? finish : index.dateOf(s),
    displayFinish: finish,
  };
}

/** Items in dependency order (predecessors first); ties keep the input order. */
function topologicalOrder(
  ids: readonly string[],
  dependencies: readonly ScheduleDependencyInput[],
): string[] {
  const position = new Map(ids.map((id, at) => [id, at]));
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { predecessorId, successorId } of dependencies) {
    successors.get(predecessorId)!.push(successorId);
    incoming.set(successorId, incoming.get(successorId)! + 1);
  }
  const ready = ids.filter((id) => incoming.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const next of successors.get(id)!) {
      const left = incoming.get(next)! - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return order;
}
