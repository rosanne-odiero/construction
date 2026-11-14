import {
  datesBetween,
  halfDaysAsDays,
  minutesAsHours,
  musterCell,
  musterTotals,
  type MusterCell,
} from "@pm-buddy/domain";
import {
  EMPLOYEE_STATUTORY,
  type AttendanceStatus,
  type EmployeeStatutory,
  type PayrollBatchStatus,
} from "@pm-buddy/types";
import type { ReportCell } from "@pm-buddy/validation";
import {
  bounded,
  column,
  fill,
  fromDay,
  money,
  sum,
  tooLarge,
  type BuildContext,
  type BuildResult,
} from "../report-model.js";

/** At most this many attendance records feed one muster roll (one site, at most 31 days). */
const MUSTER_RECORD_CAP = 100_000;

/**
 * Muster roll (D-124): labourers × days at one site from records on CONFIRMED days only (draft and
 * submitted days are left out and counted in a note), the day's status code, days present (half
 * days count a half), absences and the hours recorded; a totals row counts who was present each
 * day. Same permission as the muster screen: attendance.view on the project.
 */
export async function musterRoll(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.muster;
  const period = ctx.params.period!;
  const siteId = ctx.params.siteId!;
  const dates = datesBetween(period.from, period.to);
  const days = await tx.attendanceDay.findMany({
    where: {
      tenantId: access.tenantId,
      projectId: ctx.params.projectId!,
      siteId,
      workDate: { gte: fromDay(period.from), lte: fromDay(period.to) },
    },
    select: { id: true, status: true },
  });
  const confirmed = days.filter((day) => day.status === "confirmed").map((day) => day.id);
  const records = confirmed.length
    ? await tx.attendanceRecord.findMany({
        where: { tenantId: access.tenantId, siteId, dayId: { in: confirmed } },
        select: {
          labourerId: true,
          workDate: true,
          status: true,
          checkInMinutes: true,
          checkOutMinutes: true,
          overnight: true,
          breakMinutes: true,
        },
        take: MUSTER_RECORD_CAP + 1,
      })
    : [];
  if (records.length > MUSTER_RECORD_CAP) throw tooLarge(ctx.maxRows);
  const cells = new Map<string, Map<string, MusterCell>>();
  for (const record of records) {
    const byDate = cells.get(record.labourerId) ?? new Map<string, MusterCell>();
    byDate.set(
      record.workDate.toISOString().slice(0, 10),
      musterCell({ ...record, status: record.status as AttendanceStatus }),
    );
    cells.set(record.labourerId, byDate);
  }
  const labourers = bounded(
    await tx.labourer.findMany({
      where: { tenantId: access.tenantId, id: { in: [...cells.keys()] } },
      select: {
        id: true,
        workerNo: true,
        fullName: true,
        trade: { select: { nameEn: true, nameSw: true } },
      },
      orderBy: { workerNo: "asc" },
    }),
    ctx.maxRows,
  );
  const code = (cell: MusterCell | undefined) => (cell ? t.codes[cell.status] : null);
  let missingTimes = 0;
  const rows: ReportCell[][] = labourers.map((labourer) => {
    const byDate = cells.get(labourer.id)!;
    const totals = musterTotals(dates.map((date) => byDate.get(date) ?? null));
    missingTimes += totals.missingTimes;
    return [
      labourer.workerNo,
      labourer.fullName,
      ctx.locale === "sw" ? labourer.trade.nameSw : labourer.trade.nameEn,
      ...dates.map((date) => code(byDate.get(date))),
      halfDaysAsDays(totals.presentHalfDays),
      String(totals.absent),
      String(totals.leave),
      String(totals.sick),
      minutesAsHours(totals.minutes),
    ];
  });
  const everyone = labourers.map((labourer) => cells.get(labourer.id)!);
  const daily = dates.map((date) =>
    halfDaysAsDays(
      everyone.reduce((total, byDate) => total + (byDate.get(date)?.halfDays ?? 0), 0),
    ),
  );
  const all = musterTotals(everyone.flatMap((byDate) => [...byDate.values()]));
  const notes = [
    t.legend,
    fill(t.confirmedDays, { confirmed: confirmed.length, days: dates.length }),
  ];
  if (missingTimes) notes.push(fill(t.missingTimes, { count: missingTimes }));
  notes.push(t.hoursNote);
  return {
    sections: [
      {
        key: "muster",
        title: t.section,
        columns: [
          column("workerNo", t.workerNo, "text"),
          column("name", t.name, "text"),
          column("trade", t.trade, "text"),
          ...dates.map((date) =>
            column(`d-${date}`, `${date.slice(8, 10)}/${date.slice(5, 7)}`, "text"),
          ),
          column("days", t.days, "quantity"),
          column("absent", t.absent, "quantity"),
          column("leave", t.leave, "quantity"),
          column("sick", t.sick, "quantity"),
          column("hours", t.hours, "quantity"),
        ],
        rows,
        totals: rows.length
          ? [
              t.presentRow,
              null,
              null,
              ...daily,
              halfDaysAsDays(all.presentHalfDays),
              String(all.absent),
              String(all.leave),
              String(all.sick),
              minutesAsHours(all.minutes),
            ]
          : null,
        notes,
      },
    ],
    notes: [],
  };
}

/**
 * Payroll register (one batch): per worker gross, the employee statutory deductions withheld,
 * advance recoveries, other deductions and net pay, then the statutory totals (employee withheld,
 * not withheld, employer cost). Same permission as the batch screen: payroll.view or
 * payroll.prepare on the project. Labelled with the batch status: main has no approved or paid
 * payroll yet.
 */
export async function payrollRegister(ctx: BuildContext): Promise<BuildResult> {
  const { tx, access } = ctx.scope;
  const t = ctx.t.payroll;
  const batch = await tx.payrollBatch.findFirstOrThrow({
    where: { tenantId: access.tenantId, projectId: ctx.params.projectId!, id: ctx.params.batchId! },
    select: { id: true, status: true, unverifiedRules: true },
  });
  const lines = bounded(
    await tx.payrollLine.findMany({
      where: { tenantId: access.tenantId, batchId: batch.id },
      select: {
        workerNo: true,
        fullName: true,
        tradeNameEn: true,
        tradeNameSw: true,
        daysWorked: true,
        grossMinor: true,
        advanceRecoveryMinor: true,
        otherDeductionsMinor: true,
        netMinor: true,
        deductions: {
          select: { party: true, kind: true, withheldMinor: true, shortfallMinor: true },
        },
      },
      orderBy: { workerNo: "asc" },
      take: ctx.maxRows + 1,
    }),
    ctx.maxRows,
  );
  const withheld = (line: (typeof lines)[number], kind: EmployeeStatutory) =>
    money(
      line.deductions.find((row) => row.party === "employee" && row.kind === kind)?.withheldMinor ??
        0n,
    );
  const rows: ReportCell[][] = lines.map((line) => [
    line.workerNo,
    line.fullName,
    (ctx.locale === "sw" ? line.tradeNameSw : line.tradeNameEn) ?? null,
    String(line.daysWorked),
    money(line.grossMinor),
    withheld(line, "paye"),
    withheld(line, "nssf"),
    withheld(line, "shif"),
    withheld(line, "ahl"),
    money(line.advanceRecoveryMinor),
    money(line.otherDeductionsMinor),
    money(line.netMinor),
  ]);
  const totals: ReportCell[] | null = rows.length
    ? [
        ctx.t.total,
        null,
        null,
        String(lines.reduce((total, line) => total + line.daysWorked, 0)),
        ...[4, 5, 6, 7, 8, 9, 10, 11].map((index) => sum(rows, index)),
      ]
    : null;

  const deductions = lines.flatMap((line) => line.deductions);
  const total = (party: string, kind: string, field: "withheldMinor" | "shortfallMinor") =>
    deductions
      .filter((row) => row.party === party && row.kind === kind)
      .reduce((sumOf, row) => sumOf + Number(row[field]), 0);
  const employerOf: Partial<Record<EmployeeStatutory, string>> = {
    nssf: "nssf_employer",
    ahl: "ahl_employer",
  };
  const statutory: ReportCell[][] = [
    ...EMPLOYEE_STATUTORY.map((kind): ReportCell[] => [
      t.kinds[kind],
      total("employee", kind, "withheldMinor"),
      total("employee", kind, "shortfallMinor"),
      employerOf[kind] ? total("employer", employerOf[kind], "withheldMinor") : null,
    ]),
    [t.kinds.nita, null, null, total("employer", "nita", "withheldMinor")],
  ];
  return {
    sections: [
      {
        key: "lines",
        title: t.lines,
        columns: [
          column("workerNo", t.workerNo, "text"),
          column("name", t.name, "text"),
          column("trade", t.trade, "text"),
          column("days", t.days, "quantity"),
          column("gross", t.gross, "money"),
          column("paye", t.paye, "money"),
          column("nssf", t.nssf, "money"),
          column("shif", t.shif, "money"),
          column("ahl", t.ahl, "money"),
          column("advances", t.advances, "money"),
          column("other", t.other, "money"),
          column("net", t.net, "money"),
        ],
        rows,
        totals,
        notes: [],
      },
      {
        key: "statutory",
        title: t.statutory,
        columns: [
          column("item", t.item, "text"),
          column("employee", t.employee, "money"),
          column("shortfall", t.shortfall, "money"),
          column("employer", t.employer, "money"),
        ],
        rows: statutory,
        totals: [ctx.t.total, sum(statutory, 1), sum(statutory, 2), sum(statutory, 3)],
        notes: [t.statutoryNote],
      },
    ],
    notes: [
      fill(t.statusNote, { status: t.statuses[batch.status as PayrollBatchStatus] }),
      ...(batch.unverifiedRules ? [t.unverified] : []),
    ],
  };
}
