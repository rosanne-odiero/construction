import { people, seededRandom } from "./company";
import { labourers, type Labourer } from "./labour";

export type PayoutStatus = "pending" | "sent" | "confirmed" | "failed" | "reversed";

export interface PayrollLine {
  labourer: Labourer;
  days: number;
  otHours: number;
  grossMinor: number;
  nssfMinor: number;
  shifMinor: number;
  ahlMinor: number;
  payeMinor: number;
  advanceMinor: number;
  netMinor: number;
  outcome: {
    result: "confirmed" | "failed" | "name_mismatch";
    receipt?: string;
    mpesaName?: string;
  };
}

/*
 * COMPLIANCE-REVIEW: illustrative figures only. The real statutory engine (D4.1) reads versioned,
 * effective-dated rules (PAYE bands, NSSF tiers and limits, SHIF, Housing Levy) and the
 * engagement-type mapping from config. Nothing below is a statement of Kenyan law.
 */
const ILLUSTRATIVE = {
  hoursPerDay: 8,
  weekdayOtMultiplier: 1.5,
  nssfRate: 0.06,
  shifRate: 0.0275,
  ahlRate: 0.015,
  payeMonthlyBands: [
    { upTo: 24_000, rate: 0.1 },
    { upTo: 32_333, rate: 0.25 },
    { upTo: 500_000, rate: 0.3 },
    { upTo: 800_000, rate: 0.325 },
    { upTo: Number.POSITIVE_INFINITY, rate: 0.35 },
  ],
  monthlyRelief: 2_400,
  weeklyFactor: 12 / 52,
};

function illustrativePaye(weeklyTaxable: number): number {
  const f = ILLUSTRATIVE.weeklyFactor;
  let tax = 0;
  let lower = 0;
  for (const band of ILLUSTRATIVE.payeMonthlyBands) {
    const upper = band.upTo * f;
    if (weeklyTaxable > lower) tax += (Math.min(weeklyTaxable, upper) - lower) * band.rate;
    lower = upper;
  }
  return Math.max(0, Math.round(tax - ILLUSTRATIVE.monthlyRelief * f));
}

const daysOverride: Record<string, number> = {
  "Felix Okoth Owuor": 5,
  "Mercy Akinyi Onyango": 5.5,
  "Lucy Moraa Kerubo": 4,
};
const advances: Record<string, number> = {
  "Wycliffe Wekesa Barasa": 1_000,
  "Kelvin Mutiso Muli": 500,
  "Collins Masinde Shikuku": 1_500,
};

const rand = seededRandom(45);
const receipt = () =>
  `TKA${Array.from({ length: 7 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(rand() * 34)]).join("")}`;

export const payrollLines: PayrollLine[] = labourers.map((labourer) => {
  const rate = labourer.dailyRateMinor / 100;
  const days = labourer.trade === "watchman" ? 7 : (daysOverride[labourer.name] ?? 6);
  const otHours = labourer.gang === "A" || labourer.gang === "C" ? 4 : 0;
  const gross = Math.round(
    days * rate + otHours * (rate / ILLUSTRATIVE.hoursPerDay) * ILLUSTRATIVE.weekdayOtMultiplier,
  );
  const nssf = Math.round(gross * ILLUSTRATIVE.nssfRate);
  const shif = Math.round(gross * ILLUSTRATIVE.shifRate);
  const ahl = Math.round(gross * ILLUSTRATIVE.ahlRate);
  const paye = illustrativePaye(gross - nssf - shif - ahl);
  const advance = advances[labourer.name] ?? 0;
  const net = gross - nssf - shif - ahl - paye - advance;

  let outcome: PayrollLine["outcome"] = { result: "confirmed", receipt: receipt() };
  if (labourer.name === "Lekishon Mpaka") outcome = { result: "failed" };
  if (labourer.name === "Naomi Gatwiri Kirimi")
    outcome = { result: "name_mismatch", receipt: receipt(), mpesaName: "JOHN KAMAU MAINA" };

  return {
    labourer,
    days,
    otHours,
    grossMinor: gross * 100,
    nssfMinor: nssf * 100,
    shifMinor: shif * 100,
    ahlMinor: ahl * 100,
    payeMinor: paye * 100,
    advanceMinor: advance * 100,
    netMinor: net * 100,
    outcome,
  };
});

const total = (pick: (l: PayrollLine) => number) =>
  payrollLines.reduce((acc, l) => acc + pick(l), 0);

// COMPLIANCE-REVIEW: M-Pesa B2C charges come from the effective-dated tariff table in config.
const ILLUSTRATIVE_CHARGE_PER_PAYOUT_MINOR = 15_00;

export const payrollBatch = {
  number: "PR-2026-W45",
  project: "Ruiru Heights Apartments",
  periodStart: "2026-11-02",
  periodEnd: "2026-11-08",
  frequency: "weekly" as const,
  preparedBy: people.foreman,
  preparedAt: "2026-11-09T16:40:00+03:00",
  reviewedBy: people.finance,
  reviewedAt: "2026-11-10T07:15:00+03:00",
  workers: payrollLines.length,
  grossMinor: total((l) => l.grossMinor),
  statutoryMinor: total((l) => l.nssfMinor + l.shifMinor + l.ahlMinor + l.payeMinor),
  advancesMinor: total((l) => l.advanceMinor),
  netMinor: total((l) => l.netMinor),
  chargesMinor: payrollLines.length * ILLUSTRATIVE_CHARGE_PER_PAYOUT_MINOR,
  floatMinor: 1_284_500_00,
};
