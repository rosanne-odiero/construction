import { isWorkedStatus, type AttendanceStatus } from "@pm-buddy/types";

/**
 * The site diary's workforce by trade, taken from attendance (D6.1, brief §5.9). Everyone recorded
 * present or on a half day at the site that day counts once under their trade; absences, leave and
 * sick days do not. The database recomputes the same summary when a diary stores a snapshot
 * (`app.diary_attendance_workforce`), so a forged count is refused.
 */

export type WorkforceRecord = {
  tradeId: string;
  tradeKey: string;
  nameEn: string;
  nameSw: string;
  sortOrder: number;
  status: AttendanceStatus;
};

export type WorkforceTrade = {
  tradeId: string;
  key: string;
  nameEn: string;
  nameSw: string;
  /** People present or on a half day. */
  headcount: number;
  /** Of whom on a half day. */
  halfDays: number;
};

export type WorkforceSummary = { total: number; trades: WorkforceTrade[] };

/** Trades in the company's order, then by key in code-point order (as the database sorts). */
export function summariseWorkforce(records: readonly WorkforceRecord[]): WorkforceSummary {
  const byTrade = new Map<string, WorkforceTrade & { sortOrder: number }>();
  for (const record of records) {
    if (!isWorkedStatus(record.status)) continue;
    const entry = byTrade.get(record.tradeId) ?? {
      tradeId: record.tradeId,
      key: record.tradeKey,
      nameEn: record.nameEn,
      nameSw: record.nameSw,
      sortOrder: record.sortOrder,
      headcount: 0,
      halfDays: 0,
    };
    entry.headcount += 1;
    if (record.status === "half_day") entry.halfDays += 1;
    byTrade.set(record.tradeId, entry);
  }
  const trades = [...byTrade.values()]
    .sort((a, b) =>
      a.sortOrder !== b.sortOrder
        ? a.sortOrder - b.sortOrder
        : a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0,
    )
    .map((entry) => ({
      tradeId: entry.tradeId,
      key: entry.key,
      nameEn: entry.nameEn,
      nameSw: entry.nameSw,
      headcount: entry.headcount,
      halfDays: entry.halfDays,
    }));
  return { total: trades.reduce((sum, trade) => sum + trade.headcount, 0), trades };
}
