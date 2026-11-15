import type { INestApplicationContext } from "@nestjs/common";
import {
  checkActivityProgress,
  checkDelayDays,
  nairobiDate,
  type ProgressInput,
} from "@pm-buddy/domain";
import type { DelayCause, DelayClaimFlag, DependencyType } from "@pm-buddy/types";
import type { Prisma } from "../generated/prisma/client.js";
import { uuidv7 } from "../common/uuid.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { fromCalendarDate } from "../modules/projects/project-mappers.js";
import {
  compute,
  loadSchedule,
  milestoneKey,
  taskKey,
} from "../modules/schedule/schedule-model.js";

/**
 * D6.2 demo schedule for RUI-HTS (synthetic): 22 activities across the WBS with FS/SS links and a
 * lead, the project's milestones linked into the network, the contract programme frozen as
 * baseline 1 (as planned on the start date, 2 March 2026), then actual dates and progress that
 * slipped (long rains, late reinforcement, a client instruction), and three delays with causes.
 * The current schedule therefore shows variance against the baseline. Everything goes through the
 * runtime role, so RLS and the schedule triggers apply. Idempotent: skipped when RUI-HTS already
 * has activities.
 */

export type ScheduleSeedSummary = {
  created: boolean;
  activities: number;
  dependencies: number;
  baselines: number;
  delays: number;
};

type DemoActivity = {
  code: string;
  name: string;
  wbs: string;
  days: number;
  after?: { code: string; type?: DependencyType; lag?: number }[];
};

/** Codes of the activities; `M:` names a milestone of the project. */
const ACTIVITIES: readonly DemoActivity[] = [
  { code: "P01", name: "Site establishment and hoarding", wbs: "1", days: 12 },
  { code: "P02", name: "Setting out", wbs: "1", days: 4, after: [{ code: "P01" }] },
  { code: "S01", name: "Excavation to foundations", wbs: "2", days: 20, after: [{ code: "P02" }] },
  {
    code: "S02",
    name: "Strip footings and columns bases",
    wbs: "2",
    days: 22,
    after: [{ code: "S01" }],
  },
  { code: "S03", name: "Substructure walling", wbs: "2", days: 16, after: [{ code: "S02" }] },
  {
    code: "S04",
    name: "Ground floor slab",
    wbs: "2",
    days: 12,
    after: [{ code: "S03", type: "SS", lag: 10 }],
  },
  {
    code: "G01",
    name: "Ground floor columns",
    wbs: "3.1",
    days: 14,
    after: [{ code: "M:Substructure complete" }],
  },
  {
    code: "G02",
    name: "Ground floor walling",
    wbs: "3.1",
    days: 18,
    after: [{ code: "G01", type: "SS", lag: 5 }],
  },
  { code: "G03", name: "First floor slab", wbs: "3.1", days: 20, after: [{ code: "G01" }] },
  {
    code: "F01",
    name: "First floor columns and walling",
    wbs: "3.2",
    days: 24,
    after: [{ code: "M:First floor slab cast" }],
  },
  { code: "F02", name: "Second floor slab", wbs: "3.2", days: 20, after: [{ code: "F01" }] },
  {
    code: "T01",
    name: "Second floor columns and walling",
    wbs: "3.3",
    days: 22,
    after: [{ code: "F02" }],
  },
  { code: "T02", name: "Third floor slab", wbs: "3.3", days: 20, after: [{ code: "T01" }] },
  { code: "R01", name: "Third floor walling", wbs: "3.4", days: 18, after: [{ code: "T02" }] },
  {
    code: "R02",
    name: "Roof beam",
    wbs: "3.4",
    days: 10,
    after: [{ code: "R01", type: "FS", lag: -3 }],
  },
  {
    code: "R03",
    name: "Roof structure and covering",
    wbs: "3.4",
    days: 22,
    after: [{ code: "M:Roof beam cast" }],
  },
  {
    code: "E01",
    name: "Electrical first fix",
    wbs: "5",
    days: 30,
    after: [{ code: "F02", type: "SS", lag: 10 }],
  },
  {
    code: "E02",
    name: "Plumbing and drainage first fix",
    wbs: "5",
    days: 30,
    after: [{ code: "F02", type: "SS", lag: 12 }],
  },
  { code: "N01", name: "Internal plaster", wbs: "4", days: 30, after: [{ code: "T02", lag: 5 }] },
  {
    code: "N02",
    name: "Floor and wall tiling",
    wbs: "4",
    days: 26,
    after: [{ code: "N01", type: "SS", lag: 12 }],
  },
  {
    code: "N03",
    name: "Painting and decoration",
    wbs: "4",
    days: 24,
    after: [{ code: "N02" }, { code: "M:Roof covered" }],
  },
  {
    code: "N04",
    name: "External works and cleaning",
    wbs: "1",
    days: 18,
    after: [{ code: "R03" }],
  },
];

/** Milestone links (milestone ← predecessors). */
const MILESTONE_LINKS: readonly { milestone: string; after: string[] }[] = [
  { milestone: "Substructure complete", after: ["S04"] },
  { milestone: "First floor slab cast", after: ["G03"] },
  { milestone: "Roof beam cast", after: ["R02"] },
  { milestone: "Roof covered", after: ["R03"] },
  { milestone: "Practical completion", after: ["N03", "N04", "E01", "E02"] },
];

/** Actual dates and physical progress recorded on site (synthetic; dates in 2026). */
const ACTUALS: readonly ({ code: string } & Pick<
  ProgressInput,
  "actualStart" | "actualFinish" | "percentComplete"
>)[] = [
  { code: "P01", actualStart: "2026-03-02", actualFinish: "2026-03-17", percentComplete: null },
  { code: "P02", actualStart: "2026-03-18", actualFinish: "2026-03-23", percentComplete: null },
  { code: "S01", actualStart: "2026-03-24", actualFinish: "2026-04-30", percentComplete: null },
  { code: "S02", actualStart: "2026-05-02", actualFinish: "2026-05-30", percentComplete: null },
  { code: "S03", actualStart: "2026-06-02", actualFinish: "2026-06-20", percentComplete: null },
  { code: "S04", actualStart: "2026-06-12", actualFinish: "2026-06-25", percentComplete: null },
  { code: "G01", actualStart: "2026-06-29", actualFinish: "2026-07-17", percentComplete: null },
  { code: "G02", actualStart: "2026-07-06", actualFinish: "2026-08-04", percentComplete: null },
  { code: "G03", actualStart: "2026-07-20", actualFinish: "2026-09-17", percentComplete: null },
  { code: "F01", actualStart: "2026-09-21", actualFinish: "2026-10-27", percentComplete: null },
  { code: "F02", actualStart: "2026-10-28", actualFinish: null, percentComplete: 55 },
  { code: "E01", actualStart: "2026-11-09", actualFinish: null, percentComplete: 10 },
];

const DELAYS: readonly {
  cause: DelayCause;
  startDate: string;
  endDate: string;
  days: number;
  description: string;
  claimFlag: DelayClaimFlag;
  activities: string[];
}[] = [
  {
    cause: "weather",
    startDate: "2026-04-13",
    endDate: "2026-04-18",
    days: 4.5,
    description:
      "Long rains flooded the foundation trenches; pumping and re-excavation of collapsed sides (synthetic demo record).",
    claimFlag: "excusable",
    activities: ["S01"],
  },
  {
    cause: "supplier_material",
    startDate: "2026-08-17",
    endDate: "2026-08-22",
    days: 5,
    description:
      "Y12 and Y16 reinforcement delivered a week late; first floor slab steel fixing stood down (synthetic demo record).",
    claimFlag: "not_assessed",
    activities: ["G03"],
  },
  {
    cause: "client_instruction",
    startDate: "2026-09-28",
    endDate: "2026-10-03",
    days: 4,
    description:
      "Client instruction to revise the first-floor balcony details; walling held while drawings were reissued (synthetic demo record).",
    claimFlag: "compensable",
    activities: ["F01"],
  },
];

const BASELINE_DATE = "2026-03-02";

export async function seedSchedule(
  app: INestApplicationContext,
  tenantId: string,
  ownerId: string,
): Promise<ScheduleSeedSummary> {
  const db = app.get(TenantDatabase);
  return db.run({ userId: ownerId, tenantId, requestId: "seed" }, async (tx) => {
    await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    const project = await tx.project.findUnique({
      where: { tenantId_code: { tenantId, code: "RUI-HTS" } },
    });
    if (!project) throw new Error("The RUI-HTS demo project is missing");
    const counts = async (created: boolean): Promise<ScheduleSeedSummary> => ({
      created,
      activities: await tx.scheduleActivity.count({
        where: { tenantId, projectId: project.id, kind: "task" },
      }),
      dependencies: await tx.scheduleDependency.count({
        where: { tenantId, projectId: project.id },
      }),
      baselines: await tx.scheduleBaseline.count({ where: { tenantId, projectId: project.id } }),
      delays: await tx.scheduleDelay.count({
        where: { tenantId, projectId: project.id, versionNo: 1 },
      }),
    });
    if (await tx.scheduleActivity.count({ where: { tenantId, projectId: project.id } }))
      return counts(false);
    const audit = (action: string, resourceId: string, metadata: Prisma.InputJsonValue) =>
      tx.auditEvent.create({
        data: { tenantId, actorId: ownerId, requestId: "seed", action, resourceId, metadata },
      });

    const nodes = new Map(
      (
        await tx.wbsNode.findMany({
          where: { tenantId, projectId: project.id },
          select: { id: true, code: true },
        })
      ).map((node) => [node.code, node.id]),
    );
    const milestones = new Map(
      (
        await tx.milestone.findMany({
          where: { tenantId, projectId: project.id },
          select: { id: true, name: true },
        })
      ).map((milestone) => [milestone.name, milestone.id]),
    );
    const rowIds = new Map<string, string>();
    for (const demo of ACTIVITIES) {
      const row = await tx.scheduleActivity.create({
        data: {
          tenantId,
          projectId: project.id,
          kind: "task",
          code: demo.code,
          name: demo.name,
          wbsNodeId: nodes.get(demo.wbs) ?? null,
          durationDays: demo.days,
          progressBasis: "physical",
          createdBy: ownerId,
          updatedBy: ownerId,
        },
      });
      rowIds.set(demo.code, row.id);
      await audit("schedule.activity_created", row.id, {
        source: "seed",
        projectId: project.id,
        code: demo.code,
        durationDays: demo.days,
      });
    }
    const linkFor = async (name: string) => {
      const key = `M:${name}`;
      const existing = rowIds.get(key);
      if (existing) return existing;
      const milestoneId = milestones.get(name);
      if (!milestoneId) throw new Error(`Demo milestone ${name} is missing`);
      const row = await tx.scheduleActivity.create({
        data: {
          tenantId,
          projectId: project.id,
          kind: "milestone",
          milestoneId,
          durationDays: 0,
          createdBy: ownerId,
          updatedBy: ownerId,
        },
      });
      rowIds.set(key, row.id);
      return row.id;
    };
    const links: { predecessor: string; successor: string; type: DependencyType; lag: number }[] =
      [];
    for (const demo of ACTIVITIES)
      for (const after of demo.after ?? [])
        links.push({
          predecessor: after.code,
          successor: demo.code,
          type: after.type ?? "FS",
          lag: after.lag ?? 0,
        });
    for (const { milestone, after } of MILESTONE_LINKS)
      for (const code of after)
        links.push({ predecessor: code, successor: `M:${milestone}`, type: "FS", lag: 0 });
    for (const link of links) {
      const resolve = (code: string) =>
        code.startsWith("M:") ? linkFor(code.slice(2)) : Promise.resolve(rowIds.get(code)!);
      const row = await tx.scheduleDependency.create({
        data: {
          tenantId,
          projectId: project.id,
          predecessorId: await resolve(link.predecessor),
          successorId: await resolve(link.successor),
          type: link.type,
          lagDays: link.lag,
          createdBy: ownerId,
          updatedBy: ownerId,
        },
      });
      await audit("schedule.dependency_created", row.id, {
        source: "seed",
        projectId: project.id,
        type: link.type,
        lagDays: link.lag,
      });
    }

    // Baseline 1: the contract programme as planned on the start date (nothing achieved yet).
    const effective = new Set(["projects.view", "projects.manage"] as const);
    const loaded = await loadSchedule(tx, tenantId, project, effective);
    const planned = compute({
      ...loaded,
      dataDate: BASELINE_DATE,
      milestones: loaded.milestones.map((milestone) =>
        milestone.status === "cancelled"
          ? milestone
          : { ...milestone, status: "planned", actualDate: null },
      ),
    });
    const items = [
      ...loaded.tasks.map((task) => ({
        kind: "task",
        refId: task.id,
        code: task.code,
        name: task.name ?? "",
        wbsNodeId: task.wbsNodeId,
        scheduled: planned.items.get(taskKey(task.id))!,
      })),
      ...loaded.milestones
        .filter((milestone) => milestone.status !== "cancelled")
        .map((milestone) => ({
          kind: "milestone",
          refId: milestone.id,
          code: null,
          name: milestone.name,
          wbsNodeId: milestone.wbsNodeId,
          scheduled: planned.items.get(milestoneKey(milestone.id))!,
        })),
    ];
    const baselineId = uuidv7();
    await tx.scheduleBaseline.create({
      data: {
        id: baselineId,
        tenantId,
        projectId: project.id,
        baselineNo: 1,
        name: "Contract programme",
        reason: "Programme agreed with the client at the site handover meeting (demo data)",
        dataDate: fromCalendarDate(BASELINE_DATE),
        startDate: fromCalendarDate(loaded.start.date),
        projectFinish: planned.finish ? fromCalendarDate(planned.finish) : null,
        workingWeekdays: loaded.settings.workingWeekdays,
        includePublicHolidays: loaded.settings.includePublicHolidays,
        itemCount: items.length,
        createdBy: ownerId,
      },
    });
    await tx.scheduleBaselineItem.createMany({
      data: items.map(({ scheduled, ...item }) => ({
        ...item,
        tenantId,
        baselineId,
        startDate: fromCalendarDate(scheduled.start),
        finishDate: fromCalendarDate(scheduled.finish),
        durationDays: scheduled.durationDays,
        totalFloatDays: scheduled.totalFloatDays,
        critical: scheduled.critical,
      })),
    });
    await audit("schedule.baseline_created", baselineId, {
      source: "seed",
      projectId: project.id,
      number: 1,
      itemCount: items.length,
      reasonGiven: true,
    });

    // What actually happened on site.
    const today = nairobiDate();
    for (const actual of ACTUALS) {
      if ((actual.actualStart ?? "") > today) continue;
      const check = checkActivityProgress(
        {
          actualStart: actual.actualStart,
          actualFinish:
            actual.actualFinish && actual.actualFinish <= today ? actual.actualFinish : null,
          basis: "physical",
          percentComplete:
            actual.actualFinish && actual.actualFinish <= today ? null : actual.percentComplete,
          quantityDone: null,
          quantityTotal: null,
          quantityUnit: null,
        },
        today,
      );
      if (!check.ok) throw new Error(`Demo progress for ${actual.code} is invalid: ${check.error}`);
      const id = rowIds.get(actual.code)!;
      await tx.scheduleActivity.update({
        where: { tenantId_id: { tenantId, id } },
        data: {
          actualStart: actual.actualStart ? fromCalendarDate(actual.actualStart) : null,
          actualFinish:
            check.status === "complete" && actual.actualFinish
              ? fromCalendarDate(actual.actualFinish)
              : null,
          percentComplete: check.percentComplete,
          version: { increment: 1 },
          updatedBy: ownerId,
        },
      });
      await audit("schedule.progress_recorded", id, {
        source: "seed",
        projectId: project.id,
        status: check.status,
        basis: "physical",
      });
    }

    const calendar = loaded.calendar;
    for (const [index, delay] of DELAYS.entries()) {
      if (delay.endDate > today) continue;
      const check = checkDelayDays(
        calendar,
        { startDate: delay.startDate, endDate: delay.endDate, workingDaysLost: delay.days },
        today,
      );
      if (!check.ok) throw new Error(`Demo delay ${index + 1} is invalid: ${check.error}`);
      const id = uuidv7();
      await tx.scheduleDelay.create({
        data: {
          id,
          tenantId,
          projectId: project.id,
          delayId: id,
          delayNo: index + 1,
          versionNo: 1,
          status: "recorded",
          cause: delay.cause,
          startDate: fromCalendarDate(delay.startDate),
          endDate: fromCalendarDate(delay.endDate),
          workingDaysLost: delay.days,
          description: delay.description,
          claimFlag: delay.claimFlag,
          recordedBy: ownerId,
        },
      });
      await tx.scheduleDelayActivity.createMany({
        data: delay.activities.map((code) => ({
          tenantId,
          projectId: project.id,
          delayVersionId: id,
          activityId: rowIds.get(code)!,
        })),
      });
      await audit("schedule.delay_recorded", id, {
        source: "seed",
        projectId: project.id,
        number: index + 1,
        cause: delay.cause,
        claimFlag: delay.claimFlag,
        activityCount: delay.activities.length,
      });
    }
    return counts(true);
  });
}
