import { formatHundredths, formatTenths, parseHundredths, parseTenths } from "@pm-buddy/domain";
import {
  BREAKDOWN_RESOLUTIONS,
  BREAKDOWN_SEVERITIES,
  BREAKDOWN_STATUSES,
  FUEL_SOURCES,
  FUEL_TYPES,
  FUEL_WINDOW_STATES,
  HIRE_RATE_UNITS,
  METER_RESET_REASONS,
  METER_TYPES,
  OPERATOR_CERTIFICATE_STATES,
  OPERATOR_KINDS,
  PLANT_ALERT_KINDS,
  PLANT_ALERT_SEVERITIES,
  PLANT_CATEGORIES,
  PLANT_CLOSE_ACTIONS,
  PLANT_LIMITS,
  PLANT_OWNERSHIPS,
  PLANT_RECORD_STATES,
  PLANT_SETTINGS_LIMITS,
  PLANT_STATUSES,
  SERVICE_KINDS,
  SERVICE_RECORD_STATUSES,
  SERVICE_STATES,
  USAGE_DAY_STATUSES,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Plant and equipment (D8.3): the company register (owned and hired plant), moves between sites,
 * operators, daily usage with meter readings, fuel issues with the fuel variance, meter resets,
 * breakdowns and services, and the company settings. Requests are strict (a body never carries a
 * tenant ID); responses are strict so the web never trusts an unexpected shape. Meter readings,
 * hours, kilometres and litres travel as decimal strings with one decimal place ("1234.5"), the
 * standard consumption with two ("14.00"); money is KES minor units; dates are Nairobi business
 * dates (YYYY-MM-DD). Hire rates and estimates are null for callers without a cost permission.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const count = z.number().int().min(0);

const characters = (value: string) => Array.from(value).length;
const printable = (value: string, multiline: boolean) =>
  Array.from(value).every((char) => {
    const code = char.codePointAt(0)!;
    if (multiline && (code === 9 || code === 10 || code === 13)) return true;
    return code >= 32 && !(code >= 127 && code <= 159);
  });
const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) >= min && characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters");
/** Optional text: an empty string is stored as null. */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .refine((value) => characters(value) <= max, "length")
    .refine((value) => printable(value, multiline), "control_characters")
    .transform((value) => (value === "" ? null : value))
    .nullable();
const reason = text(3, 500, true);
const search = z.string().trim().max(100).optional();
const offsetCursor = z.coerce.number().int().min(0).max(100_000).optional();
const limit = z.coerce.number().int().min(1).max(PLANT_LIMITS.maxPageSize).default(30);

/** A decimal string with at most one decimal place, normalised to exactly one ("12" → "12.0"). */
const tenths = (min: number, max: number) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      const parsed = parseTenths(value, max);
      if (parsed === null || parsed < min) {
        ctx.addIssue({ code: "custom", message: "invalid_quantity" });
        return z.NEVER;
      }
      return formatTenths(parsed);
    });
/** A meter reading: 0.0–9,999,999.9. */
export const meterReadingSchema = tenths(0, PLANT_LIMITS.maxReadingTenths);
/** Litres issued at once: 0.1–2,000.0. */
export const litresSchema = tenths(1, PLANT_LIMITS.maxLitresTenths);
/** Litres per hour or km: 0.01–999.99, normalised to two decimals. */
export const standardConsumptionSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const parsed = parseHundredths(value, PLANT_LIMITS.maxStandardHundredths);
    if (parsed === null || parsed < 1) {
      ctx.addIssue({ code: "custom", message: "invalid_quantity" });
      return z.NEVER;
    }
    return formatHundredths(parsed);
  });
const serviceEvery = tenths(1, PLANT_LIMITS.maxServiceEveryTenths);
/** Response decimals (readings may be negative only as a remaining-to-service figure). */
const decimal1 = z.string().regex(/^-?\d+\.\d$/);
const decimal2 = z.string().regex(/^-?\d+\.\d{2}$/);
const plantCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, "invalid_plant_code");

export const plantCategorySchema = z.enum(PLANT_CATEGORIES);
export const plantStatusSchema = z.enum(PLANT_STATUSES);
export const plantAlertKindSchema = z.enum(PLANT_ALERT_KINDS);

// Settings --------------------------------------------------------------------------------------

const between = (limits: { min: number; max: number }) =>
  z.number().int().min(limits.min).max(limits.max);
const settingsValues = {
  fuelVariancePercent: between(PLANT_SETTINGS_LIMITS.fuelVariancePercent),
  fuelMinHours: between(PLANT_SETTINGS_LIMITS.fuelMinHours),
  fuelMinKm: between(PLANT_SETTINGS_LIMITS.fuelMinKm),
  idleHireDays: between(PLANT_SETTINGS_LIMITS.idleHireDays),
  hireEndingDays: between(PLANT_SETTINGS_LIMITS.hireEndingDays),
  serviceDueSoonPercent: between(PLANT_SETTINGS_LIMITS.serviceDueSoonPercent),
  certificateCategories: z
    .array(plantCategorySchema)
    .max(PLANT_CATEGORIES.length)
    .refine((values) => new Set(values).size === values.length, "duplicate_category"),
};
export const updatePlantSettingsRequestSchema = z.strictObject({
  ...settingsValues,
  /** The version read (0 while the company uses the defaults). */
  version: z.number().int().min(0),
});
export const plantSettingsSchema = z.strictObject({
  ...settingsValues,
  version: z.number().int().min(0),
  updatedAt: timestamp.nullable(),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export const plantSettingsResponseSchema = z.strictObject({ settings: plantSettingsSchema });

// Register --------------------------------------------------------------------------------------

const hireFields = {
  supplierId: uuid.nullable().optional(),
  lpoId: uuid.nullable().optional(),
  hireRateMinor: z.number().int().min(1).max(PLANT_LIMITS.maxHireRateMinor).nullable().optional(),
  hireRateUnit: z.enum(HIRE_RATE_UNITS).nullable().optional(),
  hireStartOn: planningDateSchema.nullable().optional(),
  hireEndOn: planningDateSchema.nullable().optional(),
};
const editableFields = {
  name: text(2, 120),
  category: plantCategorySchema,
  makeModel: optionalText(120).optional(),
  registration: optionalText(30).optional(),
  quantity: z.number().int().min(1).max(PLANT_LIMITS.maxQuantity).default(1),
  standardConsumption: standardConsumptionSchema.nullable().optional(),
  serviceEvery: serviceEvery.nullable().optional(),
  serviceEveryDays: z
    .number()
    .int()
    .min(1)
    .max(PLANT_LIMITS.maxServiceEveryDays)
    .nullable()
    .optional(),
  notes: optionalText(1000, true).optional(),
  ...hireFields,
};

type HireShape = {
  supplierId?: string | null | undefined;
  lpoId?: string | null | undefined;
  hireRateMinor?: number | null | undefined;
  hireRateUnit?: string | null | undefined;
  hireStartOn?: string | null | undefined;
  hireEndOn?: string | null | undefined;
};
/** The hire terms the ownership needs (the database CHECK repeats it). */
export function hireIssues(ownership: string, value: HireShape, meterType: string): string[] {
  const issues: string[] = [];
  if (ownership === "hired") {
    if (!value.supplierId) issues.push("supplierId");
    if (!value.hireRateMinor) issues.push("hireRateMinor");
    if (!value.hireRateUnit) issues.push("hireRateUnit");
    if (!value.hireStartOn) issues.push("hireStartOn");
    if (value.hireStartOn && value.hireEndOn && value.hireEndOn < value.hireStartOn)
      issues.push("hireEndOn");
    if (value.hireRateUnit === "hour" && meterType !== "hours") issues.push("hireRateUnit");
  } else {
    for (const key of [
      "supplierId",
      "lpoId",
      "hireRateMinor",
      "hireRateUnit",
      "hireStartOn",
      "hireEndOn",
    ] as const)
      if (value[key]) issues.push(key);
  }
  return issues;
}
/** The standard and service interval the meter and fuel types allow. */
export function meterIssues(
  meterType: string,
  fuelType: string,
  value: { standardConsumption?: string | null; serviceEvery?: string | null },
): string[] {
  const issues: string[] = [];
  const needsStandard = meterType !== "none" && fuelType !== "none";
  if (needsStandard !== Boolean(value.standardConsumption)) issues.push("standardConsumption");
  if (meterType === "none" && value.serviceEvery) issues.push("serviceEvery");
  return issues;
}

export const createPlantRequestSchema = z
  .strictObject({
    code: plantCode,
    ...editableFields,
    ownership: z.enum(PLANT_OWNERSHIPS),
    meterType: z.enum(METER_TYPES),
    fuelType: z.enum(FUEL_TYPES),
    openingOn: planningDateSchema,
    openingReading: meterReadingSchema.nullable().optional(),
    /** Where the item starts: a project site, or null/absent for the yard. */
    siteId: uuid.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    for (const path of [
      ...hireIssues(value.ownership, value, value.meterType),
      ...meterIssues(value.meterType, value.fuelType, value),
      ...((value.meterType === "none") === Boolean(value.openingReading) ? ["openingReading"] : []),
    ])
      ctx.addIssue({ code: "custom", path: [path], message: "inconsistent" });
  });
export type CreatePlantRequest = z.input<typeof createPlantRequestSchema>;
export type ParsedCreatePlantRequest = z.infer<typeof createPlantRequestSchema>;

/** Every editable field (the code, ownership, meter, fuel type and opening reading are fixed). */
export const updatePlantRequestSchema = z.strictObject({ ...editableFields, version });
export type UpdatePlantRequest = z.input<typeof updatePlantRequestSchema>;
export type ParsedUpdatePlantRequest = z.infer<typeof updatePlantRequestSchema>;

export const movePlantRequestSchema = z.strictObject({
  version,
  /** A project site, or null to bring the item back to the yard. */
  siteId: uuid.nullable(),
  movedOn: planningDateSchema,
  reason: optionalText(500, true).optional(),
});
export type MovePlantRequest = z.input<typeof movePlantRequestSchema>;

export const closePlantRequestSchema = z.strictObject({
  version,
  action: z.enum(PLANT_CLOSE_ACTIONS),
  closedOn: planningDateSchema,
  reason,
});
export type ClosePlantRequest = z.input<typeof closePlantRequestSchema>;

export const assignOperatorRequestSchema = z
  .strictObject({
    projectId: uuid,
    kind: z.enum(OPERATOR_KINDS),
    labourerId: uuid.nullable().optional(),
    userId: uuid.nullable().optional(),
    fromOn: planningDateSchema,
    toOn: planningDateSchema.nullable().optional(),
    certificateRef: optionalText(60).optional(),
    certificateExpiresOn: planningDateSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.kind === "labourer") !== Boolean(value.labourerId))
      ctx.addIssue({ code: "custom", path: ["labourerId"], message: "inconsistent" });
    if ((value.kind === "staff") !== Boolean(value.userId))
      ctx.addIssue({ code: "custom", path: ["userId"], message: "inconsistent" });
    if (value.toOn && value.toOn < value.fromOn)
      ctx.addIssue({ code: "custom", path: ["toOn"], message: "before_start" });
    if (value.certificateExpiresOn && !value.certificateRef)
      ctx.addIssue({ code: "custom", path: ["certificateRef"], message: "required" });
  });
export type AssignOperatorRequest = z.input<typeof assignOperatorRequestSchema>;
export const endOperatorRequestSchema = z.strictObject({ version, toOn: planningDateSchema });

// Usage, fuel and the meter -----------------------------------------------------------------------

const operatorRef = {
  operatorLabourerId: uuid.nullable().optional(),
  operatorUserId: uuid.nullable().optional(),
};
const usageValues = {
  siteId: uuid,
  dayStatus: z.enum(USAGE_DAY_STATUSES),
  startReading: meterReadingSchema.nullable().optional(),
  endReading: meterReadingSchema.nullable().optional(),
  ...operatorRef,
  bqItemLineageId: uuid.nullable().optional(),
  costCodeId: uuid.nullable().optional(),
  notes: optionalText(500, true).optional(),
};
type UsageShape = {
  startReading?: string | null | undefined;
  endReading?: string | null | undefined;
  operatorLabourerId?: string | null | undefined;
  operatorUserId?: string | null | undefined;
  bqItemLineageId?: string | null | undefined;
  costCodeId?: string | null | undefined;
};
const usageIssues = (value: UsageShape): string[] => {
  const issues: string[] = [];
  if (Boolean(value.startReading) !== Boolean(value.endReading)) issues.push("endReading");
  if (
    value.startReading &&
    value.endReading &&
    parseTenths(value.endReading)! < parseTenths(value.startReading)!
  )
    issues.push("endReading");
  if (value.operatorLabourerId && value.operatorUserId) issues.push("operatorUserId");
  if (value.bqItemLineageId && value.costCodeId) issues.push("costCodeId");
  return issues;
};

/**
 * A day's usage of one item at one site (offline-ready: a client-generated ID and an
 * Idempotency-Key header; a replay returns the original).
 */
export const recordUsageRequestSchema = z
  .strictObject({
    id: uuid,
    usedOn: planningDateSchema,
    ...usageValues,
    capturedAt: timestamp,
  })
  .superRefine((value, ctx) => {
    for (const path of usageIssues(value))
      ctx.addIssue({ code: "custom", path: [path], message: "inconsistent" });
  });
export type RecordUsageRequest = z.input<typeof recordUsageRequestSchema>;
export type ParsedRecordUsageRequest = z.infer<typeof recordUsageRequestSchema>;

/** A correction (new values, same day) or a void, always with a reason; never an edit. */
export const correctUsageRequestSchema = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("void"), id: uuid, reason, capturedAt: timestamp }),
    z.strictObject({
      action: z.literal("correct"),
      id: uuid,
      reason,
      capturedAt: timestamp,
      ...usageValues,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.action === "correct")
      for (const path of usageIssues(value))
        ctx.addIssue({ code: "custom", path: [path], message: "inconsistent" });
  });
export type CorrectUsageRequest = z.input<typeof correctUsageRequestSchema>;
export type ParsedCorrectUsageRequest = z.infer<typeof correctUsageRequestSchema>;

const fuelValues = {
  siteId: uuid,
  issuedAt: timestamp,
  litres: litresSchema,
  meterReading: meterReadingSchema.nullable().optional(),
  tankFilled: z.boolean(),
  source: z.enum(FUEL_SOURCES),
  reference: optionalText(60).optional(),
  receivedByLabourerId: uuid.nullable().optional(),
  receivedByUserId: uuid.nullable().optional(),
  notes: optionalText(500, true).optional(),
};
const fuelIssues = (value: {
  receivedByLabourerId?: string | null | undefined;
  receivedByUserId?: string | null | undefined;
}) => (value.receivedByLabourerId && value.receivedByUserId ? ["receivedByUserId"] : []);

/** Fuel issued to an item (offline-ready like usage). */
export const recordFuelRequestSchema = z
  .strictObject({ id: uuid, ...fuelValues, capturedAt: timestamp })
  .superRefine((value, ctx) => {
    for (const path of fuelIssues(value))
      ctx.addIssue({ code: "custom", path: [path], message: "inconsistent" });
  });
export type RecordFuelRequest = z.input<typeof recordFuelRequestSchema>;
export type ParsedRecordFuelRequest = z.infer<typeof recordFuelRequestSchema>;

export const correctFuelRequestSchema = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("void"), id: uuid, reason, capturedAt: timestamp }),
    z.strictObject({
      action: z.literal("correct"),
      id: uuid,
      reason,
      capturedAt: timestamp,
      ...fuelValues,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.action === "correct")
      for (const path of fuelIssues(value))
        ctx.addIssue({ code: "custom", path: [path], message: "inconsistent" });
  });
export type CorrectFuelRequest = z.input<typeof correctFuelRequestSchema>;
export type ParsedCorrectFuelRequest = z.infer<typeof correctFuelRequestSchema>;

export const recordMeterResetRequestSchema = z.strictObject({
  resetAt: timestamp,
  oldReading: meterReadingSchema,
  newReading: meterReadingSchema,
  reason: z.enum(METER_RESET_REASONS),
  note: reason,
});
export type RecordMeterResetRequest = z.input<typeof recordMeterResetRequestSchema>;

// Breakdowns and services -----------------------------------------------------------------------

export const reportBreakdownRequestSchema = z.strictObject({
  siteId: uuid,
  reportedAt: timestamp,
  severity: z.enum(BREAKDOWN_SEVERITIES),
  description: text(5, 1000, true),
});
export type ReportBreakdownRequest = z.input<typeof reportBreakdownRequestSchema>;
export const resolveBreakdownRequestSchema = z
  .strictObject({
    version,
    resolution: z.enum(BREAKDOWN_RESOLUTIONS),
    resolvedOn: planningDateSchema,
    note: optionalText(500, true).optional(),
    repairedBy: optionalText(120).optional(),
    costReference: optionalText(60).optional(),
  })
  .superRefine((value, ctx) => {
    // Sending plant back or writing it off needs a reason.
    if (value.resolution !== "repaired" && !value.note)
      ctx.addIssue({ code: "custom", path: ["note"], message: "required" });
  });
export type ResolveBreakdownRequest = z.input<typeof resolveBreakdownRequestSchema>;

export const recordServiceRequestSchema = z.strictObject({
  servicedAt: timestamp,
  kind: z.enum(SERVICE_KINDS),
  meterReading: meterReadingSchema.nullable().optional(),
  description: text(3, 500, true),
  doneBy: optionalText(120).optional(),
  costReference: optionalText(60).optional(),
});
export type RecordServiceRequest = z.input<typeof recordServiceRequestSchema>;
export const voidServiceRequestSchema = z.strictObject({ version, reason });

// Queries ---------------------------------------------------------------------------------------

export const plantListQuerySchema = z.strictObject({
  status: z.enum([...PLANT_STATUSES, "active"]).optional(),
  category: plantCategorySchema.optional(),
  ownership: z.enum(PLANT_OWNERSHIPS).optional(),
  projectId: uuid.optional(),
  /** Only items with an alert. */
  attention: z.enum(["true"]).optional(),
  search,
  cursor: offsetCursor,
  limit,
});
export type PlantListQuery = z.infer<typeof plantListQuerySchema>;
export const plantRecordsQuerySchema = z.strictObject({ cursor: offsetCursor, limit });
export type PlantRecordsQuery = z.infer<typeof plantRecordsQuerySchema>;
export const plantAlertsQuerySchema = z.strictObject({
  kind: plantAlertKindSchema.optional(),
  projectId: uuid.optional(),
  cursor: offsetCursor,
  limit,
});
export type PlantAlertsQuery = z.infer<typeof plantAlertsQuerySchema>;
export const projectPlantOptionsQuerySchema = z.strictObject({ search, bqSearch: search });
export type ProjectPlantOptionsQuery = z.infer<typeof projectPlantOptionsQuerySchema>;

// Responses -------------------------------------------------------------------------------------

const alertSchema = z.strictObject({
  kind: plantAlertKindSchema,
  severity: z.enum(PLANT_ALERT_SEVERITIES),
});
export const plantLocationSchema = z.strictObject({
  projectId: uuid,
  projectCode: z.string(),
  projectName: z.string(),
  siteId: uuid,
  siteName: z.string(),
});
export type PlantLocation = z.infer<typeof plantLocationSchema>;
const serviceSchema = z.strictObject({
  state: z.enum(SERVICE_STATES),
  /** Hours or km left (negative when overdue). */
  remaining: decimal1.nullable(),
  dueOn: z.iso.date().nullable(),
});
const hireSummarySchema = z.strictObject({
  supplier: z.strictObject({ id: uuid, name: z.string() }),
  startOn: z.iso.date(),
  endOn: z.iso.date().nullable(),
  /** Calendar days on hire to date (start and today/off-hire inclusive). */
  daysOnHire: count,
  idleDays: count,
  /** Null for callers without a cost permission. */
  rateMinor: z.number().int().nullable(),
  rateUnit: z.enum(HIRE_RATE_UNITS),
  /** An estimate for review; the supplier's invoice is the charge (never posted). */
  estimateMinor: z.number().int().nullable(),
});
export const plantItemSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  category: plantCategorySchema,
  ownership: z.enum(PLANT_OWNERSHIPS),
  quantity: z.number().int().min(1),
  makeModel: z.string().nullable(),
  registration: z.string().nullable(),
  meterType: z.enum(METER_TYPES),
  fuelType: z.enum(FUEL_TYPES),
  status: plantStatusSchema,
  statusReason: z.string().nullable(),
  closedOn: z.iso.date().nullable(),
  /** Null in the yard; restricted when on a project the caller cannot read. */
  location: plantLocationSchema.nullable(),
  locationRestricted: z.boolean(),
  meter: z.strictObject({ reading: decimal1.nullable(), readAt: timestamp.nullable() }),
  service: serviceSchema,
  hire: hireSummarySchema.nullable(),
  openBreakdowns: count,
  alerts: z.array(alertSchema),
  version,
});
export type PlantItem = z.infer<typeof plantItemSchema>;

export const plantListResponseSchema = z.strictObject({
  items: z.array(plantItemSchema),
  nextCursor: z.number().int().nullable(),
  counts: z.strictObject({
    total: count,
    onSite: count,
    available: count,
    underRepair: count,
    hired: count,
    attention: count,
  }),
  permissions: z.strictObject({ canRegister: z.boolean(), canEditSettings: z.boolean() }),
});
export type PlantListResponse = z.infer<typeof plantListResponseSchema>;

const moveSchema = z.strictObject({
  id: uuid,
  seq: z.number().int().min(1),
  movedOn: z.iso.date(),
  from: plantLocationSchema.nullable(),
  to: plantLocationSchema.nullable(),
  /** One end is on a project the caller cannot read. */
  restricted: z.boolean(),
  reason: z.string().nullable(),
  movedBy: person,
  createdAt: timestamp,
});
const operatorSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  kind: z.enum(OPERATOR_KINDS),
  labourer: z.strictObject({ id: uuid, workerNo: z.string(), fullName: z.string() }).nullable(),
  user: person.nullable(),
  fromOn: z.iso.date(),
  toOn: z.iso.date().nullable(),
  certificateRef: z.string().nullable(),
  certificateExpiresOn: z.iso.date().nullable(),
  certificateState: z.enum(OPERATOR_CERTIFICATE_STATES),
  active: z.boolean(),
  version,
  permissions: z.strictObject({ canEnd: z.boolean() }),
});
export type PlantOperator = z.infer<typeof operatorSchema>;
const breakdownSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  reportedAt: timestamp,
  severity: z.enum(BREAKDOWN_SEVERITIES),
  description: z.string(),
  status: z.enum(BREAKDOWN_STATUSES),
  reportedBy: person,
  resolvedOn: z.iso.date().nullable(),
  resolutionNote: z.string().nullable(),
  repairedBy: z.string().nullable(),
  costReference: z.string().nullable(),
  resolvedBy: person.nullable(),
  /** Days out of service so far (or until resolved). */
  daysDown: count,
  version,
  permissions: z.strictObject({
    canRepair: z.boolean(),
    canOffHire: z.boolean(),
    canWriteOff: z.boolean(),
  }),
});
export type PlantBreakdown = z.infer<typeof breakdownSchema>;
const serviceRecordSchema = z.strictObject({
  id: uuid,
  servicedAt: timestamp,
  kind: z.enum(SERVICE_KINDS),
  meterReading: decimal1.nullable(),
  description: z.string(),
  doneBy: z.string().nullable(),
  costReference: z.string().nullable(),
  status: z.enum(SERVICE_RECORD_STATUSES),
  voidReason: z.string().nullable(),
  recordedBy: person,
  version,
  permissions: z.strictObject({ canVoid: z.boolean() }),
});
export type PlantServiceRecord = z.infer<typeof serviceRecordSchema>;
const resetSchema = z.strictObject({
  id: uuid,
  resetAt: timestamp,
  oldReading: decimal1,
  newReading: decimal1,
  reason: z.enum(METER_RESET_REASONS),
  note: z.string(),
  recordedBy: person,
});

export const plantDetailSchema = plantItemSchema
  .extend({
    lpo: z.strictObject({ id: uuid, number: z.string() }).nullable(),
    hireEndOn: z.iso.date().nullable(),
    standardConsumption: decimal2.nullable(),
    openingOn: z.iso.date(),
    openingReading: decimal1.nullable(),
    serviceEvery: decimal1.nullable(),
    serviceEveryDays: z.number().int().nullable(),
    notes: z.string().nullable(),
    createdBy: person,
    createdAt: timestamp,
  })
  .strict();
export type PlantDetail = z.infer<typeof plantDetailSchema>;
export const plantDetailResponseSchema = z.strictObject({
  item: plantDetailSchema,
  moves: z.array(moveSchema),
  operators: z.array(operatorSchema),
  breakdowns: z.array(breakdownSchema),
  services: z.array(serviceRecordSchema),
  resets: z.array(resetSchema),
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canMove: z.boolean(),
    canClose: z.boolean(),
    canAssignOperator: z.boolean(),
    canResetMeter: z.boolean(),
    /** At the item's current site (null in the yard). */
    canRecordUsage: z.boolean(),
    canRecordFuel: z.boolean(),
    canReportBreakdown: z.boolean(),
    canRecordService: z.boolean(),
    canSeeCost: z.boolean(),
  }),
});
export type PlantDetailResponse = z.infer<typeof plantDetailResponseSchema>;

const recordFields = {
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  state: z.enum(PLANT_RECORD_STATES),
  correctsId: uuid.nullable(),
  correctionReason: z.string().nullable(),
  supersededById: uuid.nullable(),
  recordedBy: person,
  recordedAt: timestamp,
  permissions: z.strictObject({ canCorrect: z.boolean() }),
};
const namedRef = z.strictObject({ id: uuid, name: z.string() });
export const plantUsageEntrySchema = z.strictObject({
  ...recordFields,
  usedOn: z.iso.date(),
  dayStatus: z.enum(USAGE_DAY_STATUSES),
  startReading: decimal1.nullable(),
  endReading: decimal1.nullable(),
  /** end − start (hours or km). */
  run: decimal1.nullable(),
  operator: namedRef
    .extend({ kind: z.enum(OPERATOR_KINDS) })
    .strict()
    .nullable(),
  bqItem: z
    .strictObject({ lineageId: uuid, ref: z.string().nullable(), description: z.string() })
    .nullable(),
  costCode: z.strictObject({ id: uuid, code: z.string(), name: z.string() }).nullable(),
  notes: z.string().nullable(),
});
export type PlantUsageEntry = z.infer<typeof plantUsageEntrySchema>;
export const plantUsageListResponseSchema = z.strictObject({
  entries: z.array(plantUsageEntrySchema),
  nextCursor: z.number().int().nullable(),
  totals: z.strictObject({
    workingDays30: count,
    idleDays30: count,
    breakdownDays30: count,
    run30: decimal1.nullable(),
  }),
});
export type PlantUsageListResponse = z.infer<typeof plantUsageListResponseSchema>;
export const plantUsageResponseSchema = z.strictObject({
  entry: plantUsageEntrySchema,
  replayed: z.boolean(),
});

export const plantFuelEntrySchema = z.strictObject({
  ...recordFields,
  issuedAt: timestamp,
  litres: decimal1,
  meterReading: decimal1.nullable(),
  tankFilled: z.boolean(),
  fuelType: z.enum(FUEL_TYPES),
  standardConsumption: decimal2.nullable(),
  source: z.enum(FUEL_SOURCES),
  reference: z.string().nullable(),
  receivedBy: namedRef
    .extend({ kind: z.enum(OPERATOR_KINDS) })
    .strict()
    .nullable(),
  notes: z.string().nullable(),
  /** The meter had not moved since the previous fuelling (an estimate for review). */
  meterStatic: z.boolean(),
});
export type PlantFuelEntry = z.infer<typeof plantFuelEntrySchema>;
export const fuelWindowSchema = z.strictObject({
  fromId: uuid,
  toId: uuid,
  fromAt: timestamp,
  toAt: timestamp,
  issueCount: count,
  litres: decimal1,
  /** Meter advance over the window (hours or km). */
  advance: decimal1,
  standardConsumption: decimal2.nullable(),
  expectedLitres: decimal1.nullable(),
  /** Actual litres per hour or km. */
  actualRate: decimal2.nullable(),
  /** (actual − expected) ÷ expected, truncated to one decimal ("30.0"). */
  variancePercent: decimal1.nullable(),
  state: z.enum(FUEL_WINDOW_STATES),
});
export type FuelWindowWire = z.infer<typeof fuelWindowSchema>;
export const plantFuelListResponseSchema = z.strictObject({
  entries: z.array(plantFuelEntrySchema),
  nextCursor: z.number().int().nullable(),
  /** Newest first, closing within the look-back window. */
  windows: z.array(fuelWindowSchema),
  pending: z.strictObject({ issueCount: count, litres: decimal1, advance: decimal1 }),
  rules: z.strictObject({
    tolerancePercent: z.number().int(),
    minSample: z.number().int(),
    meterType: z.enum(METER_TYPES),
  }),
});
export type PlantFuelListResponse = z.infer<typeof plantFuelListResponseSchema>;
export const plantFuelResponseSchema = z.strictObject({
  entry: plantFuelEntrySchema,
  replayed: z.boolean(),
  /** The window this issue closed, if it closed one. */
  window: fuelWindowSchema.nullable(),
});

export const plantAlertEntrySchema = alertSchema
  .extend({
    plantId: uuid,
    code: z.string(),
    name: z.string(),
    category: plantCategorySchema,
    location: plantLocationSchema.nullable(),
  })
  .strict();
export type PlantAlertEntry = z.infer<typeof plantAlertEntrySchema>;
export const plantAlertsResponseSchema = z.strictObject({
  alerts: z.array(plantAlertEntrySchema),
  nextCursor: z.number().int().nullable(),
  counts: z.record(plantAlertKindSchema, count),
});
export type PlantAlertsResponse = z.infer<typeof plantAlertsResponseSchema>;

/** The register form's choices: suppliers, LPOs and the sites the caller can move plant to. */
export const plantOptionsResponseSchema = z.strictObject({
  suppliers: z.array(z.strictObject({ id: uuid, code: z.string(), name: z.string() })),
  lpos: z.array(
    z.strictObject({ id: uuid, number: z.string(), supplierId: uuid, projectCode: z.string() }),
  ),
  sites: z.array(plantLocationSchema),
});
export type PlantOptionsResponse = z.infer<typeof plantOptionsResponseSchema>;

/** A project's plant tab: items on its sites today, what needs attention and what may be done. */
export const projectPlantItemSchema = plantItemSchema
  .extend({
    today: z.strictObject({
      usageRecorded: z.boolean(),
      litres: decimal1,
    }),
    operators: z.array(namedRef.extend({ kind: z.enum(OPERATOR_KINDS) }).strict()),
  })
  .strict();
export type ProjectPlantItem = z.infer<typeof projectPlantItemSchema>;
export const projectPlantResponseSchema = z.strictObject({
  items: z.array(projectPlantItemSchema),
  sites: z.array(z.strictObject({ id: uuid, name: z.string() })),
  permissions: z.strictObject({
    canRecordUsage: z.boolean(),
    canRecordFuel: z.boolean(),
    canReportBreakdown: z.boolean(),
    canManage: z.boolean(),
    canSeeCost: z.boolean(),
  }),
});
export type ProjectPlantResponse = z.infer<typeof projectPlantResponseSchema>;
export const projectPlantOptionsResponseSchema = z.strictObject({
  labourers: z.array(z.strictObject({ id: uuid, workerNo: z.string(), fullName: z.string() })),
  staff: z.array(person),
  costCodes: z.array(z.strictObject({ id: uuid, code: z.string(), name: z.string() })),
  bqItems: z.array(
    z.strictObject({ lineageId: uuid, ref: z.string().nullable(), description: z.string() }),
  ),
});
export type ProjectPlantOptionsResponse = z.infer<typeof projectPlantOptionsResponseSchema>;

export type PlantSettings = z.infer<typeof plantSettingsSchema>;
export type UpdatePlantSettingsRequest = z.input<typeof updatePlantSettingsRequestSchema>;
