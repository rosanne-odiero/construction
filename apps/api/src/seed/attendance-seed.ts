import { createHash } from "node:crypto";
import type { INestApplicationContext } from "@nestjs/common";
import {
  addCalendarDays,
  isoWeekday,
  isPeriodDue,
  nairobiDate,
  weeklyPeriodFor,
} from "@pm-buddy/domain";
import {
  DEFAULT_PERIOD_SETTINGS,
  DEMO_TIMESHEET_RULE,
  KENYA_PUBLIC_HOLIDAYS,
  type AttendanceStatus,
} from "@pm-buddy/types";
import type { Prisma } from "../generated/prisma/client.js";
import { AdjustmentsService } from "../modules/attendance/adjustments.service.js";
import { AnomalyEvaluator, PeriodStore } from "../modules/attendance/period-store.js";
import { PeriodsService } from "../modules/attendance/periods.service.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { fromCalendarDate, toCalendarDate } from "../modules/projects/project-mappers.js";

/**
 * Attendance part of the development seed (D3.3 web slice, brief §11): the Kenyan holiday calendar,
 * the Q-C3 demonstration timesheet rule (unverified, COMPLIANCE-REVIEW CR-PAY-08), and nine weeks
 * of synthetic muster rolls for the 40 seeded labourers on their gangs' sites, ending today. Past
 * weekly periods are recorded by the site agent (Ruiru) or the owner (Kitengela), confirmed by the
 * project manager, submitted and approved by different people; the last complete period waits for
 * approval and the current period is open. A two-site day and an excessive-hours day are left open
 * for review, an older one is dismissed, and one approved adjustment lands in the current period.
 * Every value is synthetic and deterministic. Idempotent: if the company already has a timesheet
 * period nothing is added.
 */

type Tx = Prisma.TransactionClient;
type Audit = (
  tx: Tx,
  action: string,
  resourceId: string,
  metadata?: Prisma.InputJsonValue,
) => Promise<unknown>;
const SOURCE = { source: "seed" } as const;
const WEEKS = 9;

export type AttendanceSeedSummary = {
  created: boolean;
  periods: number;
  approvedPeriods: number;
  records: number;
  openAnomalies: number;
  adjustments: number;
  holidays: number;
};

type Accounts = { ownerId: string; pmId: string; agentId: string };

/** A deterministic number 0–99 for a labourer, date and purpose (no randomness in the seed). */
function roll(...parts: string[]): number {
  return createHash("sha256").update(parts.join("|")).digest().readUInt16BE(0) % 100;
}

const clock = (hours: number, minutes = 0) => hours * 60 + minutes;

type Entry = {
  status: AttendanceStatus;
  checkInMinutes: number | null;
  checkOutMinutes: number | null;
  overnight: boolean;
  notes: string | null;
};

/** The synthetic status and times of a labourer on a date. */
function entryFor(workerNo: string, date: string, trade: string): Entry {
  const none = { checkInMinutes: null, checkOutMinutes: null, overnight: false, notes: null };
  if (trade === "watchman") {
    // Watchmen guard the yard at night: 18:00 to 06:00 the next morning.
    const value = roll(workerNo, date, "status");
    if (value >= 95) return { status: "absent", ...none };
    return {
      status: "present",
      checkInMinutes: clock(18),
      checkOutMinutes: clock(6),
      overnight: true,
      notes: null,
    };
  }
  const value = roll(workerNo, date, "status");
  if (value >= 99) return { status: "sick", ...none };
  if (value >= 97) return { status: "leave", ...none };
  if (value >= 92) return { status: "absent", ...none };
  if (value >= 88)
    return {
      status: "half_day",
      checkInMinutes: clock(7),
      checkOutMinutes: clock(11, 30),
      overnight: false,
      notes: null,
    };
  return {
    status: "present",
    checkInMinutes: clock(6, 50) + (roll(workerNo, date, "in") % 31),
    checkOutMinutes: clock(16, 30) + (roll(workerNo, date, "out") % 61),
    overnight: false,
    notes: null,
  };
}

export async function seedAttendance(
  app: INestApplicationContext,
  tenantId: string,
  accounts: Accounts,
  audit: Audit,
): Promise<AttendanceSeedSummary> {
  const db = app.get(TenantDatabase);
  const periodsService = app.get(PeriodsService);
  const periodStore = app.get(PeriodStore);
  const evaluator = app.get(AnomalyEvaluator);
  const adjustments = app.get(AdjustmentsService);
  const as = (userId: string) => ({ userId, tenantId, requestId: "seed" });
  // One transaction for the whole attendance seed (all or nothing, so a rerun after a failure
  // starts clean). Steps taken by another person switch the acting user for row-level security,
  // which checks requesters, deciders and audit actors against the current user.
  const actAs = (tx: Tx, userId: string) =>
    tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
  const auditBy = (
    tx: Tx,
    actorId: string,
    action: string,
    resourceId: string,
    metadata: Prisma.InputJsonValue,
  ) =>
    tx.auditEvent.create({
      data: { tenantId, actorId, requestId: "seed", action, resourceId, metadata },
    });
  const today = nairobiDate();
  const end = today;
  const start = addCalendarDays(end, -(WEEKS * 7 - 1));

  const created = await db.run(
    as(accounts.ownerId),
    async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      if (await tx.timesheetPeriod.count({ where: { tenantId } })) return false;

      // Holiday calendar (Public Holidays Act Cap. 110 and the 2026 Gazette notices).
      const existing = await tx.publicHoliday.findMany({
        where: { tenantId },
        select: { holidayDate: true },
      });
      const taken = new Set(existing.map((row) => toCalendarDate(row.holidayDate)));
      let added = 0;
      for (const holiday of KENYA_PUBLIC_HOLIDAYS) {
        if (taken.has(holiday.date)) continue;
        await tx.publicHoliday.create({
          data: {
            tenantId,
            holidayDate: fromCalendarDate(holiday.date),
            nameEn: holiday.nameEn,
            nameSw: holiday.nameSw,
            kind: holiday.kind,
            source: holiday.source,
            createdBy: accounts.ownerId,
          },
        });
        added += 1;
      }
      await audit(tx, "attendance.holidays_installed", tenantId, { ...SOURCE, added });

      // The demonstration rule, unverified, in force from the first seeded day.
      if (!(await tx.timesheetRuleVersion.findFirst({ where: { tenantId, projectId: null } }))) {
        const { sourceReference, ...values } = DEMO_TIMESHEET_RULE;
        const rule = await tx.timesheetRuleVersion.create({
          data: {
            tenantId,
            projectId: null,
            effectiveFrom: fromCalendarDate(start),
            ...values,
            restDays: [...values.restDays],
            complianceStatus: "unverified",
            sourceReference,
            createdBy: accounts.ownerId,
          },
        });
        await audit(tx, "timesheet.rule_created", rule.id, { ...SOURCE, effectiveFrom: start });
      }
      const holidays = new Set(
        (
          await tx.publicHoliday.findMany({ where: { tenantId }, select: { holidayDate: true } })
        ).map((row) => toCalendarDate(row.holidayDate)),
      );

      const projects = await tx.project.findMany({
        where: { tenantId, code: { in: ["RUI-HTS", "KIT-BNG"] } },
        select: { id: true, code: true },
      });
      const gangs = await tx.gang.findMany({
        where: { tenantId, projectId: { in: projects.map((project) => project.id) } },
        select: { id: true, name: true, siteId: true, projectId: true },
      });
      const memberships = await tx.gangMembership.findMany({
        where: { tenantId, gangId: { in: gangs.map((gang) => gang.id) } },
        select: { gangId: true, labourerId: true, joinedOn: true, leftOn: true },
      });
      const labourers = await tx.labourer.findMany({
        where: { tenantId },
        select: { id: true, workerNo: true, tradeId: true },
      });
      const trades = await tx.trade.findMany({
        where: { tenantId },
        select: { id: true, key: true },
      });
      const engagements = await tx.labourEngagement.findMany({
        where: { tenantId },
        select: { labourerId: true, projectId: true, startDate: true, endDate: true },
      });
      const tradeOf = new Map(
        labourers.map((row) => [
          row.id,
          trades.find((trade) => trade.id === row.tradeId)?.key ?? "",
        ]),
      );
      const workerNo = new Map(labourers.map((row) => [row.id, row.workerNo]));
      const engaged = (labourerId: string, projectId: string, date: string) =>
        engagements.some(
          (row) =>
            row.labourerId === labourerId &&
            row.projectId === projectId &&
            toCalendarDate(row.startDate) <= date &&
            (row.endDate === null || toCalendarDate(row.endDate) >= date),
        );
      const gangLetter = (name: string) => /^Gang ([A-Z]):/.exec(name)?.[1] ?? "";
      const pourMason = memberships.find(
        (row) =>
          gangLetter(gangs.find((gang) => gang.id === row.gangId)?.name ?? "") === "B" &&
          tradeOf.get(row.labourerId) === "mason",
      )?.labourerId;
      const siteOfGang = (letter: string) =>
        gangs.find((gang) => gangLetter(gang.name) === letter)?.siteId ?? null;
      const mainPlot = siteOfGang("A");
      const yardHelper = memberships.find(
        (row) =>
          gangLetter(gangs.find((gang) => gang.id === row.gangId)?.name ?? "") === "E" &&
          tradeOf.get(row.labourerId) !== "watchman",
      )?.labourerId;
      const sundayPour = Array.from({ length: 7 }, (_, index) =>
        addCalendarDays(start, 21 + index),
      ).find((date) => isoWeekday(date) === 7);
      const recentWeekday = [1, 2, 3, 4, 5, 6]
        .map((back) => addCalendarDays(end, -back))
        .find((date) => isoWeekday(date) !== 7 && !holidays.has(date))!;
      const olderWeekday = [15, 16, 17, 18, 19, 20]
        .map((back) => addCalendarDays(end, -back))
        .find((date) => isoWeekday(date) !== 7 && !holidays.has(date))!;

      let records = 0;
      for (let date = start; date <= end; date = addCalendarDays(date, 1)) {
        const sunday = isoWeekday(date) === 7;
        const holiday = holidays.has(date);
        for (const project of projects) {
          const recorder = project.code === "RUI-HTS" ? accounts.agentId : accounts.ownerId;
          const projectGangs = gangs.filter((gang) => gang.projectId === project.id);
          const sites = [
            ...new Set(projectGangs.flatMap((gang) => (gang.siteId ? [gang.siteId] : []))),
          ];
          for (const siteId of sites) {
            const crew = memberships
              .filter((row) => {
                const gang = projectGangs.find((entry) => entry.id === row.gangId);
                return (
                  gang?.siteId === siteId &&
                  toCalendarDate(row.joinedOn) <= date &&
                  (row.leftOn === null || toCalendarDate(row.leftOn) >= date) &&
                  engaged(row.labourerId, project.id, date)
                );
              })
              .map((row) => ({
                labourerId: row.labourerId,
                letter: gangLetter(projectGangs.find((gang) => gang.id === row.gangId)!.name),
              }));
            const entries: (Entry & { labourerId: string })[] = [];
            for (const member of crew) {
              const trade = tradeOf.get(member.labourerId) ?? "";
              const number = workerNo.get(member.labourerId) ?? "";
              if (trade === "watchman") {
                entries.push({ labourerId: member.labourerId, ...entryFor(number, date, trade) });
                continue;
              }
              // Sundays and public holidays are rest days, except a Sunday concrete pour by gang A
              // and a services crew (gang D) on public holidays that fall on a weekday.
              if (sunday && !(date === sundayPour && member.letter === "A")) continue;
              if (holiday && !(member.letter === "D" && !sunday && isoWeekday(date) !== 6))
                continue;
              const base = entryFor(number, date, trade);
              const special =
                (date === recentWeekday || date === olderWeekday) && member.labourerId === pourMason
                  ? {
                      status: "present" as const,
                      checkInMinutes: clock(5, 30),
                      checkOutMinutes: clock(20, 30),
                      overnight: false,
                      notes: "Slab pour ran late (synthetic)",
                    }
                  : null;
              const sundayShift =
                sunday || holiday
                  ? {
                      status: "present" as const,
                      checkInMinutes: clock(7),
                      checkOutMinutes: clock(12, 30),
                      overnight: false,
                      notes: sunday ? "Sunday concrete pour" : "Holiday services crew",
                    }
                  : null;
              entries.push({ labourerId: member.labourerId, ...(special ?? sundayShift ?? base) });
            }
            // The yard helper is also recorded on the main plot the same recent day (two sites).
            if (
              date === recentWeekday &&
              project.code === "RUI-HTS" &&
              yardHelper &&
              !crew.some((member) => member.labourerId === yardHelper) &&
              engaged(yardHelper, project.id, date) &&
              siteId === mainPlot
            )
              entries.push({
                labourerId: yardHelper,
                status: "present",
                checkInMinutes: clock(14),
                checkOutMinutes: clock(18),
                overnight: false,
                notes: "Helped offload blocks on the main plot (synthetic)",
              });
            if (!entries.length) continue;
            const { period } = await periodStore.ensure(tx, tenantId, project.id, date, recorder);
            const day = await tx.attendanceDay.create({
              data: {
                tenantId,
                projectId: project.id,
                siteId,
                workDate: fromCalendarDate(date),
                periodId: period.id,
                createdBy: recorder,
              },
            });
            await tx.attendanceRecord.createMany({
              data: entries.map((entry) => ({
                tenantId,
                dayId: day.id,
                projectId: project.id,
                siteId,
                workDate: fromCalendarDate(date),
                labourerId: entry.labourerId,
                status: entry.status,
                checkInMinutes: entry.checkInMinutes,
                checkOutMinutes: entry.checkOutMinutes,
                overnight: entry.overnight,
                notes: entry.notes,
                captureMethod: "web_manual",
                createdBy: recorder,
                updatedBy: recorder,
              })),
            });
            records += entries.length;
          }
        }
      }

      // The muster workflow: submitted by the recorder and confirmed by the project manager,
      // except, while the current period is open, today's sheets (still drafts) and yesterday's
      // when it is in the current period (waiting for confirmation).
      const now = new Date();
      const current = weeklyPeriodFor(today, DEFAULT_PERIOD_SETTINGS);
      const currentOpen = !isPeriodDue(current.cutoffAt, now);
      const yesterday = addCalendarDays(today, -1);
      const days = await tx.attendanceDay.findMany({ where: { tenantId } });
      for (const day of days) {
        const date = toCalendarDate(day.workDate);
        if (currentOpen && date === today) continue;
        await tx.attendanceDay.update({
          where: { id: day.id },
          data: { status: "submitted", submittedBy: day.createdBy, version: { increment: 1 } },
        });
        if (currentOpen && date === yesterday && yesterday >= current.startDate) continue;
        await tx.attendanceDay.update({
          where: { id: day.id },
          data: { status: "confirmed", confirmedBy: accounts.pmId, version: { increment: 1 } },
        });
      }

      // Anomaly rules over every seeded labourer-day.
      const all = await tx.attendanceRecord.findMany({
        where: { tenantId },
        select: { labourerId: true, workDate: true },
      });
      await evaluator.refresh(
        tx,
        tenantId,
        all.map((record) => ({
          labourerId: record.labourerId,
          date: toCalendarDate(record.workDate),
        })),
      );
      await audit(tx, "attendance.muster_seeded", tenantId, {
        ...SOURCE,
        from: start,
        to: end,
        records,
      });

      // Periods: every complete period is approved after its anomalies are reviewed, except the
      // last one, which waits for approval. Ruiru: site agent submits, project manager approves;
      // Kitengela: project manager submits, owner approves.
      const periods = await tx.timesheetPeriod.findMany({
        where: { tenantId },
        orderBy: { startDate: "asc" },
      });
      const due = periods.filter((period) => isPeriodDue(period.cutoffAt, now));
      const lastStart = due
        .map((period) => toCalendarDate(period.startDate))
        .sort()
        .at(-1);
      for (const period of due) {
        const isRuiru =
          projects.find((project) => project.id === period.projectId)?.code === "RUI-HTS";
        const submitter = isRuiru ? accounts.agentId : accounts.pmId;
        const approver = isRuiru ? accounts.pmId : accounts.ownerId;
        const awaiting = toCalendarDate(period.startDate) === lastStart;
        if (!awaiting) {
          // Reviewed before approval: findings are dismissed with a note by the project manager.
          await tx.attendanceAnomaly.updateMany({
            where: {
              tenantId,
              status: "open",
              record: { day: { periodId: period.id } },
            },
            data: {
              status: "dismissed",
              openMarker: null,
              reviewedBy: accounts.pmId,
              reviewNote: "Reviewed during the weekly check (synthetic)",
              version: { increment: 1 },
            },
          });
        }
        const fresh = await tx.timesheetPeriod.findUniqueOrThrow({ where: { id: period.id } });
        await actAs(tx, submitter);
        const computed = await periodsService.submitCore(tx, tenantId, submitter, fresh);
        await auditBy(tx, submitter, "timesheet.period_submitted", period.id, {
          ...SOURCE,
          projectId: period.projectId,
        });
        if (awaiting) continue;
        // Submission re-evaluates anomalies; anything new is reviewed the same way.
        await tx.attendanceAnomaly.updateMany({
          where: { tenantId, status: "open", record: { day: { periodId: period.id } } },
          data: {
            status: "dismissed",
            openMarker: null,
            reviewedBy: accounts.pmId,
            reviewNote: "Reviewed during the weekly check (synthetic)",
            version: { increment: 1 },
          },
        });
        const submitted = await tx.timesheetPeriod.findUniqueOrThrow({ where: { id: period.id } });
        await actAs(tx, approver);
        await periodsService.approveCore(tx, tenantId, approver, submitted);
        await auditBy(tx, approver, "timesheet.period_approved", period.id, {
          ...SOURCE,
          projectId: period.projectId,
          lines: computed.lines.length,
        });
      }

      // One adjustment: a worker marked absent in an approved Ruiru period had signed the paper
      // roll. Requested by the owner, approved by the project manager.
      await actAs(tx, accounts.ownerId);
      const ruiru = await tx.project.findFirstOrThrow({
        where: { tenantId, code: "RUI-HTS" },
        select: { id: true },
      });
      const approved = await tx.timesheetPeriod.findFirst({
        where: { tenantId, projectId: ruiru.id, status: "approved" },
        orderBy: { startDate: "desc" },
      });
      if (!approved) return { records, added };
      const absent = await tx.attendanceRecord.findFirst({
        where: {
          tenantId,
          projectId: ruiru.id,
          status: "absent",
          workDate: { gte: approved.startDate, lte: approved.endDate },
        },
        orderBy: [{ workDate: "asc" }, { id: "asc" }],
      });
      if (!absent) return { records, added };
      const adjustment = await tx.timesheetAdjustment.create({
        data: {
          tenantId,
          projectId: ruiru.id,
          originalPeriodId: approved.id,
          labourerId: absent.labourerId,
          siteId: absent.siteId,
          workDate: absent.workDate,
          recordId: absent.id,
          proposed: {
            status: "present",
            checkIn: "07:00",
            checkOut: "16:30",
            overnight: false,
            breakMinutes: null,
            notes: "Signed the paper roll (synthetic)",
          },
          previous: {
            status: "absent",
            checkIn: null,
            checkOut: null,
            overnight: false,
            breakMinutes: null,
            notes: absent.notes,
          },
          reason: "Signed the paper roll at the gate; missed in the web entry (synthetic)",
          requestedBy: accounts.ownerId,
        },
      });
      await audit(tx, "timesheet.adjustment_requested", adjustment.id, {
        ...SOURCE,
        periodId: approved.id,
      });
      await actAs(tx, accounts.pmId);
      const target = await adjustments.approveCore(
        tx,
        tenantId,
        accounts.pmId,
        adjustment,
        "Checked the gate book",
      );
      await auditBy(tx, accounts.pmId, "timesheet.adjustment_approved", adjustment.id, {
        ...SOURCE,
        targetPeriodId: target.id,
      });
      await actAs(tx, accounts.ownerId);
      return { records, added };
    },
    600_000,
  );
  return summary(db, as(accounts.ownerId), tenantId, created !== false);
}

async function summary(
  db: TenantDatabase,
  context: { userId: string; tenantId: string; requestId: string },
  tenantId: string,
  created: boolean,
): Promise<AttendanceSeedSummary> {
  return db.run(context, async (tx) => ({
    created,
    periods: await tx.timesheetPeriod.count({ where: { tenantId } }),
    approvedPeriods: await tx.timesheetPeriod.count({ where: { tenantId, status: "approved" } }),
    records: await tx.attendanceRecord.count({ where: { tenantId } }),
    openAnomalies: await tx.attendanceAnomaly.count({ where: { tenantId, status: "open" } }),
    adjustments: await tx.timesheetAdjustment.count({ where: { tenantId } }),
    holidays: await tx.publicHoliday.count({ where: { tenantId } }),
  }));
}
