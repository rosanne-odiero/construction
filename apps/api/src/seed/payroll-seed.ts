import type { INestApplicationContext } from "@nestjs/common";
import {
  addCalendarDays,
  isoWeekday,
  nairobiDate,
  outputAmountMinor,
  payPeriodFor,
  splitEqually,
} from "@pm-buddy/domain";
import type { Prisma } from "../generated/prisma/client.js";
import { TenantDatabase } from "../modules/identity/tenant-database.service.js";
import { BatchBuilder, loadCalendar, type BatchTarget } from "../modules/payroll/batch-builder.js";
import {
  installMinimumWageDefaults,
  installStatutoryDefaults,
} from "../modules/payroll/rules.service.js";
import { fromCalendarDate, toCalendarDate } from "../modules/projects/project-mappers.js";
import { uuidv7 } from "../common/uuid.js";
import { RATES_FROM_DAYS_AGO } from "./labour-seed.js";

/**
 * Payroll part of the development seed (D4.1, brief §11). Everything is synthetic and every
 * statutory value is installed `unverified` (COMPLIANCE-REVIEW): the researched Kenyan rule
 * versions (PAYE, NSSF Year 3 and Year 4, SHIF, AHL, NITA, the cumulative month-to-date method and
 * applicability), the 2026 General Order minimum wages, pay calendars (Ruiru Heights weekly from
 * its third-latest approved timesheet week, area "municipalities"; Kitengela weekly from its
 * latest approved week, area "other"), allowances, piece-rate output for Ruiru's masonry gang
 * (one approved, one pending), two advances (one paid outside PM-Buddy and recovering, one
 * waiting for approval), and batches: Ruiru's oldest week submitted by the project manager, its
 * next two weeks and Kitengela's latest week as drafts. Idempotent: skipped when the company has a
 * payroll batch.
 */

type Tx = Prisma.TransactionClient;
type Accounts = { ownerId: string; pmId: string; agentId: string };
const SOURCE = { source: "seed" } as const;

export type PayrollSeedSummary = {
  created: boolean;
  ruleVersions: number;
  minimumWages: number;
  allowances: number;
  outputs: number;
  advances: number;
  draftBatches: number;
  submittedBatches: number;
  lines: number;
};

export async function seedPayroll(
  app: INestApplicationContext,
  tenantId: string,
  accounts: Accounts,
): Promise<PayrollSeedSummary> {
  const db = app.get(TenantDatabase);
  const builder = app.get(BatchBuilder);
  const actAs = (tx: Tx, userId: string) =>
    tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
  const auditBy = async (
    tx: Tx,
    actorId: string,
    action: string,
    resourceId: string,
    metadata: Prisma.InputJsonValue,
  ) => {
    await actAs(tx, actorId);
    await tx.auditEvent.create({
      data: { tenantId, actorId, requestId: "seed", action, resourceId, metadata },
    });
  };
  const counts = async (tx: Tx, created: boolean): Promise<PayrollSeedSummary> => ({
    created,
    ruleVersions: await tx.statutoryRuleVersion.count({ where: { tenantId } }),
    minimumWages: await tx.minimumWageRate.count({ where: { tenantId } }),
    allowances: await tx.payrollAllowance.count({ where: { tenantId } }),
    outputs: await tx.pieceRateOutput.count({ where: { tenantId } }),
    advances: await tx.salaryAdvance.count({ where: { tenantId } }),
    draftBatches: await tx.payrollBatch.count({ where: { tenantId, status: "draft" } }),
    submittedBatches: await tx.payrollBatch.count({ where: { tenantId, status: "submitted" } }),
    lines: await tx.payrollLine.count({ where: { tenantId } }),
  });

  return db.run(
    { userId: accounts.ownerId, tenantId, requestId: "seed" },
    async (tx) => {
      await tx.$queryRaw`SELECT tenant_id FROM tenants WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      if (await tx.payrollBatch.count({ where: { tenantId } })) return counts(tx, false);

      await actAs(tx, accounts.ownerId);
      const ruleVersions = await installStatutoryDefaults(tx, tenantId, accounts.ownerId);
      const wages = await installMinimumWageDefaults(tx, tenantId, accounts.ownerId);
      await auditBy(tx, accounts.ownerId, "payroll.rules_installed", tenantId, {
        ...SOURCE,
        ruleVersions,
        minimumWages: wages,
      });

      const projects = await tx.project.findMany({
        where: { tenantId, code: { in: ["RUI-HTS", "KIT-BNG"] } },
        select: { id: true, code: true },
      });
      const ruiru = projects.find((project) => project.code === "RUI-HTS");
      const kitengela = projects.find((project) => project.code === "KIT-BNG");
      if (!ruiru || !kitengela) return counts(tx, true);
      const approved = async (projectId: string) =>
        (
          await tx.timesheetPeriod.findMany({
            where: { tenantId, projectId, status: "approved" },
            orderBy: { startDate: "desc" },
            take: 3,
          })
        ).map((row) => ({
          id: row.id,
          start: toCalendarDate(row.startDate),
          end: toCalendarDate(row.endDate),
        }));
      const ruiruWeeks = await approved(ruiru.id);
      const kitengelaWeeks = await approved(kitengela.id);
      if (ruiruWeeks.length < 3 || !kitengelaWeeks.length) return counts(tx, true);
      const [r1, r2, r3] = ruiruWeeks as [
        (typeof ruiruWeeks)[number],
        (typeof ruiruWeeks)[number],
        (typeof ruiruWeeks)[number],
      ];
      const k1 = kitengelaWeeks[0]!;

      // Pay calendars: weekly like the timesheets, paid on Friday (QUESTIONS Q-C4).
      await actAs(tx, accounts.pmId);
      for (const [projectId, anchor, area] of [
        [ruiru.id, r3.start, "municipalities"],
        [kitengela.id, k1.start, "other"],
      ] as const) {
        await tx.payCalendar.create({
          data: {
            tenantId,
            projectId,
            frequency: "weekly",
            anchorDate: fromCalendarDate(anchor),
            paydayOffsetDays: 1,
            minimumWageArea: area,
            updatedBy: accounts.pmId,
          },
        });
        await auditBy(tx, accounts.pmId, "payroll.calendar_updated", projectId, {
          ...SOURCE,
          frequency: "weekly",
          minimumWageAreaSet: true,
        });
      }

      // Allowances (synthetic amounts; taxable flag per allowance).
      const trades = await tx.trade.findMany({
        where: { tenantId },
        select: { id: true, key: true },
      });
      const mason = trades.find((trade) => trade.key === "mason")!.id;
      const allowancesFrom = fromCalendarDate(addCalendarDays(nairobiDate(), -RATES_FROM_DAYS_AGO));
      const allowances = [
        {
          projectId: ruiru.id,
          code: "transport",
          nameEn: "Transport",
          nameSw: "Usafiri",
          basis: "per_day_worked",
          amountMinor: 10_000n,
          taxable: true,
          tradeId: null,
        },
        {
          projectId: ruiru.id,
          code: "tools",
          nameEn: "Own tools",
          nameSw: "Vifaa binafsi",
          basis: "per_period",
          amountMinor: 25_000n,
          taxable: false,
          tradeId: mason,
        },
        {
          projectId: kitengela.id,
          code: "transport",
          nameEn: "Transport",
          nameSw: "Usafiri",
          basis: "per_day_worked",
          amountMinor: 8_000n,
          taxable: true,
          tradeId: null,
        },
      ];
      await actAs(tx, accounts.pmId);
      for (const allowance of allowances) {
        const row = await tx.payrollAllowance.create({
          data: { tenantId, ...allowance, effectiveFrom: allowancesFrom, createdBy: accounts.pmId },
        });
        await auditBy(tx, accounts.pmId, "payroll.allowance_created", row.id, {
          ...SOURCE,
          projectId: allowance.projectId,
          code: allowance.code,
          basis: allowance.basis,
          scope: allowance.tradeId ? "trade" : "project",
          taxable: allowance.taxable,
        });
      }

      // Piece-rate output: Ruiru's masonry gang on an ordinary weekday of r2 (approved, so it
      // replaces those members' attendance that day) and one mason's output in r1 (pending).
      const gang = await tx.gang.findFirst({
        where: { tenantId, projectId: ruiru.id, name: { startsWith: "Gang B" } },
      });
      const holidays = new Set(
        (
          await tx.publicHoliday.findMany({ where: { tenantId }, select: { holidayDate: true } })
        ).map((row) => toCalendarDate(row.holidayDate)),
      );
      const weekday = (start: string, offset: number) =>
        Array.from({ length: 7 }, (_, index) => addCalendarDays(start, index)).filter(
          (date) => isoWeekday(date) !== 7 && !holidays.has(date),
        )[offset]!;
      if (gang) {
        const workDate = weekday(r2.start, 3);
        const members = await tx.gangMembership.findMany({
          where: {
            tenantId,
            gangId: gang.id,
            joinedOn: { lte: fromCalendarDate(workDate) },
            OR: [{ leftOn: null }, { leftOn: { gte: fromCalendarDate(workDate) } }],
          },
          include: { labourer: { select: { workerNo: true } } },
        });
        const engaged = await tx.labourEngagement.findMany({
          where: {
            tenantId,
            projectId: ruiru.id,
            labourerId: { in: members.map((row) => row.labourerId) },
            startDate: { lte: fromCalendarDate(workDate) },
            OR: [{ endDate: null }, { endDate: { gte: fromCalendarDate(workDate) } }],
          },
          select: { labourerId: true },
        });
        const crew = members
          .filter((row) => engaged.some((entry) => entry.labourerId === row.labourerId))
          .sort((a, b) => a.labourer.workerNo.localeCompare(b.labourer.workerNo));
        if (crew.length) {
          await actAs(tx, accounts.agentId);
          const quantity = "42.5";
          const rateMinor = 18_000;
          const output = await tx.pieceRateOutput.create({
            data: {
              tenantId,
              projectId: ruiru.id,
              workDate: fromCalendarDate(workDate),
              gangId: gang.id,
              description: "200 mm blockwork, ground floor walls (synthetic)",
              unit: "m²",
              quantity,
              rateMinor: BigInt(rateMinor),
              amountMinor: BigInt(outputAmountMinor(quantity, rateMinor)),
              recordedBy: accounts.agentId,
            },
          });
          await auditBy(tx, accounts.agentId, "payroll.output_recorded", output.id, {
            ...SOURCE,
            projectId: ruiru.id,
            workDate,
            gang: true,
          });
          await actAs(tx, accounts.pmId);
          await tx.pieceRateOutput.update({
            where: { tenantId_id: { tenantId, id: output.id } },
            data: { status: "approved", decidedBy: accounts.pmId, version: { increment: 1 } },
          });
          const amounts = splitEqually(outputAmountMinor(quantity, rateMinor), crew.length);
          await tx.pieceRateOutputShare.createMany({
            data: crew.map((member, index) => ({
              tenantId,
              projectId: ruiru.id,
              outputId: output.id,
              labourerId: member.labourerId,
              workDate: fromCalendarDate(workDate),
              amountMinor: BigInt(amounts[index]!),
            })),
          });
          await auditBy(tx, accounts.pmId, "payroll.output_approved", output.id, {
            ...SOURCE,
            projectId: ruiru.id,
            shares: crew.length,
          });
          const single = crew[0]!;
          await actAs(tx, accounts.agentId);
          const pending = await tx.pieceRateOutput.create({
            data: {
              tenantId,
              projectId: ruiru.id,
              workDate: fromCalendarDate(weekday(r1.start, 2)),
              labourerId: single.labourerId,
              description: "Plaster to staircase walls (synthetic)",
              unit: "m²",
              quantity: "11.25",
              rateMinor: 25_000n,
              amountMinor: BigInt(outputAmountMinor("11.25", 25_000)),
              recordedBy: accounts.agentId,
            },
          });
          await auditBy(tx, accounts.agentId, "payroll.output_recorded", pending.id, {
            ...SOURCE,
            projectId: ruiru.id,
            workDate: weekday(r1.start, 2),
            gang: false,
          });
        }
      }

      // Advances: one paid outside PM-Buddy at the start of r3 (recovered by the batches), one
      // waiting for approval. Requested by the site agent, approved by the project manager, the
      // payment recorded by the owner.
      const general = trades.find((trade) => trade.key === "general_labourer")!.id;
      const helpers = await tx.timesheetLine.findMany({
        where: { tenantId, periodId: r3.id, kind: "attendance", labourer: { tradeId: general } },
        include: { labourer: { select: { workerNo: true } } },
      });
      helpers.sort((a, b) => a.labourer.workerNo.localeCompare(b.labourer.workerNo));
      if (helpers.length >= 2) {
        await actAs(tx, accounts.agentId);
        const first = await tx.salaryAdvance.create({
          data: {
            tenantId,
            projectId: ruiru.id,
            labourerId: helpers[0]!.labourerId,
            amountMinor: 300_000n,
            reason: "School fees for the new term (synthetic)",
            instalmentMinor: 100_000n,
            requestedBy: accounts.agentId,
          },
        });
        await auditBy(tx, accounts.agentId, "advance.requested", first.id, {
          ...SOURCE,
          projectId: ruiru.id,
          instalmentSet: true,
        });
        await actAs(tx, accounts.pmId);
        await tx.salaryAdvance.update({
          where: { tenantId_id: { tenantId, id: first.id } },
          data: { status: "approved", decidedBy: accounts.pmId, version: { increment: 1 } },
        });
        await auditBy(tx, accounts.pmId, "advance.approved", first.id, {
          ...SOURCE,
          projectId: ruiru.id,
        });
        await actAs(tx, accounts.ownerId);
        await tx.salaryAdvance.update({
          where: { tenantId_id: { tenantId, id: first.id } },
          data: {
            status: "disbursed",
            disbursementMethod: "cash",
            disbursementReference: "PETTY-CASH-0042",
            paidOn: fromCalendarDate(r3.start),
            evidenceNote: "Signed petty cash voucher kept in the site file (synthetic)",
            disbursedBy: accounts.ownerId,
            version: { increment: 1 },
          },
        });
        await auditBy(tx, accounts.ownerId, "advance.disbursed", first.id, {
          ...SOURCE,
          projectId: ruiru.id,
          method: "cash",
          recordedOutsidePmBuddy: true,
        });
        await actAs(tx, accounts.agentId);
        const second = await tx.salaryAdvance.create({
          data: {
            tenantId,
            projectId: ruiru.id,
            labourerId: helpers[1]!.labourerId,
            amountMinor: 150_000n,
            reason: "Medical bill for a child (synthetic)",
            requestedBy: accounts.agentId,
          },
        });
        await auditBy(tx, accounts.agentId, "advance.requested", second.id, {
          ...SOURCE,
          projectId: ruiru.id,
          instalmentSet: false,
        });
      }

      // Batches: Ruiru r3 submitted, then r2, r1 and Kitengela k1 as drafts.
      const build = async (projectId: string, start: string) => {
        const calendar = await loadCalendar(tx, tenantId, projectId);
        const period = payPeriodFor(start, calendar);
        const target: BatchTarget = {
          id: uuidv7(),
          projectId,
          periodStart: period.startDate,
          periodEnd: period.endDate,
          payDate: period.payDate,
          frequency: calendar.frequency,
        };
        await actAs(tx, accounts.pmId);
        const built = await builder.compute(tx, tenantId, target, calendar, false);
        await builder.persist(tx, tenantId, accounts.pmId, built, null);
        await auditBy(tx, accounts.pmId, "payroll.batch_created", target.id, {
          ...SOURCE,
          projectId,
          periodStart: target.periodStart,
          periodEnd: target.periodEnd,
          lines: built.result.lines.length,
          exclusions: built.result.exclusions.length,
          unverifiedRules: built.result.unverified,
          digest: built.digest,
        });
        return { target, built };
      };
      const oldest = await build(ruiru.id, r3.start);
      await actAs(tx, accounts.pmId);
      await tx.payrollBatch.update({
        where: { tenantId_id: { tenantId, id: oldest.target.id } },
        data: { status: "submitted", submittedBy: accounts.pmId, version: { increment: 1 } },
      });
      await auditBy(tx, accounts.pmId, "payroll.batch_submitted", oldest.target.id, {
        ...SOURCE,
        projectId: ruiru.id,
        lines: oldest.built.result.lines.length,
        digest: oldest.built.digest,
        unverifiedRules: oldest.built.result.unverified,
      });
      await tx.outboxEvent.create({
        data: {
          tenantId,
          topic: "payroll.batch_submitted",
          aggregateId: oldest.target.id,
          payload: {
            projectId: ruiru.id,
            version: 2,
            digest: oldest.built.digest,
            lines: oldest.built.result.lines.length,
            payDate: oldest.target.payDate,
            statutoryMonth: oldest.built.statutoryMonth,
            unverifiedRules: oldest.built.result.unverified,
          },
        },
      });
      await build(ruiru.id, r2.start);
      await build(ruiru.id, r1.start);
      await build(kitengela.id, k1.start);
      await actAs(tx, accounts.ownerId);
      return counts(tx, true);
    },
    120_000,
  );
}
