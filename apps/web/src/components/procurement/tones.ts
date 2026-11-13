import type { Tone } from "@/components/status-badge";
import type { Price, PayoutVersion, Supplier } from "@pm-buddy/validation";

/** Badge tones for price alerts, supplier status, eTIMS and payout states (D5.1). */
export const alertTone: Record<Price["alertState"], Tone> = {
  first_price: "neutral",
  within_threshold: "success",
  above_threshold: "warning",
  not_comparable: "neutral",
};

export const supplierStatusTone: Record<Supplier["status"], Tone> = {
  active: "success",
  on_hold: "warning",
  blocked: "danger",
};

export const etimsTone: Record<Supplier["etimsStatus"], Tone> = {
  registered: "success",
  unknown: "neutral",
  not_registered: "warning",
};

export const payoutTone: Record<PayoutVersion["status"] | "none", Tone> = {
  none: "neutral",
  pending: "warning",
  verified: "success",
  rejected: "danger",
  superseded: "neutral",
};
