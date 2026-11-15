import type {
  BreakdownResolution,
  BreakdownSeverity,
  OperatorCertificateState,
  PlantAlertKind,
  PlantAlertSeverity,
  PlantCategory,
  PlantOwnership,
  PlantStatus,
  ServiceState,
} from "@pm-buddy/types";
import { addCalendarDays } from "../labour.js";

/**
 * Plant register rules (docs/WORKFLOWS.md "Plant and equipment", decisions D-91–D-98). The status
 * follows from where the item is, whether a major or unsafe breakdown is open, and whether it has
 * gone off hire or been disposed of; `app.check_plant_item_state` repeats the rule in the database.
 */

/** Major and unsafe breakdowns take the item out of service; a minor one does not. */
export const breakdownBlocks = (severity: BreakdownSeverity): boolean => severity !== "minor";

/** The status an item must have. */
export function expectedPlantStatus(input: {
  closed: "off_hire" | "disposed" | null;
  siteId: string | null;
  openSeverities: readonly BreakdownSeverity[];
}): PlantStatus {
  if (input.closed) return input.closed;
  if (input.openSeverities.some(breakdownBlocks)) return "under_repair";
  return input.siteId ? "on_site" : "available";
}

export const isPlantClosed = (status: PlantStatus): boolean =>
  status === "off_hire" || status === "disposed";

/** Hired plant goes back to its supplier (off hire); owned plant is written off (disposed). */
export function breakdownResolutionAllowed(
  ownership: PlantOwnership,
  resolution: BreakdownResolution,
): boolean {
  if (resolution === "off_hire") return ownership === "hired";
  if (resolution === "written_off") return ownership === "owned";
  return true;
}

/**
 * Whether an operator assignment is backed by a certificate where the category needs one
 * (COMPLIANCE-REVIEW CR-PLT-01): `missing` without a reference, `expired` after its expiry,
 * `expiring` within the warning window.
 */
export function operatorCertificateState(input: {
  category: PlantCategory;
  requiredCategories: readonly PlantCategory[];
  certificateRef: string | null;
  expiresOn: string | null;
  today: string;
  warningDays: number;
}): OperatorCertificateState {
  if (!input.requiredCategories.includes(input.category)) return "not_required";
  if (!input.certificateRef) return "missing";
  if (!input.expiresOn) return "valid";
  if (input.expiresOn < input.today) return "expired";
  return input.expiresOn <= addCalendarDays(input.today, input.warningDays) ? "expiring" : "valid";
}

export type PlantAlertInput = {
  ownership: PlantOwnership;
  status: PlantStatus;
  today: string;
  hireEndOn: string | null;
  hireEndingDays: number;
  /** Days without a working day (hired plant only; see idleDays). */
  idleDays: number;
  idleHireDays: number;
  service: ServiceState;
  openBreakdowns: readonly BreakdownSeverity[];
  /** The latest judged fuel window within the alert period is over the standard. */
  fuelOverStandard: boolean;
  /** Fuel was issued on a meter that had not moved, within the alert period. */
  fuelMeterStatic: boolean;
  /** Current operator assignments' certificate states. */
  operatorCertificates: readonly OperatorCertificateState[];
};
export type PlantAlert = { kind: PlantAlertKind; severity: PlantAlertSeverity };

const ORDER: readonly PlantAlertKind[] = [
  "unsafe_breakdown",
  "service_overdue",
  "operator_certificate",
  "hire_overrun",
  "fuel_over_standard",
  "fuel_meter_static",
  "breakdown_open",
  "idle_on_hire",
  "service_due",
  "hire_ending",
];

/**
 * What needs attention on one item, critical first. Closed items (off hire, disposed) raise
 * nothing. Fuel alerts are estimates for review, never proof of theft.
 */
export function plantAlerts(input: PlantAlertInput): PlantAlert[] {
  if (isPlantClosed(input.status)) return [];
  const alerts: PlantAlert[] = [];
  const add = (kind: PlantAlertKind, severity: PlantAlertSeverity) =>
    alerts.push({ kind, severity });
  if (input.openBreakdowns.includes("unsafe")) add("unsafe_breakdown", "critical");
  else if (input.openBreakdowns.length) add("breakdown_open", "warning");
  if (input.service === "overdue") add("service_overdue", "critical");
  else if (input.service === "due") add("service_due", "warning");
  if (input.fuelOverStandard) add("fuel_over_standard", "warning");
  if (input.fuelMeterStatic) add("fuel_meter_static", "warning");
  const certificates = input.operatorCertificates;
  if (certificates.some((state) => state === "missing" || state === "expired"))
    add("operator_certificate", "critical");
  else if (certificates.includes("expiring")) add("operator_certificate", "warning");
  if (input.ownership === "hired") {
    if (input.idleDays >= input.idleHireDays) add("idle_on_hire", "warning");
    if (input.hireEndOn && input.hireEndOn < input.today) add("hire_overrun", "critical");
    else if (
      input.hireEndOn &&
      input.hireEndOn <= addCalendarDays(input.today, input.hireEndingDays)
    )
      add("hire_ending", "warning");
  }
  return alerts.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
