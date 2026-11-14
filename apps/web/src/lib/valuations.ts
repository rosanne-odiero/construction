import type { MeasurementState, ValuationStatus } from "@pm-buddy/types";
import type { Tone } from "@/components/status-badge";

/**
 * Display and input helpers for the measurement and valuation screens (D6.3). Money arrives and
 * leaves as integer KES minor units; quantities are decimal strings with up to four places.
 * Input helpers trim what was typed and return null instead of throwing, so a pasted value can
 * never break a render.
 */

export const valuationStatusTone: Record<ValuationStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  certified: "success",
  cancelled: "neutral",
};

export const measurementStateTone: Record<MeasurementState, Tone> = {
  pending: "info",
  approved: "success",
  rejected: "danger",
  withdrawn: "neutral",
  superseded: "neutral",
};

export const VALUATION_TABS = [
  "measurements",
  "certificates",
  "retention",
  "earned-value",
] as const;
export type ValuationTab = (typeof VALUATION_TABS)[number];

/** Which project tabs the caller sees (the API enforces the same permissions). */
export function valuationAccess(permissions: readonly string[]) {
  const has = (...keys: string[]) => keys.some((key) => permissions.includes(key));
  return {
    measurements: has(
      "bq.edit",
      "site.diary",
      "projects.manage",
      "stores.manage",
      "procurement.requisition",
      "procurement.approve",
      "finance.view",
      "finance.manage",
    ),
    certificates: has("bq.edit", "finance.view", "finance.manage"),
    earnedValue: has("finance.view", "finance.manage"),
  };
}

const QUANTITY = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;

/**
 * A quantity to date as typed ("12.5", " 1,250 ") → its canonical decimal text; null when
 * malformed, negative, with more than four decimals, or a percentage above 100.
 */
export function parseQuantityInput(value: string, percent = false): string | null {
  const trimmed = value.trim().replaceAll(",", "");
  if (!QUANTITY.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const tidy = fraction.replace(/0+$/, "");
  const text = tidy ? `${whole}.${tidy}` : whole;
  if (percent && Number(text) > 100) return null;
  return text;
}

/** Whether a quantity exceeds the BQ quantity (both decimal strings, exact to four places). */
export function exceedsQuantity(quantity: string, itemQuantity: string | null): boolean {
  if (itemQuantity === null) return false;
  const scale = (text: string) => {
    const [whole = "0", fraction = ""] = text.split(".");
    return BigInt(whole) * BigInt(10_000) + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  };
  return scale(quantity) > scale(itemQuantity);
}

/** A two-decimal ratio from the API ("1.17") or "—" when unavailable. */
export const ratioLabel = (value: string | null) => value ?? "—";

export type CurvePointInput = {
  weekEnd: string;
  pvMinor: number | null;
  evMinor: number | null;
  acMinor: number | null;
};
export type CurveGeometry = {
  width: number;
  height: number;
  top: number;
  lines: { key: "pv" | "ev" | "ac"; points: string | null }[];
  ticks: { x: number; label: string }[];
};

/**
 * Pixel positions for the S-curve (planned, earned and actual cumulative values per week):
 * one polyline per series over the weeks that have a value. Pixels only — the table beside it
 * carries the exact amounts.
 */
export function curveGeometry(
  points: readonly CurvePointInput[],
  width = 720,
  height = 260,
): CurveGeometry {
  const pad = 20;
  const values = points.flatMap((point) =>
    [point.pvMinor, point.evMinor, point.acMinor].filter(
      (value): value is number => value !== null,
    ),
  );
  const top = Math.max(1, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const x = (index: number) => pad + index * step;
  const y = (value: number) => pad + ((top - value) / span) * (height - pad * 2);
  const line = (pick: (point: CurvePointInput) => number | null) => {
    const coordinates = points.flatMap((point, index) => {
      const value = pick(point);
      return value === null ? [] : [`${x(index).toFixed(1)},${y(value).toFixed(1)}`];
    });
    return coordinates.length > 1 ? coordinates.join(" ") : null;
  };
  const every = Math.max(1, Math.ceil(points.length / 6));
  return {
    width,
    height,
    top,
    lines: [
      { key: "pv", points: line((point) => point.pvMinor) },
      { key: "ev", points: line((point) => point.evMinor) },
      { key: "ac", points: line((point) => point.acMinor) },
    ],
    ticks: points
      .map((point, index) => ({ x: x(index), label: point.weekEnd, index }))
      .filter((tick) => tick.index % every === 0)
      .map(({ x: position, label }) => ({ x: position, label })),
  };
}

/** The item reference shown in lists: "Bill 2 · A" or the description when there is no ref. */
export function itemLabel(item: {
  ref: string | null;
  description: string;
  bill?: { number: string } | null;
}): string {
  const ref = item.ref ?? item.description.slice(0, 40);
  return item.bill ? `${item.bill.number} · ${ref}` : ref;
}
