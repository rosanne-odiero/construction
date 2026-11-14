import type {
  BudgetStatus,
  CostCategory,
  CountStatus,
  ExpenseStatus,
  JournalStatus,
  SpendAlertSeverity,
  TopUpStatus,
} from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";

/**
 * Display and input helpers for the spending screens (D5.4). Money arrives and leaves as integer
 * KES minor units. Input helpers trim what was typed and return null instead of throwing, so a
 * pasted "1,250 " or "1e3" can never break a render.
 */

export type BudgetLevel = "unavailable" | "within" | "threshold" | "over";

export const levelTone: Record<BudgetLevel, Tone> = {
  unavailable: "neutral",
  within: "success",
  threshold: "warning",
  over: "danger",
};

export const budgetStatusTone: Record<BudgetStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  cancelled: "neutral",
};

export const expenseTone: Record<ExpenseStatus, Tone> = {
  submitted: "info",
  approved: "success",
  rejected: "danger",
};

export const topUpTone: Record<TopUpStatus, Tone> = {
  requested: "info",
  approved: "warning",
  paid: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export const countTone: Record<CountStatus, Tone> = {
  submitted: "info",
  approved: "success",
  returned: "warning",
};

export const journalTone: Record<JournalStatus, Tone> = {
  submitted: "info",
  approved: "success",
  rejected: "danger",
};

export const alertTone: Record<SpendAlertSeverity, Tone> = {
  critical: "danger",
  warning: "warning",
};

const AMOUNT = /^(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/;

/**
 * A KES amount as typed ("1,250", " 1250.5 ", "0.75") → minor units; null when malformed,
 * negative, above 10¹³ shillings or with more than two decimals. `allowZero` accepts 0.
 */
export function parseKesInput(value: string, allowZero = false): number | null {
  const trimmed = value.trim();
  const match = AMOUNT.exec(trimmed);
  if (!match) return null;
  const [whole = "0", fraction = ""] = trimmed.replaceAll(",", "").split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  if (minor === 0 && !allowZero) return null;
  return minor;
}

/** Minor units as an input value: 125050 → "1250.50", 125000 → "1250". */
export function minorToInput(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

/** A whole number typed into a settings field, trimmed; null outside [min, max]. */
export function parseWholeNumber(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return number >= min && number <= max ? number : null;
}

/** A truncated one-decimal percentage from the API ("81.0") for display; "—" when undefined. */
export function percentLabel(value: string | null): string {
  return value === null ? "—" : `${value}%`;
}

/** Costs grouped for the budget view in the order the brief lists them. */
export const CATEGORY_ORDER: readonly CostCategory[] = [
  "materials",
  "labour",
  "plant",
  "subcontract",
  "preliminaries",
  "fees",
  "permits",
  "transport",
  "petty_cash",
];

export type ChartWeek = {
  start: string;
  inMinor: number;
  outMinor: number;
  closingMinor: number | null;
};
export type ChartGeometry = {
  width: number;
  height: number;
  zeroY: number;
  bars: {
    start: string;
    x: number;
    width: number;
    inY: number;
    inHeight: number;
    outY: number;
    outHeight: number;
  }[];
  line: string | null;
  points: { start: string; x: number; y: number }[];
};

/**
 * Pixel positions for the forecast chart: inflow bars above and outflow bars below the zero line,
 * and the closing balance as a polyline. Pixels only — the table shows the exact amounts.
 */
export function forecastGeometry(
  weeks: readonly ChartWeek[],
  width = 720,
  height = 240,
): ChartGeometry {
  const pad = 16;
  const values = weeks.flatMap((week) => [
    week.inMinor,
    -week.outMinor,
    ...(week.closingMinor === null ? [] : [week.closingMinor]),
  ]);
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const y = (value: number) => pad + ((top - value) / span) * (height - pad * 2);
  const slot = weeks.length ? (width - pad * 2) / weeks.length : 0;
  const barWidth = Math.max(2, slot * 0.6);
  const zeroY = y(0);
  const bars = weeks.map((week, index) => {
    const x = pad + index * slot + (slot - barWidth) / 2;
    const inY = y(week.inMinor);
    const outY = y(-week.outMinor);
    return {
      start: week.start,
      x,
      width: barWidth,
      inY,
      inHeight: Math.max(0, zeroY - inY),
      outY: zeroY,
      outHeight: Math.max(0, outY - zeroY),
    };
  });
  const points = weeks.flatMap((week, index) =>
    week.closingMinor === null
      ? []
      : [{ start: week.start, x: pad + index * slot + slot / 2, y: y(week.closingMinor) }],
  );
  return {
    width,
    height,
    zeroY,
    bars,
    points,
    line:
      points.length > 1
        ? points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")
        : null,
  };
}

/** A client-generated identifier (record IDs and idempotency keys), created once per form. */
export const newClientId = () => crypto.randomUUID();
