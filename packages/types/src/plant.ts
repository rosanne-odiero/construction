import type { Permission } from "./permissions.js";

/**
 * Plant and equipment vocabulary (D8.3, brief §5.13 and §15 C/G; ARCHITECTURE §4.11; WORKFLOWS
 * "Plant and equipment"). The database CHECK constraints and triggers in migration
 * `20261126090000_plant` list the same values, so adding one needs a migration as well as a change
 * here. Fuel variance alerts are estimates for review, never proof of theft (brief §15 G); operator
 * certificate rules and consumption standards are flagged COMPLIANCE-REVIEW (CR-PLT-01 to
 * CR-PLT-03).
 */

/** What the item is. Scaffolding and formwork have no meter and are counted by quantity. */
export const PLANT_CATEGORIES = [
  "concrete_mixer",
  "vibrator",
  "excavator",
  "loader",
  "roller",
  "compactor",
  "generator",
  "pump",
  "crane_hoist",
  "scaffolding",
  "formwork",
  "vehicle",
  "other",
] as const;
export type PlantCategory = (typeof PLANT_CATEGORIES)[number];

export const PLANT_OWNERSHIPS = ["owned", "hired"] as const;
export type PlantOwnership = (typeof PLANT_OWNERSHIPS)[number];

/** A hire rate is per calendar day on hire, per hour on the hour meter, or per 30-day month. */
export const HIRE_RATE_UNITS = ["day", "hour", "month"] as const;
export type HireRateUnit = (typeof HIRE_RATE_UNITS)[number];

/** The meter read on site: engine hours, kilometres, or none (scaffolding, formwork, hand tools). */
export const METER_TYPES = ["hours", "km", "none"] as const;
export type MeterType = (typeof METER_TYPES)[number];

export const FUEL_TYPES = ["diesel", "petrol", "none"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

/**
 * available (in the yard, no site) ⇄ on_site (at a project site); either → under_repair while a
 * major or unsafe breakdown is open (wherever the item is); hired items end off_hire, owned items
 * disposed — both final, with a date and a reason.
 */
export const PLANT_STATUSES = [
  "available",
  "on_site",
  "under_repair",
  "off_hire",
  "disposed",
] as const;
export type PlantStatus = (typeof PLANT_STATUSES)[number];
/** Register actions that end an item's life: off hire (hired) or disposed (owned). */
export const PLANT_CLOSE_ACTIONS = ["off_hire", "dispose"] as const;
export type PlantCloseAction = (typeof PLANT_CLOSE_ACTIONS)[number];

/** A day on site: working, idle (on site, not used) or broken down. */
export const USAGE_DAY_STATUSES = ["working", "idle", "breakdown"] as const;
export type UsageDayStatus = (typeof USAGE_DAY_STATUSES)[number];

/** Where the fuel came from (the fuel log does not post to the stores ledger, decision D-93). */
export const FUEL_SOURCES = ["site_store", "fuel_station", "bowser", "other"] as const;
export type FuelSource = (typeof FUEL_SOURCES)[number];

/** Why a meter starts again from another reading (recorded with a note, decision D-92). */
export const METER_RESET_REASONS = ["meter_replaced", "meter_reset", "rollover", "other"] as const;
export type MeterResetReason = (typeof METER_RESET_REASONS)[number];

/**
 * minor: can keep working; major: cannot work (under repair); unsafe: must not be used — no
 * working day can be logged while it is open, and only plant.manage records the repair.
 */
export const BREAKDOWN_SEVERITIES = ["minor", "major", "unsafe"] as const;
export type BreakdownSeverity = (typeof BREAKDOWN_SEVERITIES)[number];
/** open → repaired | off_hire (hired: sent back) | written_off (owned: beyond repair). */
export const BREAKDOWN_STATUSES = ["open", "repaired", "off_hire", "written_off"] as const;
export type BreakdownStatus = (typeof BREAKDOWN_STATUSES)[number];
export const BREAKDOWN_RESOLUTIONS = ["repaired", "off_hire", "written_off"] as const;
export type BreakdownResolution = (typeof BREAKDOWN_RESOLUTIONS)[number];

export const SERVICE_KINDS = ["service", "repair", "inspection"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_RECORD_STATUSES = ["recorded", "voided"] as const;
export type ServiceRecordStatus = (typeof SERVICE_RECORD_STATUSES)[number];
/** The maintenance schedule against usage and dates: none set, fine, due soon, overdue. */
export const SERVICE_STATES = ["not_scheduled", "ok", "due", "overdue"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** An operator is a labourer engaged on the project or a staff member (a company member). */
export const OPERATOR_KINDS = ["labourer", "staff"] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];
/** An operator assignment's certificate against the category rule (COMPLIANCE-REVIEW CR-PLT-01). */
export const OPERATOR_CERTIFICATE_STATES = [
  "not_required",
  "valid",
  "expiring",
  "expired",
  "missing",
] as const;
export type OperatorCertificateState = (typeof OPERATOR_CERTIFICATE_STATES)[number];

/** Usage logs and fuel issues: the newest row of a correction chain is current (decision D-91). */
export const PLANT_RECORD_STATES = ["current", "superseded", "voided"] as const;
export type PlantRecordState = (typeof PLANT_RECORD_STATES)[number];

/**
 * A fuel window between two full-tank fillings (decision D-94): judged against the standard,
 * still short of the minimum sample (extended to the next full filling), or open (no closing full
 * filling yet).
 */
export const FUEL_WINDOW_STATES = ["within_standard", "over_standard", "short_sample"] as const;
export type FuelWindowState = (typeof FUEL_WINDOW_STATES)[number];

/**
 * What the register and the project's plant tab flag. Fuel alerts are estimates for review,
 * never proof of theft (brief §15 G).
 */
export const PLANT_ALERT_KINDS = [
  "fuel_over_standard",
  "fuel_meter_static",
  "unsafe_breakdown",
  "breakdown_open",
  "service_overdue",
  "service_due",
  "idle_on_hire",
  "hire_overrun",
  "hire_ending",
  "operator_certificate",
] as const;
export type PlantAlertKind = (typeof PLANT_ALERT_KINDS)[number];
export const PLANT_ALERT_SEVERITIES = ["warning", "critical"] as const;
export type PlantAlertSeverity = (typeof PLANT_ALERT_SEVERITIES)[number];

/**
 * Company defaults (CONFIGURATION "Plant and equipment"): a fuel window is judged once it covers
 * at least 10 engine hours or 100 km and flagged above 15 % over the standard; hired plant is
 * flagged after 3 days without a working day and 7 days before its hire ends; a service is due
 * within the last 10 % of its interval. Operator certificates are expected for excavators,
 * loaders, rollers, cranes and hoists, and vehicles (COMPLIANCE-REVIEW CR-PLT-01).
 */
export const DEFAULT_PLANT_SETTINGS = {
  fuelVariancePercent: 15,
  fuelMinHours: 10,
  fuelMinKm: 100,
  idleHireDays: 3,
  hireEndingDays: 7,
  serviceDueSoonPercent: 10,
  certificateCategories: [
    "excavator",
    "loader",
    "roller",
    "crane_hoist",
    "vehicle",
  ] as readonly PlantCategory[],
} as const;
export const PLANT_SETTINGS_LIMITS = {
  fuelVariancePercent: { min: 1, max: 100 },
  fuelMinHours: { min: 1, max: 200 },
  fuelMinKm: { min: 10, max: 5000 },
  idleHireDays: { min: 1, max: 60 },
  hireEndingDays: { min: 1, max: 60 },
  serviceDueSoonPercent: { min: 0, max: 50 },
} as const;

export const PLANT_LIMITS = {
  maxPageSize: 100,
  /** Meter readings: 0.0–9,999,999.9 (one decimal place). */
  maxReadingTenths: 99_999_999,
  /** One day's usage on an hour meter cannot exceed 24.0 hours, nor 1,500 km on an odometer. */
  maxDayHoursTenths: 240,
  maxDayKmTenths: 15_000,
  /** One fuel issue: 0.1–2,000.0 litres. */
  maxLitresTenths: 20_000,
  /** Standard consumption: 0.01–999.99 litres per hour or per km. */
  maxStandardHundredths: 99_999,
  /** Service interval: up to 99,999.9 hours or km, or 1–3,650 days. */
  maxServiceEveryTenths: 999_999,
  maxServiceEveryDays: 3650,
  maxQuantity: 100_000,
  /** Hire rates up to KES 10 million per unit (minor units). */
  maxHireRateMinor: 1_000_000_000,
  /** Days a usage log, fuel issue or move may be back-dated. */
  maxBackdateDays: 60,
  /** Fuel windows are listed for the last 180 days. */
  fuelLookbackDays: 180,
  /** Over-standard windows and static-meter fuellings of the last 30 days raise an alert. */
  fuelAlertDays: 30,
  /** Operator certificates expiring within 30 days are flagged. */
  certificateWarningDays: 30,
} as const;

/**
 * Who may read plant records on a project (on top of `projects.view`): the contractor's site,
 * project, stores and finance staff. Portal-only roles (client, supplier), consultants and
 * labourers hold none of these (decision D-90).
 */
export const PLANT_READ_PERMISSIONS = [
  "plant.manage",
  "site.diary",
  "projects.manage",
  "stores.manage",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];
/** Who records daily usage, breakdowns and services at a site. */
export const PLANT_RECORD_PERMISSIONS = [
  "plant.manage",
  "site.diary",
] as const satisfies readonly Permission[];
/** Who records fuel issued to plant (storekeepers usually hand out the diesel). */
export const PLANT_FUEL_PERMISSIONS = [
  "plant.manage",
  "site.diary",
  "stores.manage",
] as const satisfies readonly Permission[];
/** Who sees hire rates, suppliers' charges and the estimated hire charge. */
export const PLANT_COST_PERMISSIONS = [
  "plant.manage",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];
