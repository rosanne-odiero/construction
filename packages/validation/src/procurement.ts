import {
  checkQuantity,
  isSteelBarDiameter,
  normaliseAccountNumber,
  normaliseKraPin,
} from "@pm-buddy/domain";
import {
  CONVERSION_SOURCES,
  DERIVED_CONVERSION_RULES,
  ETIMS_STATUSES,
  MATERIAL_CATEGORIES,
  MATERIAL_STATUSES,
  MPESA_PAYOUT_KINDS,
  PAYOUT_STATUSES,
  PAYOUT_VERIFICATION_METHODS,
  PRICE_ALERT_STATES,
  PRICE_SOURCES,
  PROCUREMENT_LIMITS,
  ROOFING_GAUGES,
  SUPPLIER_REVEAL_FIELDS,
  SUPPLIER_STATUSES,
  UNIT_DIMENSIONS,
  UNIT_STATUSES,
  VAT_TREATMENTS,
  type MaterialCategory,
} from "@pm-buddy/types";
import { z } from "zod";
import { pageInfoSchema } from "./api.js";
import { kenyanPhoneSchema } from "./primitives.js";

/**
 * D5.1 contracts: material catalogue, units and conversions, price history and alerts, suppliers
 * with masked identifiers and maker-checker payout details. Requests are strict (a body never
 * carries a tenant, maker or verifier) and responses are strict. Money is KES minor units;
 * quantities and factors are decimal strings; converted values are rounded half-up to six places.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });

function printable(value: string, multiline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (multiline && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
/** Characters as PostgreSQL's char_length counts them (code points), like Zod 4's min/max. */
const characters = (value: string) => [...value].length;
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters");
/** Optional text: an empty string is stored as null. */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();

/** A standard or company unit code (`kg`, `bag_50kg`, `m2`, `debe`). */
export const unitCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, "invalid_unit");
/** A company unit code: 2–20 characters, never a standard code (checked by the API). */
export const customUnitCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{1,19}$/, "invalid_unit_code");

/** A non-negative quantity: up to six decimals and at most 10¹² (refusals from packages/domain). */
export const quantitySchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const refusal = checkQuantity(value);
    if (refusal) ctx.addIssue({ code: "custom", message: refusal.replaceAll("-", "_") });
  });
export const positiveQuantitySchema = quantitySchema.refine(
  (value) => /[1-9]/.test(value),
  "quantity_not_positive",
);

/** A positive length in metres (or mm for timber sections): up to four decimals, at most 100,000. */
const lengthSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,4})?$/, "invalid_length")
  .refine((value) => /[1-9]/.test(value), "invalid_length");

/** A percentage with up to four decimals, above 0 and at most 1,000. */
export const thresholdPercentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, "invalid_percent")
  .refine((value) => Number(value) > 0 && Number(value) <= 1000, "invalid_percent");

export const materialCategorySchema = z.enum(MATERIAL_CATEGORIES);
export const materialStatusSchema = z.enum(MATERIAL_STATUSES);

export const materialAttributesSchema = z.strictObject({
  diameterMm: z.number().int().refine(isSteelBarDiameter, "invalid_bar_diameter").optional(),
  pieceLengthM: lengthSchema.optional(),
  gauge: z
    .number()
    .int()
    .refine((value) => (ROOFING_GAUGES as readonly number[]).includes(value), "invalid_gauge")
    .optional(),
  coverWidthM: lengthSchema.optional(),
  sectionWidthMm: lengthSchema.optional(),
  sectionDepthMm: lengthSchema.optional(),
  meshType: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{1,2}\d{2,4}$/, "invalid_mesh_type")
    .optional(),
  sheetWidthM: lengthSchema.optional(),
  sheetLengthM: lengthSchema.optional(),
  rollLengthM: lengthSchema.optional(),
});
export type MaterialAttributesInput = z.infer<typeof materialAttributesSchema>;

/** Which attributes each category may carry (others are refused, so nothing is silently ignored). */
export const CATEGORY_ATTRIBUTES: Readonly<
  Record<MaterialCategory, readonly (keyof MaterialAttributesInput)[]>
> = {
  cement: [],
  aggregates: [],
  blocks_stones: [],
  steel: ["diameterMm", "pieceLengthM"],
  brc_mesh: ["meshType", "sheetWidthM", "sheetLengthM", "rollLengthM"],
  timber: ["sectionWidthMm", "sectionDepthMm", "pieceLengthM"],
  roofing: ["gauge", "pieceLengthM", "coverWidthM"],
  plumbing: ["pieceLengthM"],
  electrical: ["pieceLengthM"],
  finishes: [],
  other: ["pieceLengthM"],
};

export function attributeIssues(
  category: MaterialCategory,
  attributes: MaterialAttributesInput,
): string[] {
  const allowed = CATEGORY_ATTRIBUTES[category];
  return Object.entries(attributes)
    .filter(([key, value]) => value !== undefined && !allowed.includes(key as never))
    .map(([key]) => key);
}

const materialFields = {
  name: text(2, 150),
  nameSw: optionalText(150).optional(),
  category: materialCategorySchema,
  baseUnit: unitCodeSchema,
  spec: optionalText(200).optional(),
  attributes: materialAttributesSchema.default({}),
  notes: optionalText(2000, true).optional(),
};

const checkAttributes = (
  value: { category?: MaterialCategory; attributes?: MaterialAttributesInput },
  ctx: z.RefinementCtx,
) => {
  if (!value.category || !value.attributes) return;
  for (const key of attributeIssues(value.category, value.attributes))
    ctx.addIssue({ code: "custom", path: ["attributes", key], message: "attribute_not_allowed" });
};

export const createMaterialRequestSchema = z
  .strictObject(materialFields)
  .superRefine(checkAttributes);
export const updateMaterialRequestSchema = z
  .strictObject({
    version,
    name: materialFields.name.optional(),
    nameSw: materialFields.nameSw,
    category: materialCategorySchema.optional(),
    baseUnit: unitCodeSchema.optional(),
    spec: materialFields.spec,
    attributes: materialAttributesSchema.optional(),
    notes: materialFields.notes,
    status: materialStatusSchema.optional(),
  })
  .superRefine(checkAttributes);
export type CreateMaterialRequest = z.infer<typeof createMaterialRequestSchema>;
export type UpdateMaterialRequest = z.infer<typeof updateMaterialRequestSchema>;

export const materialListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  category: materialCategorySchema.optional(),
  status: materialStatusSchema.optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(PROCUREMENT_LIMITS.pageSize),
});
export type MaterialListQuery = z.infer<typeof materialListQuerySchema>;

const supplierRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });
const materialRef = z.strictObject({ id: uuid, code: z.string(), name: z.string() });

export const priceAlertStateSchema = z.enum(PRICE_ALERT_STATES);

export const materialSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  nameSw: z.string().nullable(),
  category: materialCategorySchema,
  baseUnit: z.string(),
  spec: z.string().nullable(),
  attributes: materialAttributesSchema,
  notes: z.string().nullable(),
  status: materialStatusSchema,
  /** The newest effective price from any supplier (null before the first one). */
  latestPrice: z
    .strictObject({
      id: uuid,
      supplier: supplierRef,
      unit: z.string(),
      unitPriceMinor: z.number().int(),
      vatTreatment: z.enum(VAT_TREATMENTS),
      effectiveOn: calendarDate,
      alertState: priceAlertStateSchema,
    })
    .nullable(),
  /** Prices above the change threshold that have not been corrected. */
  alertCount: z.number().int().min(0),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Material = z.infer<typeof materialSchema>;

const permissionsSchema = z.strictObject({ canManage: z.boolean() });

export const materialsResponseSchema = z.strictObject({
  materials: z.array(materialSchema),
  page: pageInfoSchema,
  permissions: permissionsSchema,
});
export const materialResponseSchema = z.strictObject({ material: materialSchema });
export type MaterialsResponse = z.infer<typeof materialsResponseSchema>;

export const conversionStepSchema = z.strictObject({
  from: z.string(),
  to: z.string(),
  ratio: z.string().regex(/^\d+\/\d+$/),
  factor: z.string(),
  source: z.enum(CONVERSION_SOURCES),
  conversionId: uuid.nullable(),
  rule: z.enum(DERIVED_CONVERSION_RULES).nullable(),
});
export type ConversionStepWire = z.infer<typeof conversionStepSchema>;

export const conversionSchema = z.strictObject({
  id: uuid,
  materialId: uuid,
  supplier: supplierRef.nullable(),
  fromUnit: z.string(),
  fromQuantity: z.string(),
  toUnit: z.string(),
  toQuantity: z.string(),
  /** 1 fromUnit = factor × toUnit, rounded to 12 places for display; `ratio` is exact. */
  factor: z.string(),
  ratio: z.string().regex(/^\d+\/\d+$/),
  effectiveFrom: calendarDate,
  effectiveTo: calendarDate.nullable(),
  note: z.string().nullable(),
  inForce: z.boolean(),
  createdAt: timestamp,
  createdBy: person,
  endedAt: timestamp.nullable(),
  endedBy: person.nullable(),
});
export type Conversion = z.infer<typeof conversionSchema>;

export const derivedFactorSchema = z.strictObject({
  from: z.string(),
  to: z.string(),
  factor: z.string(),
  ratio: z.string(),
  rule: z.enum(DERIVED_CONVERSION_RULES),
});

export const createConversionRequestSchema = z.strictObject({
  supplierId: uuid.nullable().default(null),
  fromUnit: unitCodeSchema,
  fromQuantity: positiveQuantitySchema,
  toUnit: unitCodeSchema,
  toQuantity: positiveQuantitySchema,
  /** Defaults to today (Africa/Nairobi). */
  effectiveFrom: calendarDate.optional(),
  note: optionalText(300).optional(),
});
export type CreateConversionRequest = z.infer<typeof createConversionRequestSchema>;
export const endConversionRequestSchema = z.strictObject({ effectiveTo: calendarDate });
export const conversionResponseSchema = z.strictObject({ conversion: conversionSchema });

export const priceSchema = z.strictObject({
  id: uuid,
  material: materialRef,
  supplier: supplierRef,
  unit: z.string(),
  unitPriceMinor: z.number().int().positive(),
  currency: z.literal("KES"),
  vatTreatment: z.enum(VAT_TREATMENTS),
  vatRatePercent: z.string().nullable(),
  netUnitPriceMinor: z.number().int().positive(),
  grossUnitPriceMinor: z.number().int().positive(),
  effectiveOn: calendarDate,
  source: z.enum(PRICE_SOURCES),
  sourceReference: z.string().nullable(),
  note: z.string().nullable(),
  /** Net price per base unit (minor units, six decimals) and the conversion used. */
  comparable: z
    .strictObject({
      unit: z.string(),
      unitPriceMinor: z.string(),
      steps: z.array(conversionStepSchema),
    })
    .nullable(),
  change: z.strictObject({ previousPriceId: uuid, percent: z.string() }).nullable(),
  alertState: priceAlertStateSchema,
  alertThresholdPercent: z.string(),
  correctsPriceId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  /** The price that corrected this one, if any (a corrected price no longer counts). */
  correctedById: uuid.nullable(),
  recordedAt: timestamp,
  recordedBy: person,
});
export type Price = z.infer<typeof priceSchema>;

const priceFields = {
  supplierId: uuid,
  unit: unitCodeSchema,
  unitPriceMinor: z.number().int().min(1).max(PROCUREMENT_LIMITS.maxUnitPriceMinor),
  vatTreatment: z.enum(VAT_TREATMENTS),
  effectiveOn: calendarDate,
  sourceReference: optionalText(100).optional(),
  note: optionalText(500).optional(),
};
export const recordPriceRequestSchema = z.strictObject(priceFields);
export const correctPriceRequestSchema = z.strictObject({ ...priceFields, reason: text(3, 500) });
export type RecordPriceRequest = z.infer<typeof recordPriceRequestSchema>;
export type CorrectPriceRequest = z.infer<typeof correctPriceRequestSchema>;
export const priceResponseSchema = z.strictObject({ price: priceSchema });

export const materialDetailResponseSchema = z.strictObject({
  material: materialSchema,
  conversions: z.array(conversionSchema),
  standardConversions: z.array(derivedFactorSchema),
  prices: z.array(priceSchema),
  suppliers: z.array(supplierRef),
  priceChangeAlertPercent: z.string(),
  /** The configured VAT rate for new prices (`bq.vat.rate`, COMPLIANCE-REVIEW CR-TAX-01). */
  vatRatePercent: z.string(),
  permissions: permissionsSchema,
});
export type MaterialDetailResponse = z.infer<typeof materialDetailResponseSchema>;

export const priceAlertsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(PROCUREMENT_LIMITS.pageSize),
});
export const priceAlertsResponseSchema = z.strictObject({
  alerts: z.array(priceSchema),
  page: pageInfoSchema,
  priceChangeAlertPercent: z.string(),
});
export type PriceAlertsResponse = z.infer<typeof priceAlertsResponseSchema>;

export const convertQuerySchema = z.strictObject({
  materialId: uuid.optional(),
  supplierId: uuid.optional(),
  from: unitCodeSchema,
  to: unitCodeSchema,
  /** Checked by packages/domain (422 with the refusal code), so refusals are explained. */
  quantity: z.string().trim().min(1).max(40),
  on: calendarDate.optional(),
});
export type ConvertQuery = z.infer<typeof convertQuerySchema>;
export const conversionResultResponseSchema = z.strictObject({
  result: z.strictObject({
    input: z.string(),
    from: z.string(),
    to: z.string(),
    quantity: z.string(),
    exact: z.boolean(),
    factor: z.string(),
    ratio: z.string(),
    on: calendarDate,
    steps: z.array(conversionStepSchema),
  }),
});
export type ConversionResultResponse = z.infer<typeof conversionResultResponseSchema>;

export const unitSchema = z.strictObject({
  /** Null for standard units. */
  id: uuid.nullable(),
  code: z.string(),
  dimension: z.enum(UNIT_DIMENSIONS),
  standard: z.boolean(),
  /** Company units only (standard units are named by the EN/SW catalogues). */
  name: z.string().nullable(),
  nameSw: z.string().nullable(),
  equalsQuantity: z.string().nullable(),
  equalsUnit: z.string().nullable(),
  /** Size in the dimension's base unit (12 places), null for trips and packages. */
  sizeInBase: z.string().nullable(),
  baseUnit: z.string().nullable(),
  status: z.enum(UNIT_STATUSES),
  version: z.number().int().min(0),
});
export type UnitWire = z.infer<typeof unitSchema>;
export const unitsResponseSchema = z.strictObject({
  units: z.array(unitSchema),
  permissions: permissionsSchema,
});
export type UnitsResponse = z.infer<typeof unitsResponseSchema>;
export const createUnitRequestSchema = z.strictObject({
  code: customUnitCodeSchema,
  name: text(2, 60),
  nameSw: optionalText(60).optional(),
  dimension: z.enum(UNIT_DIMENSIONS),
  equalsQuantity: positiveQuantitySchema.nullable().default(null),
  equalsUnit: unitCodeSchema.nullable().default(null),
});
export type CreateUnitRequest = z.infer<typeof createUnitRequestSchema>;
export const updateUnitRequestSchema = z.strictObject({
  version,
  status: z.enum(UNIT_STATUSES),
});
export const unitResponseSchema = z.strictObject({ unit: unitSchema });

export const loadDefaultsResponseSchema = z.strictObject({
  created: z.number().int().min(0),
  existing: z.number().int().min(0),
  conversions: z.number().int().min(0),
});

/** A tolerance percentage: 0–100 with up to four decimals (D5.2 three-way match). */
export const tolerancePercentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, "invalid_percent")
  .refine((value) => Number(value) <= 100, "invalid_percent");

export const procurementSettingsSchema = z.strictObject({
  priceChangeAlertPercent: z.string(),
  /** `procurement.min_quotes` (D5.2): complete quotations an RFQ needs before an award. */
  minQuotes: z.number().int().min(1).max(10),
  /** `procurement.three_way_match.qty_tolerance_pct` / `.price_tolerance_pct` (D5.2). */
  qtyTolerancePercent: z.string(),
  priceTolerancePercent: z.string(),
  /** `procurement.block_payment_without_etims` (D5.2, CR-TAX-02). */
  blockPaymentWithoutEtims: z.boolean(),
  /** 0 until the company saves its own value (the default applies). */
  version: z.number().int().min(0),
  updatedAt: timestamp.nullable(),
  updatedBy: person.nullable(),
});
export const procurementSettingsResponseSchema = z.strictObject({
  settings: procurementSettingsSchema,
  permissions: permissionsSchema,
});
export type ProcurementSettingsResponse = z.infer<typeof procurementSettingsResponseSchema>;
export const updateProcurementSettingsRequestSchema = z.strictObject({
  priceChangeAlertPercent: thresholdPercentSchema,
  /** D5.2 settings; omitted ones keep their current value. */
  minQuotes: z.number().int().min(1).max(10).optional(),
  qtyTolerancePercent: tolerancePercentSchema.optional(),
  priceTolerancePercent: tolerancePercentSchema.optional(),
  blockPaymentWithoutEtims: z.boolean().optional(),
  version: z.number().int().min(0).max(2_147_483_647),
});
export type UpdateProcurementSettingsRequest = z.infer<
  typeof updateProcurementSettingsRequestSchema
>;

// Suppliers -------------------------------------------------------------------------------------

/** A KRA PIN in any common spelling, stored upper-case without spaces (A/P + 9 digits + letter). */
export const kraPinSchema = z.string().transform((value, ctx) => {
  const pin = normaliseKraPin(value);
  if (!pin) {
    ctx.addIssue({ code: "custom", message: "invalid_kra_pin" });
    return z.NEVER;
  }
  return pin;
});

export const supplierStatusSchema = z.enum(SUPPLIER_STATUSES);
export const etimsStatusSchema = z.enum(ETIMS_STATUSES);
export const payoutStatusSchema = z.enum(PAYOUT_STATUSES);

const email = z
  .union([z.literal(""), z.email().max(254)])
  .transform((value) => (value === "" ? null : value.toLowerCase()))
  .nullable();

const contactInput = {
  name: text(2, 100),
  role: optionalText(60).optional(),
  email: email.optional(),
  primary: z.boolean().default(false),
};
const checkContacts = (
  contacts: { primary: boolean; id?: string }[] | undefined,
  ctx: z.RefinementCtx,
) => {
  if (!contacts) return;
  if (contacts.filter((contact) => contact.primary).length > 1)
    ctx.addIssue({ code: "custom", path: ["contacts"], message: "one_primary_contact" });
  const ids = contacts.map((contact) => contact.id).filter(Boolean);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: "custom", path: ["contacts"], message: "duplicate_contact" });
};

/** A new contact; the phone is a Kenyan mobile (normalised to 2547…/2541…). */
export const createContactSchema = z.strictObject({
  ...contactInput,
  phone: kenyanPhoneSchema.nullable().optional(),
});
/**
 * A contact in an update: `id` names an existing contact. Its `phone` is kept when omitted
 * (the client only ever sees it masked), cleared with null, or replaced.
 */
export const updateContactSchema = z.strictObject({
  id: uuid.optional(),
  ...contactInput,
  phone: kenyanPhoneSchema.nullable().optional(),
});

const supplierFields = {
  legalName: text(2, 200),
  tradingName: optionalText(200).optional(),
  kraPin: kraPinSchema.nullable().optional(),
  etimsStatus: etimsStatusSchema.default("unknown"),
  etimsCheckedOn: calendarDate.nullable().optional(),
  creditDays: z.number().int().min(0).max(PROCUREMENT_LIMITS.maxCreditDays).default(0),
  creditLimitMinor: z
    .number()
    .int()
    .min(0)
    .max(PROCUREMENT_LIMITS.maxCreditLimitMinor)
    .nullable()
    .optional(),
  notes: optionalText(2000, true).optional(),
};

const reasonFor = (
  value: { status?: string; statusReason?: string | null },
  ctx: z.RefinementCtx,
) => {
  if (value.status && value.status !== "active" && !value.statusReason)
    ctx.addIssue({ code: "custom", path: ["statusReason"], message: "reason_required" });
};

export const createSupplierRequestSchema = z
  .strictObject({
    ...supplierFields,
    contacts: z.array(createContactSchema).max(PROCUREMENT_LIMITS.contactsPerSupplier).default([]),
  })
  .superRefine((value, ctx) => checkContacts(value.contacts, ctx));
export type CreateSupplierRequest = z.infer<typeof createSupplierRequestSchema>;

export const updateSupplierRequestSchema = z
  .strictObject({
    version,
    legalName: supplierFields.legalName.optional(),
    tradingName: supplierFields.tradingName,
    kraPin: supplierFields.kraPin,
    etimsStatus: etimsStatusSchema.optional(),
    etimsCheckedOn: supplierFields.etimsCheckedOn,
    creditDays: z.number().int().min(0).max(PROCUREMENT_LIMITS.maxCreditDays).optional(),
    creditLimitMinor: supplierFields.creditLimitMinor,
    notes: supplierFields.notes,
    status: supplierStatusSchema.optional(),
    statusReason: optionalText(500)
      .refine((value) => value === null || characters(value) >= 3, "too_short")
      .optional(),
    contacts: z.array(updateContactSchema).max(PROCUREMENT_LIMITS.contactsPerSupplier).optional(),
  })
  .superRefine((value, ctx) => {
    checkContacts(value.contacts, ctx);
    reasonFor(value, ctx);
  });
export type UpdateSupplierRequest = z.infer<typeof updateSupplierRequestSchema>;

export const supplierListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: supplierStatusSchema.optional(),
  etims: etimsStatusSchema.optional(),
  /** Exact-match lookups through blind indexes (rate-limited). */
  kraPin: kraPinSchema.optional(),
  phone: kenyanPhoneSchema.optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(PROCUREMENT_LIMITS.pageSize),
});
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

const shortcode = z
  .string()
  .trim()
  .regex(/^\d{5,7}$/, "invalid_shortcode");
const accountReference = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,19}$/, "invalid_account_reference");

export const bankDetailsInputSchema = z.strictObject({
  bankName: text(2, 100),
  branch: optionalText(100).optional(),
  accountName: text(2, 150),
  accountNumber: z.string().transform((value, ctx) => {
    const account = normaliseAccountNumber(value);
    if (!account) {
      ctx.addIssue({ code: "custom", message: "invalid_account_number" });
      return z.NEVER;
    }
    return account;
  }),
});

/**
 * Proposes new payout details: M-Pesa (Paybill number and account reference, or Till number)
 * and/or a bank account. `replaces` is the current version the user saw (null when none), so two
 * people cannot overwrite each other's proposal unknowingly.
 */
export const proposePayoutRequestSchema = z
  .strictObject({
    replaces: uuid.nullable(),
    mpesaKind: z.enum(MPESA_PAYOUT_KINDS),
    paybillNumber: shortcode.nullable().default(null),
    accountReference: accountReference.nullable().default(null),
    tillNumber: shortcode.nullable().default(null),
    bank: bankDetailsInputSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.mpesaKind === "paybill") {
      if (!value.paybillNumber) issue("paybillNumber", "required");
      if (!value.accountReference) issue("accountReference", "required");
      if (value.tillNumber) issue("tillNumber", "not_allowed");
    } else if (value.mpesaKind === "till") {
      if (!value.tillNumber) issue("tillNumber", "required");
      if (value.paybillNumber) issue("paybillNumber", "not_allowed");
      if (value.accountReference) issue("accountReference", "not_allowed");
    } else {
      for (const key of ["paybillNumber", "accountReference", "tillNumber"] as const)
        if (value[key]) issue(key, "not_allowed");
      if (!value.bank) issue("bank", "payout_channel_required");
    }
  });
export type ProposePayoutRequest = z.infer<typeof proposePayoutRequestSchema>;

export const verifyPayoutRequestSchema = z.strictObject({
  method: z.enum(PAYOUT_VERIFICATION_METHODS),
  note: text(3, 500),
});
export const rejectPayoutRequestSchema = z.strictObject({ reason: text(3, 500) });

export const supplierRevealRequestSchema = z
  .strictObject({
    field: z.enum(SUPPLIER_REVEAL_FIELDS),
    contactId: uuid.optional(),
    payoutId: uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.field === "contactPhone" && !value.contactId)
      ctx.addIssue({ code: "custom", path: ["contactId"], message: "required" });
    if (value.field === "accountNumber" && !value.payoutId)
      ctx.addIssue({ code: "custom", path: ["payoutId"], message: "required" });
  });
export type SupplierRevealRequest = z.infer<typeof supplierRevealRequestSchema>;
export const supplierRevealResponseSchema = z.strictObject({
  field: z.enum(SUPPLIER_REVEAL_FIELDS),
  value: z.string(),
});

export const supplierSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  legalName: z.string(),
  tradingName: z.string().nullable(),
  /** Masked (P•••••••67Q); the full PIN needs a reveal. */
  kraPinMasked: z.string().nullable(),
  etimsStatus: etimsStatusSchema,
  etimsCheckedOn: calendarDate.nullable(),
  status: supplierStatusSchema,
  statusReason: z.string().nullable(),
  creditDays: z.number().int(),
  creditLimitMinor: z.number().int().nullable(),
  primaryContact: z
    .strictObject({
      name: z.string(),
      phoneMasked: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  payout: z.strictObject({
    /** `none` when no payout details are on file. */
    status: z.enum(["none", "pending", "verified"]),
    usableForPayment: z.boolean(),
    mpesaKind: z.enum(MPESA_PAYOUT_KINDS),
    hasBank: z.boolean(),
  }),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Supplier = z.infer<typeof supplierSchema>;

export const supplierContactSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  role: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  email: z.string().nullable(),
  primary: z.boolean(),
  phoneChangedAt: timestamp.nullable(),
});
export type SupplierContact = z.infer<typeof supplierContactSchema>;

export const payoutVersionSchema = z.strictObject({
  id: uuid,
  versionNo: z.number().int().min(1),
  status: payoutStatusSchema,
  mpesaKind: z.enum(MPESA_PAYOUT_KINDS),
  paybillNumber: z.string().nullable(),
  accountReference: z.string().nullable(),
  tillNumber: z.string().nullable(),
  bank: z
    .strictObject({
      bankName: z.string(),
      branch: z.string().nullable(),
      accountName: z.string(),
      accountNumberMasked: z.string(),
    })
    .nullable(),
  proposedAt: timestamp,
  proposedBy: person,
  /** Everyone who made or contributed to this version (none of them may verify it). */
  contributors: z.array(person),
  verifiedAt: timestamp.nullable(),
  verifiedBy: person.nullable(),
  verificationMethod: z.enum(PAYOUT_VERIFICATION_METHODS).nullable(),
  verificationNote: z.string().nullable(),
  rejectedAt: timestamp.nullable(),
  rejectedBy: person.nullable(),
  rejectionReason: z.string().nullable(),
  supersededAt: timestamp.nullable(),
  /** Only a verified version is usable; D5.2 payments bind to its ID. */
  usableForPayment: z.boolean(),
  /** A contact phone changed within 30 days before the proposal or while it was pending. */
  contactChangeWarning: z.boolean(),
  /** The caller may verify or reject it (permission, pending, not a contributor). */
  canDecide: z.boolean(),
});
export type PayoutVersion = z.infer<typeof payoutVersionSchema>;

export const supplierDetailResponseSchema = z.strictObject({
  supplier: supplierSchema.extend({ notes: z.string().nullable() }),
  contacts: z.array(supplierContactSchema),
  payout: z.strictObject({
    current: payoutVersionSchema.nullable(),
    history: z.array(payoutVersionSchema),
  }),
  prices: z.array(priceSchema),
  permissions: z.strictObject({
    canManage: z.boolean(),
    canRevealIdentifiers: z.boolean(),
    canRevealBank: z.boolean(),
    canVerifyPayout: z.boolean(),
  }),
});
export type SupplierDetailResponse = z.infer<typeof supplierDetailResponseSchema>;

export const suppliersResponseSchema = z.strictObject({
  suppliers: z.array(supplierSchema),
  page: pageInfoSchema,
  permissions: permissionsSchema,
});
export type SuppliersResponse = z.infer<typeof suppliersResponseSchema>;
export const supplierResponseSchema = z.strictObject({ supplier: supplierSchema });
