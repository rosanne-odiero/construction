/**
 * Material catalogue, units, conversions, suppliers and price history (D5.1, brief §5.3,
 * ARCHITECTURE §4.4). The database CHECK constraints in migration
 * `20261115090000_procurement_catalogue` list the same values.
 */

/**
 * Unit dimensions. Units with a standard size (mass, length, area, volume, count) convert within
 * their dimension by exact factors. A lorry trip (`trip`) and packages (bag, roll, sheet…) have no
 * universal size (brief §15 G): they convert only through a material- or supplier-specific factor.
 */
export const UNIT_DIMENSIONS = [
  "mass",
  "length",
  "area",
  "volume",
  "count",
  "trip",
  "package",
] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

/** Dimensions whose units carry a standard size relative to the dimension's base unit. */
export const SIZED_DIMENSIONS = [
  "mass",
  "length",
  "area",
  "volume",
  "count",
] as const satisfies readonly UnitDimension[];
export type SizedDimension = (typeof SIZED_DIMENSIONS)[number];

/** Base unit per sized dimension. */
export const DIMENSION_BASE_UNITS: Readonly<Record<SizedDimension, string>> = {
  mass: "kg",
  length: "m",
  area: "m2",
  volume: "m3",
  count: "nr",
};

/**
 * Standard (system) units. Sizes live in packages/domain (`STANDARD_UNITS`); companies add their
 * own units (for example a 20-litre "debe") in the `units` table.
 */
export const STANDARD_UNIT_CODES = [
  "kg",
  "g",
  "t",
  "bag_50kg",
  "bag_25kg",
  "mm",
  "m",
  "ft",
  "m2",
  "m3",
  "l",
  "nr",
  "pair",
  "trip",
  "bag",
  "sheet",
  "roll",
  "bundle",
  "packet",
  "box",
  "drum",
  "tin",
  "set",
] as const;
export type StandardUnitCode = (typeof STANDARD_UNIT_CODES)[number];

export const isStandardUnitCode = (code: string): code is StandardUnitCode =>
  (STANDARD_UNIT_CODES as readonly string[]).includes(code);

/** Company unit codes: lower-case letters, digits and underscores, never a standard code. */
export const CUSTOM_UNIT_CODE_PATTERN = /^[a-z][a-z0-9_]{1,19}$/;

export const MATERIAL_CATEGORIES = [
  "cement",
  "aggregates",
  "blocks_stones",
  "steel",
  "brc_mesh",
  "timber",
  "roofing",
  "plumbing",
  "electrical",
  "finishes",
  "other",
] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

export const MATERIAL_STATUSES = ["active", "archived"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];
export const UNIT_STATUSES = MATERIAL_STATUSES;
export type UnitStatus = MaterialStatus;

/** Deformed high-yield bars sold in Kenya (Y8–Y32). */
export const STEEL_BAR_DIAMETERS_MM = [8, 10, 12, 16, 20, 25, 32] as const;
export type SteelBarDiameter = (typeof STEEL_BAR_DIAMETERS_MM)[number];
/** Standard bar length when a steel material does not state one. */
export const STEEL_STANDARD_BAR_LENGTH_M = "12";
/** Steel mass per metre: d² / 162 kg/m (d in mm), the site formula; see ARCHITECTURE §4.4. */
export const STEEL_MASS_DIVISOR = 162;

/** Roofing sheet gauges (higher is thinner). */
export const ROOFING_GAUGES = [24, 26, 28, 30, 32] as const;
export type RoofingGauge = (typeof ROOFING_GAUGES)[number];

/** Explicit conversions are per material, optionally narrowed to one supplier. */
export const CONVERSION_SCOPES = ["material", "supplier"] as const;
export type ConversionScope = (typeof CONVERSION_SCOPES)[number];

/** Where a conversion step came from, in resolution order (most specific first). */
export const CONVERSION_SOURCES = [
  "supplier",
  "material",
  "material_attribute",
  "standard",
] as const;
export type ConversionSource = (typeof CONVERSION_SOURCES)[number];

/** Rules derived from material attributes (standard formulas). */
export const DERIVED_CONVERSION_RULES = [
  "steel_mass_per_metre",
  "piece_length",
  "cover_width",
  "timber_section",
  "mesh_sheet_area",
  "mesh_roll_area",
] as const;
export type DerivedConversionRule = (typeof DERIVED_CONVERSION_RULES)[number];

/** Converted quantities are rounded once, half-up, to this many decimal places. */
export const CONVERSION_ROUNDING = { decimals: 6, mode: "half_up" } as const;

export const PRICE_SOURCES = ["manual", "quotation", "invoice"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** How a recorded price treats VAT (rate snapshot from `bq.vat.rate`, CR-TAX-01). */
export const VAT_TREATMENTS = ["inclusive", "exclusive", "not_applicable"] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/** Comparable prices (net of VAT, per base unit) keep this many decimal places of a minor unit. */
export const COMPARABLE_PRICE_DECIMALS = 6;
/** Price changes are reported to four decimal places of a percent (half-up). */
export const PRICE_CHANGE_DECIMALS = 4;
/** `materials.price_change_alert_pct` default (CONFIGURATION §5). */
export const DEFAULT_PRICE_CHANGE_ALERT_PERCENT = "10";

/** Price alert state: compared with the previous price, or why not. */
export const PRICE_ALERT_STATES = [
  "first_price",
  "within_threshold",
  "above_threshold",
  "not_comparable",
] as const;
export type PriceAlertState = (typeof PRICE_ALERT_STATES)[number];

export const SUPPLIER_STATUSES = ["active", "on_hold", "blocked"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

/** KRA eTIMS status as recorded by the company (not checked against KRA; CR-TAX-02). */
export const ETIMS_STATUSES = ["registered", "unknown", "not_registered"] as const;
export type EtimsStatus = (typeof ETIMS_STATUSES)[number];

export const MPESA_PAYOUT_KINDS = ["paybill", "till", "none"] as const;
export type MpesaPayoutKind = (typeof MPESA_PAYOUT_KINDS)[number];

/**
 * Payout-details versions (maker-checker, brief §5.7 and §15 D): a proposal is `pending` until a
 * different person verifies it; a newer proposal supersedes the current version (verified or
 * not), so changed details are never usable until verified again.
 */
export const PAYOUT_STATUSES = ["pending", "verified", "rejected", "superseded"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_VERIFICATION_METHODS = [
  "call_back_known_number",
  "in_person_documents",
  "bank_confirmation_letter",
  "other",
] as const;
export type PayoutVerificationMethod = (typeof PAYOUT_VERIFICATION_METHODS)[number];

/** Sensitive supplier values that can be revealed (separately permissioned and audited). */
export const SUPPLIER_REVEAL_FIELDS = ["kraPin", "contactPhone", "accountNumber"] as const;
export type SupplierRevealField = (typeof SUPPLIER_REVEAL_FIELDS)[number];

/**
 * Someone who changed a supplier contact's phone within this many days before a payout proposal
 * (or while it is pending) counts as a contributor and cannot verify it (call-back fraud, A-25).
 */
export const PAYOUT_CONTACT_CHANGE_WINDOW_DAYS = 30;

export const PROCUREMENT_LIMITS = {
  contactsPerSupplier: 5,
  /** Company units (active and archived) per tenant; keeps conversion searches small. */
  customUnitsPerTenant: 200,
  /** Largest quantity accepted by conversions and conversion factors. */
  maxQuantity: "1000000000000",
  quantityDecimals: 6,
  /** Largest unit price in KES minor units (KES 10 billion). */
  maxUnitPriceMinor: 1_000_000_000_000,
  maxCreditLimitMinor: 1_000_000_000_000_000,
  maxCreditDays: 365,
  /** Longest conversion path (steps) the resolver will build. */
  maxConversionSteps: 8,
  pageSize: 50,
  priceHistoryShown: 200,
  /** Reveals per user per ten minutes. */
  revealsPerWindow: 20,
  revealWindowSeconds: 600,
  /** Exact-match lookups (KRA PIN or phone) per user per ten minutes. */
  lookupsPerWindow: 30,
} as const;
