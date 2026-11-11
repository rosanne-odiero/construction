import { isWorkedStatus, type AnomalyKind, type LabourerStatus } from "@pm-buddy/types";
import type { DayRecord, LabourerDayResult } from "./compute.js";
import { MINUTES_PER_DAY } from "./time.js";

/**
 * Attendance anomaly rules (brief §5.5 anti-fraud; ARCHITECTURE §13). Each finding names the record
 * it concerns. Findings are review signals for a person (CR-DP-09): the API stores them as open
 * anomalies that block period approval until someone other than the recorder resolves or dismisses
 * them; nothing here changes pay by itself.
 */

export type AnomalyRecord = DayRecord & {
  /** Whether the labourer was engaged on the record's project on the date. */
  engaged: boolean;
};

export type AnomalyLabourer = {
  status: LabourerStatus;
  doNotRehire: boolean;
  /** The labourer's skill level expects an NCA card (skilled workers, site supervisors). */
  accreditationExpected: boolean;
  cards: readonly { issuedOn: string | null; expiresOn: string }[];
};

export type AnomalyDetails = Record<string, string | number | boolean | string[]>;
export type DetectedAnomaly = { recordId: string; kind: AnomalyKind; details: AnomalyDetails };

const interval = (record: DayRecord): [number, number] | null =>
  record.checkIn === null || record.checkOut === null
    ? null
    : [record.checkIn, record.checkOut + (record.overnight ? MINUTES_PER_DAY : 0)];

/** Whether an NCA card is valid on `date` (issued on or before, expiring on or after). */
export function hasValidCard(cards: AnomalyLabourer["cards"], date: string): boolean {
  return cards.some((card) => (card.issuedOn ?? "0000-01-01") <= date && card.expiresOn >= date);
}

/**
 * The anomalies of one labourer-day: every record of the labourer on that date across sites and
 * projects, with the day computed by `computeLabourerDay`.
 */
export function detectDayAnomalies(input: {
  records: readonly AnomalyRecord[];
  result: LabourerDayResult;
  labourer: AnomalyLabourer;
  date: string;
}): DetectedAnomaly[] {
  const found: DetectedAnomaly[] = [];
  const worked = input.records.filter(
    (record) => isWorkedStatus(record.status) && interval(record) !== null,
  );
  const sites = [...new Set(worked.map((record) => record.siteId))];
  if (sites.length > 1)
    for (const record of worked)
      found.push({
        recordId: record.id,
        kind: "two_sites",
        details: {
          siteCount: sites.length,
          otherSiteIds: sites.filter((site) => site !== record.siteId).sort(),
        },
      });
  for (const record of worked) {
    const [start, end] = interval(record)!;
    let overlap = 0;
    for (const other of worked) {
      if (other === record) continue;
      const [from, to] = interval(other)!;
      overlap += Math.max(0, Math.min(end, to) - Math.max(start, from));
    }
    if (overlap > 0)
      found.push({
        recordId: record.id,
        kind: "overlapping_times",
        details: { overlapMinutes: overlap },
      });
  }
  const max = input.result.maxPlausibleMinutes;
  if (max !== null && input.result.totalWorkedMinutes > max)
    for (const record of worked)
      found.push({
        recordId: record.id,
        kind: "excess_hours",
        details: { workedMinutes: input.result.totalWorkedMinutes, maxPlausibleMinutes: max },
      });
  for (const record of input.records)
    if (!record.engaged) found.push({ recordId: record.id, kind: "not_engaged", details: {} });
  for (const record of worked) {
    if (input.labourer.status !== "active")
      found.push({
        recordId: record.id,
        kind: "labourer_inactive",
        details: { labourerStatus: input.labourer.status },
      });
    if (input.labourer.doNotRehire)
      found.push({ recordId: record.id, kind: "do_not_rehire", details: {} });
    if (input.labourer.accreditationExpected && !hasValidCard(input.labourer.cards, input.date))
      found.push({
        recordId: record.id,
        kind: "accreditation_invalid",
        details: { cards: input.labourer.cards.length },
      });
  }
  return found;
}
