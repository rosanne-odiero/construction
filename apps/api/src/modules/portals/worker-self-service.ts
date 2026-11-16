import { Injectable, UnauthorizedException } from "@nestjs/common";
import { nairobiDate } from "@pm-buddy/domain";
import type { WorkerPortalResponse } from "@pm-buddy/validation";
import type { Prisma } from "../../generated/prisma/client.js";
import { LabourCrypto } from "../labour/labour-support.js";

type Tx = Prisma.TransactionClient;
const date = (value: Date) => value.toISOString().slice(0, 10);

/** Only an unambiguous registry phone matching the verified account can unlock worker records. */
@Injectable()
export class WorkerSelfService {
  constructor(private readonly crypto: LabourCrypto) {}

  async read(
    tx: Tx,
    tenantId: string,
    identifier: string,
    projectIds: string[],
    idNumber?: string,
  ): Promise<Pick<WorkerPortalResponse, "attendance" | "pay">> {
    if (!/^254[17]\d{8}$/.test(identifier)) return { attendance: null, pay: null };
    const workers = await tx.labourer.findMany({
      where: {
        tenantId,
        phoneBidx: this.crypto.index(tenantId, "phone", identifier),
      },
      select: { id: true, idNumberBidx: true },
      take: 2,
    });
    const worker = workers.length === 1 ? workers[0] : undefined;
    if (!worker || (idNumber && worker.idNumberBidx !== this.crypto.idIndex(tenantId, idNumber))) {
      if (idNumber) throw new UnauthorizedException("Worker identity unavailable");
      return { attendance: null, pay: null };
    }
    const to = nairobiDate();
    const from = `${to.slice(0, 7)}-01`;
    const where = { tenantId, labourerId: worker.id, projectId: { in: projectIds } };
    const [records, lines, advances] = await Promise.all([
      tx.attendanceRecord.findMany({
        where: { ...where, workDate: { gte: new Date(from), lte: new Date(to) } },
        select: {
          id: true,
          workDate: true,
          status: true,
          day: { select: { status: true } },
          site: { select: { name: true, project: { select: { name: true } } } },
        },
        orderBy: [{ workDate: "desc" }, { id: "asc" }],
      }),
      tx.payrollLine.findMany({
        where: { ...where, batch: { status: "submitted" } },
        select: {
          id: true,
          grossMinor: true,
          netMinor: true,
          daysWorked: true,
          batch: {
            select: { periodStart: true, periodEnd: true, project: { select: { name: true } } },
          },
        },
        orderBy: [{ batch: { periodEnd: "desc" } }, { id: "desc" }],
        take: 12,
      }),
      tx.salaryAdvance.findMany({
        where: { ...where, status: "disbursed" },
        select: {
          amountMinor: true,
          recoveries: {
            where: { line: { batch: { status: "submitted" } } },
            select: { amountMinor: true },
          },
        },
      }),
    ]);
    // Multiple sites on one day must not turn a single day into two days worked.
    const worked = new Map<string, number>();
    for (const row of records) {
      if (row.day.status !== "confirmed") continue;
      const value = row.status === "present" ? 1 : row.status === "half_day" ? 0.5 : 0;
      worked.set(date(row.workDate), Math.min(1, (worked.get(date(row.workDate)) ?? 0) + value));
    }
    return {
      attendance: {
        from,
        to,
        daysWorked: [...worked.values()].reduce((sum, days) => sum + days, 0),
        records: records.map((row) => ({
          id: row.id,
          date: date(row.workDate),
          project: row.site.project.name,
          site: row.site.name,
          status: attendanceStatus(row.status),
          confirmed: row.day.status === "confirmed",
        })),
      },
      pay: {
        lines: lines.map((row) => ({
          id: row.id,
          project: row.batch.project.name,
          from: date(row.batch.periodStart),
          to: date(row.batch.periodEnd),
          grossMinor: String(row.grossMinor),
          deductionsMinor: String(row.grossMinor - row.netMinor),
          netMinor: String(row.netMinor),
          daysWorked: row.daysWorked,
        })),
        advancesOutstandingMinor: String(
          advances.reduce(
            (sum, advance) =>
              sum +
              advance.amountMinor -
              advance.recoveries.reduce((total, row) => total + row.amountMinor, 0n),
            0n,
          ),
        ),
        payments: null,
      },
    };
  }
}

function attendanceStatus(value: string) {
  switch (value) {
    case "present":
    case "half_day":
    case "absent":
    case "leave":
    case "sick":
      return value;
    default:
      throw new Error("Unrecognised attendance status");
  }
}
