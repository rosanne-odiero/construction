import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../generated/prisma/client.js";
import type { LabourCrypto } from "../labour/labour-support.js";
import { WorkerSelfService } from "./worker-self-service.js";

function fixture(matches = [{ id: "worker", idNumberBidx: "id-index" }]) {
  const tx = {
    labourer: { findMany: vi.fn().mockResolvedValue(matches) },
    attendanceRecord: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "a1",
          workDate: new Date("2026-11-02"),
          status: "present",
          day: { status: "confirmed" },
          site: { name: "One", project: { name: "Assigned" } },
        },
        {
          id: "a2",
          workDate: new Date("2026-11-02"),
          status: "present",
          day: { status: "confirmed" },
          site: { name: "Two", project: { name: "Assigned" } },
        },
        {
          id: "a3",
          workDate: new Date("2026-11-03"),
          status: "half_day",
          day: { status: "confirmed" },
          site: { name: "One", project: { name: "Assigned" } },
        },
        {
          id: "a4",
          workDate: new Date("2026-11-04"),
          status: "present",
          day: { status: "draft" },
          site: { name: "One", project: { name: "Assigned" } },
        },
      ]),
    },
    payrollLine: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "line",
          grossMinor: 900719925474099300n,
          netMinor: 900719925474090000n,
          daysWorked: 5,
          batch: {
            periodStart: new Date("2026-11-01"),
            periodEnd: new Date("2026-11-07"),
            project: { name: "Assigned" },
          },
        },
      ]),
    },
    salaryAdvance: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { amountMinor: 100000n, recoveries: [{ amountMinor: 10000n }, { amountMinor: 20000n }] },
        ]),
    },
  };
  const crypto = {
    index: vi.fn().mockReturnValue("phone-index"),
    idIndex: vi.fn().mockReturnValue("id-index"),
  };
  const service = new WorkerSelfService(crypto as unknown as LabourCrypto);
  const read = (idNumber?: string) =>
    service.read(
      tx as unknown as Prisma.TransactionClient,
      "tenant",
      "254712345678",
      ["assigned-project"],
      idNumber,
    );
  return { tx, crypto, read };
}

describe("Worker self-service reads", () => {
  it("counts confirmed dates once, keeps exact submitted pay and never invents payment confirmations", async () => {
    const { tx, crypto, read } = fixture();
    const result = await read("12345678");
    expect(crypto.index).toHaveBeenCalledWith("tenant", "phone", "254712345678");
    expect(crypto.idIndex).toHaveBeenCalledWith("tenant", "12345678");
    expect(result.attendance?.daysWorked).toBe(1.5);
    expect(result.attendance?.records).toHaveLength(4);
    expect(result.pay).toEqual({
      lines: [
        {
          id: "line",
          project: "Assigned",
          from: "2026-11-01",
          to: "2026-11-07",
          grossMinor: "900719925474099300",
          deductionsMinor: "9300",
          netMinor: "900719925474090000",
          daysWorked: 5,
        },
      ],
      advancesOutstandingMinor: "70000",
      payments: null,
    });
    const ownScope = {
      tenantId: "tenant",
      labourerId: "worker",
      projectId: { in: ["assigned-project"] },
    };
    expect(tx.attendanceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(ownScope) }),
    );
    expect(tx.payrollLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...ownScope, batch: { status: "submitted" } },
        take: 12,
      }),
    );
    expect(tx.salaryAdvance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...ownScope, status: "disbursed" },
        select: expect.objectContaining({
          recoveries: {
            where: { line: { batch: { status: "submitted" } } },
            select: { amountMinor: true },
          },
        }),
      }),
    );
  });

  it.each([
    [],
    [
      { id: "one", idNumberBidx: "id-index" },
      { id: "two", idNumberBidx: "another" },
    ],
  ])(
    "does not read attendance or pay without an unambiguous phone match (%j)",
    async (...matches) => {
      const { tx, read } = fixture(matches);
      expect(await read()).toEqual({ attendance: null, pay: null });
      expect(tx.attendanceRecord.findMany).not.toHaveBeenCalled();
      expect(tx.payrollLine.findMany).not.toHaveBeenCalled();
      expect(tx.salaryAdvance.findMany).not.toHaveBeenCalled();
      await expect(read("12345678")).rejects.toMatchObject({ status: 401 });
    },
  );

  it("checks the ID blind index before querying any worker financial data", async () => {
    const { tx, read } = fixture([{ id: "worker", idNumberBidx: "different-id" }]);
    await expect(read("12345678")).rejects.toMatchObject({ status: 401 });
    expect(tx.payrollLine.findMany).not.toHaveBeenCalled();
    expect(tx.attendanceRecord.findMany).not.toHaveBeenCalled();
  });

  it("counts two confirmed half-day site entries as one day, capped at one per date", async () => {
    const { tx, read } = fixture();
    tx.attendanceRecord.findMany.mockResolvedValue(
      [1, 2, 3].map((n) => ({
        id: `half-${n}`,
        workDate: new Date("2026-11-02"),
        status: "half_day",
        day: { status: "confirmed" },
        site: { name: `Site ${n}`, project: { name: "Assigned" } },
      })),
    );
    expect((await read()).attendance?.daysWorked).toBe(1);
  });
});
