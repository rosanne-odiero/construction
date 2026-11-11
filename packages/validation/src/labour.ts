import {
  normalizeKenyanPhone,
  normaliseIdNumber,
  normaliseKraPin,
  normaliseStatutoryNumber,
  RATE_SCOPES,
} from "@pm-buddy/domain";
import {
  ACCREDITATION_ALERT_DAYS_LIMITS,
  ACCREDITATION_CATEGORIES,
  ACCREDITATION_STATUSES,
  CONSENT_KINDS,
  CONSENT_METHODS,
  CONSENT_NOTICE_VERSIONS,
  CONSENT_STATUSES,
  ENGAGEMENT_TYPES,
  GANG_STATUSES,
  GENDERS,
  ID_DOCUMENT_TYPES,
  LABOURER_STATUSES,
  LOCALES,
  NCA_CATEGORIES,
  RATE_BASES,
  REVEAL_PURPOSES,
  SENSITIVE_LABOUR_FIELDS,
} from "@pm-buddy/types";
import { z } from "zod";
import { countySchema } from "./projects.js";

/**
 * Labour registry (D3.1): trades, skill levels, settings, rates, labourers, engagements, consent,
 * NCA accreditation, do-not-rehire, gangs and saved views. Request schemas are strict (unknown
 * fields are refused, so a body never carries a tenant ID); responses are strict too. Identifiers
 * are normalised here (blind indexes depend on one canonical form); responses carry only masked
 * values except the dedicated reveal response.
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
/** A business calendar date (YYYY-MM-DD, Africa/Nairobi). */
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const name = (min: number, max: number) => z.string().trim().min(min).max(max);
const actor = z.object({ id: uuid, displayName: z.string().min(1).max(100) }).strict();
const atLeastOneChange = (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
  const { version: _version, ...fields } = value;
  if (!Object.values(fields).some((field) => field !== undefined))
    ctx.addIssue({ code: "custom", message: "no_changes" });
};

export const labourerStatusSchema = z.enum(LABOURER_STATUSES);
export const engagementTypeSchema = z.enum(ENGAGEMENT_TYPES);
export const rateBasisSchema = z.enum(RATE_BASES);
export const genderSchema = z.enum(GENDERS);
export const idDocumentTypeSchema = z.enum(ID_DOCUMENT_TYPES);
export const ncaCategorySchema = z.enum(NCA_CATEGORIES);
export const accreditationCategorySchema = z.enum(ACCREDITATION_CATEGORIES);
export const accreditationStatusSchema = z.enum(ACCREDITATION_STATUSES);
export const consentKindSchema = z.enum(CONSENT_KINDS);
export const consentMethodSchema = z.enum(CONSENT_METHODS);
export const consentStatusSchema = z.enum(CONSENT_STATUSES);
export const consentNoticeVersionSchema = z.enum(CONSENT_NOTICE_VERSIONS);
export const gangStatusSchema = z.enum(GANG_STATUSES);
export const sensitiveLabourFieldSchema = z.enum(SENSITIVE_LABOUR_FIELDS);
export const revealPurposeSchema = z.enum(REVEAL_PURPOSES);
export const rateScopeSchema = z.enum(RATE_SCOPES);
export const localeSchema = z.enum(LOCALES);

/** Configuration keys: lower-case letters, digits and underscores (e.g. `steel_fixer`). */
export const labourKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, "invalid_key");

/** A reason that justifies a sensitive decision (do-not-rehire, overrides): 10–500 characters. */
export const labourReasonSchema = z.string().trim().min(10).max(500);
/** An optional short reason (ending an engagement, deactivating): empty or 3–500 characters. */
const shortReasonSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value.length === 0 || value.length >= 3, "reason_too_short");

// Configuration ----------------------------------------------------------------------------------

export const tradeSchema = z
  .object({
    id: uuid,
    key: z.string().min(2).max(40),
    nameEn: z.string().min(1).max(80),
    nameSw: z.string().min(1).max(80),
    active: z.boolean(),
    sortOrder: z.number().int().min(0),
    version,
  })
  .strict();

export const skillLevelSchema = z
  .object({
    id: uuid,
    key: z.string().min(2).max(40),
    nameEn: z.string().min(1).max(80),
    nameSw: z.string().min(1).max(80),
    ncaCategory: ncaCategorySchema,
    /** Skilled workers and site supervisors are expected to hold NCA accreditation. */
    accreditationExpected: z.boolean(),
    active: z.boolean(),
    sortOrder: z.number().int().min(0),
    version,
  })
  .strict();

export const labourSettingsSchema = z
  .object({
    /** Lead time for NCA expiry alerts (`labour.accreditation_alert_days`). */
    accreditationAlertDays: z
      .number()
      .int()
      .min(ACCREDITATION_ALERT_DAYS_LIMITS.min)
      .max(ACCREDITATION_ALERT_DAYS_LIMITS.max),
    /** 0 while the company still uses the defaults (no settings row yet). */
    version: z.number().int().min(0),
  })
  .strict();

export const labourSetupResponseSchema = z
  .object({
    trades: z.array(tradeSchema),
    skillLevels: z.array(skillLevelSchema),
    settings: labourSettingsSchema,
    /** Whether the caller may change company labour configuration (config.manage). */
    canConfigure: z.boolean(),
    /** Open projects on which the caller holds labour.manage (register, engage, gangs, rates). */
    manageableProjects: z.array(
      z.object({ id: uuid, code: z.string(), name: z.string() }).strict(),
    ),
  })
  .strict();

export const createTradeRequestSchema = z
  .object({
    key: labourKeySchema,
    nameEn: name(1, 80),
    nameSw: name(1, 80),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export const updateTradeRequestSchema = z
  .object({
    nameEn: name(1, 80).optional(),
    nameSw: name(1, 80).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    version,
  })
  .strict()
  .superRefine(atLeastOneChange);
export const tradeResponseSchema = z.object({ trade: tradeSchema }).strict();

export const createSkillLevelRequestSchema = z
  .object({
    key: labourKeySchema,
    nameEn: name(1, 80),
    nameSw: name(1, 80),
    ncaCategory: ncaCategorySchema,
    accreditationExpected: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export const updateSkillLevelRequestSchema = z
  .object({
    nameEn: name(1, 80).optional(),
    nameSw: name(1, 80).optional(),
    ncaCategory: ncaCategorySchema.optional(),
    accreditationExpected: z.boolean().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    version,
  })
  .strict()
  .superRefine(atLeastOneChange);
export const skillLevelResponseSchema = z.object({ skillLevel: skillLevelSchema }).strict();

export const updateLabourSettingsRequestSchema = z
  .object({
    accreditationAlertDays: z
      .number()
      .int()
      .min(ACCREDITATION_ALERT_DAYS_LIMITS.min)
      .max(ACCREDITATION_ALERT_DAYS_LIMITS.max),
    /** The version read (0 when the company still uses the defaults). */
    version: z.number().int().min(0),
  })
  .strict();

// Rates ------------------------------------------------------------------------------------------

/** A daily or hourly rate in KES minor units; at most KES 10,000,000 per day or hour. */
export const rateMinorSchema = z.number().int().min(1).max(1_000_000_000);

export const labourRateSchema = z
  .object({
    id: uuid,
    scope: rateScopeSchema,
    projectId: uuid.nullable(),
    labourerId: uuid.nullable(),
    tradeId: uuid.nullable(),
    skillLevelId: uuid.nullable(),
    basis: rateBasisSchema,
    rateMinor: rateMinorSchema,
    currency: z.literal("KES"),
    effectiveFrom: calendarDate,
    /** The day before the next rate of the same kind starts; null while it is the latest. */
    effectiveTo: calendarDate.nullable(),
    /** In force today (Africa/Nairobi). */
    inForce: z.boolean(),
    /** Starts after today: never used yet, so it can still be cancelled. */
    scheduled: z.boolean(),
    createdAt: timestamp,
    createdBy: actor,
  })
  .strict();

/**
 * Minimum-wage checks need an approved wage table (`payroll.minimum_wage_table`). Until a reviewer
 * approves one the API reports it as not configured; it never invents a minimum.
 * COMPLIANCE-REVIEW: CR-PAY-09.
 */
export const minimumWageCheckSchema = z
  .object({ status: z.literal("not_configured"), reference: z.literal("CR-PAY-09") })
  .strict();

export const labourRateListQuerySchema = z
  .object({
    projectId: uuid.optional(),
    labourerId: uuid.optional(),
    tradeId: uuid.optional(),
  })
  .strict();

export const labourRatesResponseSchema = z
  .object({
    rates: z.array(labourRateSchema),
    today: calendarDate,
    minimumWage: minimumWageCheckSchema,
  })
  .strict();

export const createLabourRateRequestSchema = z
  .object({
    /** Null or absent: a company default. */
    projectId: uuid.nullable().optional(),
    /** A labourer's own rate on one project (projectId required; no trade or skill level). */
    labourerId: uuid.optional(),
    tradeId: uuid.optional(),
    skillLevelId: uuid.nullable().optional(),
    basis: rateBasisSchema,
    rateMinor: rateMinorSchema,
    /** Today or later: a rate never changes days that have already passed. */
    effectiveFrom: calendarDate,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.labourerId) {
      if (!value.projectId)
        ctx.addIssue({ code: "custom", path: ["projectId"], message: "project_required" });
      if (value.tradeId || value.skillLevelId)
        ctx.addIssue({ code: "custom", path: ["tradeId"], message: "labourer_rate_has_no_trade" });
    } else if (!value.tradeId) {
      ctx.addIssue({ code: "custom", path: ["tradeId"], message: "trade_required" });
    }
  });
export const labourRateResponseSchema = z
  .object({ rate: labourRateSchema, minimumWage: minimumWageCheckSchema })
  .strict();

export const resolvedRateQuerySchema = z
  .object({ projectId: uuid, date: calendarDate.optional(), basis: rateBasisSchema.optional() })
  .strict();
export const resolvedRateResponseSchema = z
  .object({
    labourerId: uuid,
    projectId: uuid,
    onDate: calendarDate,
    basis: rateBasisSchema,
    /** Null when no rate applies on that date. */
    rate: labourRateSchema.nullable(),
    minimumWage: minimumWageCheckSchema,
  })
  .strict();

// Labourer input ---------------------------------------------------------------------------------

const normalised = (normalise: (value: string) => string | null, message: string) =>
  z
    .string()
    .max(40)
    .transform((value, ctx) => {
      const result = normalise(value);
      if (!result) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return result;
    });

/** Optional and clearable: absent leaves it unchanged, an empty string or null clears it. */
const clearable = (normalise: (value: string) => string | null, message: string) =>
  z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      if (value === null || value.trim() === "") return null;
      const result = normalise(value);
      if (!result) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return result;
    });

export const kraPinSchema = normalised(normaliseKraPin, "invalid_kra_pin");
export const statutoryNumberSchema = normalised(normaliseStatutoryNumber, "invalid_number");
const clearablePhone = clearable(normalizeKenyanPhone, "invalid_kenyan_phone");

export const nextOfKinSchema = z
  .object({
    name: name(2, 120),
    relationship: name(2, 60),
    phone: clearablePhone,
  })
  .strict();

/** What the worker was shown and how they agreed (Kenya Data Protection Act 2019). */
export const consentCaptureSchema = z
  .object({
    noticeVersion: consentNoticeVersionSchema,
    language: localeSchema,
    method: consentMethodSchema,
    /** Required when the notice was read aloud: the person who witnessed the agreement. */
    witnessName: name(3, 120).optional(),
    /** Registration needs consent: a refusal is not recorded as a registration. */
    granted: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === "witnessed_verbal" && !value.witnessName)
      ctx.addIssue({ code: "custom", path: ["witnessName"], message: "witness_required" });
  });

export const doNotRehireOverrideSchema = z.object({ reason: labourReasonSchema }).strict();

export const accreditationInputSchema = z
  .object({
    category: accreditationCategorySchema,
    cardNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9/-]{2,39}$/, "invalid_card_number"),
    issuedOn: calendarDate.nullable().optional(),
    expiresOn: calendarDate,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.issuedOn && value.expiresOn < value.issuedOn)
      ctx.addIssue({ code: "custom", path: ["expiresOn"], message: "expires_before_issued" });
  });

/** An identity document: the number is normalised for its type (blind index and encryption). */
function withIdentity<
  T extends { idType?: z.infer<typeof idDocumentTypeSchema>; idNumber?: string },
>(value: T, ctx: z.RefinementCtx): T {
  if ((value.idType === undefined) !== (value.idNumber === undefined)) {
    ctx.addIssue({ code: "custom", path: ["idNumber"], message: "identity_incomplete" });
    return z.NEVER;
  }
  if (!value.idType || value.idNumber === undefined) return value;
  const idNumber = normaliseIdNumber(value.idType, value.idNumber);
  if (!idNumber) {
    ctx.addIssue({ code: "custom", path: ["idNumber"], message: "invalid_id_number" });
    return z.NEVER;
  }
  return { ...value, idNumber };
}

const personalFields = {
  fullName: name(3, 150),
  gender: genderSchema,
  homeCounty: countySchema.nullable().optional(),
  tradeId: uuid,
  skillLevelId: uuid,
  engagementType: engagementTypeSchema,
  rateBasis: rateBasisSchema,
  phone: clearablePhone,
  kraPin: clearable(normaliseKraPin, "invalid_kra_pin"),
  nssfNumber: clearable(normaliseStatutoryNumber, "invalid_number"),
  shaNumber: clearable(normaliseStatutoryNumber, "invalid_number"),
  nextOfKin: nextOfKinSchema.nullable().optional(),
};

/**
 * Register a labourer with consent. `projectId` engages the worker on a project (required unless
 * the caller's role is company-wide). Anyone under 18 on today's date in Africa/Nairobi is refused
 * (also by the database).
 */
export const registerLabourerRequestSchema = z
  .object({
    ...personalFields,
    dateOfBirth: calendarDate,
    idType: idDocumentTypeSchema,
    idNumber: z.string().max(40),
    projectId: uuid.optional(),
    engagementStartDate: calendarDate.optional(),
    consent: consentCaptureSchema,
    accreditation: accreditationInputSchema.optional(),
    /** Only with labour.do_not_rehire, when a phone or KRA PIN matches a flagged person. */
    doNotRehireOverride: doNotRehireOverrideSchema.optional(),
  })
  .strict()
  .transform(withIdentity);

export const updateLabourerRequestSchema = z
  .object({
    fullName: personalFields.fullName.optional(),
    gender: personalFields.gender.optional(),
    homeCounty: personalFields.homeCounty,
    tradeId: uuid.optional(),
    skillLevelId: uuid.optional(),
    engagementType: engagementTypeSchema.optional(),
    rateBasis: rateBasisSchema.optional(),
    /** A correction; the age rule still applies (and the database refuses under 18). */
    dateOfBirth: calendarDate.optional(),
    idType: idDocumentTypeSchema.optional(),
    idNumber: z.string().max(40).optional(),
    phone: personalFields.phone,
    kraPin: personalFields.kraPin,
    nssfNumber: personalFields.nssfNumber,
    shaNumber: personalFields.shaNumber,
    nextOfKin: personalFields.nextOfKin,
    version,
  })
  .strict()
  .superRefine(atLeastOneChange)
  .transform(withIdentity);

export const labourerStatusRequestSchema = z
  .object({
    to: labourerStatusSchema,
    reason: shortReasonSchema.optional(),
    version,
    doNotRehireOverride: doNotRehireOverrideSchema.optional(),
  })
  .strict();

export const revealRequestSchema = z
  .object({ field: sensitiveLabourFieldSchema, purpose: revealPurposeSchema })
  .strict();
export const revealResponseSchema = z
  .object({
    field: sensitiveLabourFieldSchema,
    /** Null when the field was never recorded. */
    value: z
      .union([
        z.string(),
        z
          .object({ name: z.string(), relationship: z.string(), phone: z.string().nullable() })
          .strict(),
      ])
      .nullable(),
    revealedAt: timestamp,
  })
  .strict();

export const doNotRehireRequestSchema = z
  .object({ flagged: z.boolean(), reason: labourReasonSchema, version })
  .strict();

export const createEngagementRequestSchema = z
  .object({
    projectId: uuid,
    /** Defaults to today (Africa/Nairobi). */
    startDate: calendarDate.optional(),
    doNotRehireOverride: doNotRehireOverrideSchema.optional(),
  })
  .strict();
export const endEngagementRequestSchema = z
  .object({ endDate: calendarDate, reason: shortReasonSchema.optional() })
  .strict();

export const createAccreditationRequestSchema = accreditationInputSchema;
export const updateAccreditationRequestSchema = z
  .object({
    category: accreditationCategorySchema.optional(),
    cardNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9/-]{2,39}$/, "invalid_card_number")
      .optional(),
    issuedOn: calendarDate.nullable().optional(),
    expiresOn: calendarDate.optional(),
    version,
  })
  .strict()
  .superRefine(atLeastOneChange);

export const recordConsentRequestSchema = consentCaptureSchema;
export const withdrawConsentRequestSchema = z
  .object({ method: consentMethodSchema, witnessName: name(3, 120).optional() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === "witnessed_verbal" && !value.witnessName)
      ctx.addIssue({ code: "custom", path: ["witnessName"], message: "witness_required" });
  });

// Labourer output --------------------------------------------------------------------------------

const namedRef = z
  .object({ id: uuid, nameEn: z.string(), nameSw: z.string(), active: z.boolean() })
  .strict();

export const accreditationSummarySchema = z
  .object({
    status: accreditationStatusSchema,
    expiresOn: calendarDate.nullable(),
    daysLeft: z.number().int().nullable(),
  })
  .strict();

export const consentSummarySchema = z
  .object({
    status: consentStatusSchema,
    noticeVersion: consentNoticeVersionSchema.nullable(),
    /** The granted consent is for the current notice version (otherwise ask again). */
    current: z.boolean(),
  })
  .strict();

const projectRef = z
  .object({ projectId: uuid, code: z.string(), name: z.string(), startDate: calendarDate })
  .strict();

export const labourerSummarySchema = z
  .object({
    id: uuid,
    workerNo: z.string().regex(/^WRK-\d{4,}$/),
    fullName: z.string().min(1).max(150),
    status: labourerStatusSchema,
    gender: genderSchema,
    trade: namedRef.nullable(),
    skillLevel: namedRef.extend({ ncaCategory: ncaCategorySchema }).strict().nullable(),
    engagementType: engagementTypeSchema,
    rateBasis: rateBasisSchema,
    /** Open engagements on projects the caller can see. */
    projects: z.array(projectRef),
    gang: z.object({ id: uuid, name: z.string(), projectId: uuid }).strict().nullable(),
    accreditation: accreditationSummarySchema,
    consent: consentSummarySchema,
    idType: idDocumentTypeSchema,
    /** The last three characters only ("•••••" alone when the value cannot be decrypted). */
    idNumberMasked: z.string().regex(/^•+[A-Z0-9]{0,3}$/),
    phoneMasked: z.string().nullable(),
    /** Null when the caller is not a manager (labour.manage or labour.do_not_rehire). */
    doNotRehire: z.boolean().nullable(),
    registeredOn: calendarDate,
  })
  .strict();

export const labourerListQuerySchema = z
  .object({
    status: labourerStatusSchema.optional(),
    tradeId: uuid.optional(),
    skillLevelId: uuid.optional(),
    projectId: uuid.optional(),
    gangId: uuid.optional(),
    /** `attention` = expiring or expired. */
    accreditation: z.enum(["valid", "expiring", "expired", "missing", "attention"]).optional(),
    doNotRehire: z.enum(["true"]).optional(),
    /** `withdrawn`: no active consent; `outdated`: consent to an older notice version. */
    consent: z.enum(["withdrawn", "outdated"]).optional(),
    /** Name or worker number; a full ID or phone number also matches (blind index). */
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export type LabourerListQuery = z.infer<typeof labourerListQuerySchema>;

export const labourersResponseSchema = z
  .object({
    labourers: z.array(labourerSummarySchema),
    total: z.number().int().min(0),
    today: calendarDate,
    alertDays: z.number().int().min(1),
    permissions: z
      .object({
        /** labour.manage company-wide or on at least one project. */
        canRegister: z.boolean(),
        /** labour.do_not_rehire somewhere (sees the do-not-rehire view). */
        canFlag: z.boolean(),
        /** config.manage: trades, skill levels, company rates and settings. */
        canConfigure: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const engagementSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    projectCode: z.string(),
    projectName: z.string(),
    startDate: calendarDate,
    endDate: calendarDate.nullable(),
    endReason: z.string().nullable(),
    open: z.boolean(),
  })
  .strict();

export const gangMembershipSchema = z
  .object({
    membershipId: uuid,
    gangId: uuid,
    gangName: z.string(),
    projectId: uuid,
    joinedOn: calendarDate,
    leftOn: calendarDate.nullable(),
  })
  .strict();

export const accreditationSchema = z
  .object({
    id: uuid,
    category: accreditationCategorySchema,
    cardNumber: z.string(),
    issuedOn: calendarDate.nullable(),
    expiresOn: calendarDate,
    status: accreditationStatusSchema,
    daysLeft: z.number().int(),
    version,
  })
  .strict();

export const consentRecordSchema = z
  .object({
    id: uuid,
    kind: consentKindSchema,
    noticeVersion: consentNoticeVersionSchema,
    language: localeSchema,
    method: consentMethodSchema,
    witnessName: z.string().nullable(),
    granted: z.boolean(),
    capturedAt: timestamp,
    capturedBy: actor,
    withdrawnAt: timestamp.nullable(),
    withdrawnBy: actor.nullable(),
    withdrawalMethod: consentMethodSchema.nullable(),
  })
  .strict();

export const doNotRehireDetailSchema = z
  .object({
    flagged: z.boolean(),
    setAt: timestamp.nullable(),
    setBy: actor.nullable(),
    /** Only for callers holding labour.do_not_rehire. */
    reason: z.string().nullable(),
  })
  .strict();

export const labourerDetailSchema = labourerSummarySchema
  .extend({
    dateOfBirth: calendarDate,
    age: z.number().int().min(0),
    homeCounty: countySchema.nullable(),
    kraPinMasked: z.string().nullable(),
    nssfNumberMasked: z.string().nullable(),
    shaNumberMasked: z.string().nullable(),
    nextOfKinRecorded: z.boolean(),
    engagements: z.array(engagementSchema),
    gangHistory: z.array(gangMembershipSchema),
    accreditations: z.array(accreditationSchema),
    consents: z.array(consentRecordSchema),
    doNotRehireDetail: doNotRehireDetailSchema.nullable(),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    permissions: z
      .object({
        canManage: z.boolean(),
        canReveal: z.boolean(),
        canFlag: z.boolean(),
        canConsent: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** Non-blocking findings returned with a registration or update. */
export const LABOURER_WARNINGS = [
  "phone-shared",
  "accreditation-missing",
  "accreditation-expiring",
  "accreditation-expired",
  "do-not-rehire-overridden",
] as const;
export const labourerWarningSchema = z.enum(LABOURER_WARNINGS);

export const labourerResponseSchema = z
  .object({ labourer: labourerDetailSchema, warnings: z.array(labourerWarningSchema) })
  .strict();

/**
 * A registration that matches an existing labourer by ID number (409 `duplicate-identity`) or a
 * flagged person by any blind index (409 `do-not-rehire-match`) names the existing record so an
 * authorised user can engage it instead of creating a ghost duplicate.
 */
export const labourerMatchSchema = z
  .object({ labourerId: uuid, workerNo: z.string(), matchedOn: z.enum(["id", "phone", "kraPin"]) })
  .strict();

export const accreditationAlertSchema = z
  .object({
    labourerId: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    kind: z.enum(["expired", "expiring", "missing"]),
    accreditationId: uuid.nullable(),
    category: accreditationCategorySchema.nullable(),
    expiresOn: calendarDate.nullable(),
    daysLeft: z.number().int().nullable(),
  })
  .strict();
export const accreditationAlertsResponseSchema = z
  .object({
    alerts: z.array(accreditationAlertSchema),
    alertDays: z.number().int().min(1),
    today: calendarDate,
  })
  .strict();
export const accreditationAlertsQuerySchema = z.object({ projectId: uuid.optional() }).strict();

// Gangs ------------------------------------------------------------------------------------------

export const gangSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    projectCode: z.string(),
    projectName: z.string(),
    siteId: uuid.nullable(),
    siteName: z.string().nullable(),
    name: z.string().min(1).max(80),
    status: gangStatusSchema,
    leader: z
      .object({ labourerId: uuid, workerNo: z.string(), fullName: z.string() })
      .strict()
      .nullable(),
    memberCount: z.number().int().min(0),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const gangsResponseSchema = z
  .object({
    gangs: z.array(gangSchema),
    /** Projects on which the caller may create and change gangs (labour.manage). */
    manageableProjectIds: z.array(uuid),
  })
  .strict();
export const gangListQuerySchema = z
  .object({ projectId: uuid.optional(), status: gangStatusSchema.optional() })
  .strict();

export const gangMemberSchema = z
  .object({
    membershipId: uuid,
    labourerId: uuid,
    workerNo: z.string(),
    fullName: z.string(),
    joinedOn: calendarDate,
    leftOn: calendarDate.nullable(),
    current: z.boolean(),
  })
  .strict();

export const gangDetailResponseSchema = z
  .object({
    gang: gangSchema,
    members: z.array(gangMemberSchema),
    canManage: z.boolean(),
  })
  .strict();
export const gangResponseSchema = z.object({ gang: gangSchema }).strict();

export const createGangRequestSchema = z
  .object({ projectId: uuid, name: name(2, 80), siteId: uuid.nullable().optional() })
  .strict();
export const updateGangRequestSchema = z
  .object({
    name: name(2, 80).optional(),
    siteId: uuid.nullable().optional(),
    /** Must be a current member of the gang; null clears the leader. */
    leaderLabourerId: uuid.nullable().optional(),
    status: gangStatusSchema.optional(),
    version,
  })
  .strict()
  .superRefine(atLeastOneChange);
export const addGangMemberRequestSchema = z
  .object({ labourerId: uuid, joinedOn: calendarDate.optional() })
  .strict();
export const leaveGangRequestSchema = z.object({ leftOn: calendarDate.optional() }).strict();

// Saved views ------------------------------------------------------------------------------------

/** The registry filters a saved view stores (the list query without paging). */
export const labourViewFiltersSchema = labourerListQuerySchema
  .omit({ limit: true, offset: true })
  .strict();

export const labourViewSchema = z
  .object({
    /** A built-in view key (`all`, `active`, `attention`, `doNotRehire`) or a saved view ID. */
    id: z.string().min(1).max(40),
    name: z.string().min(1).max(60),
    builtIn: z.boolean(),
    filters: labourViewFiltersSchema,
  })
  .strict();
export const labourViewsResponseSchema = z.object({ views: z.array(labourViewSchema) }).strict();
export const labourViewResponseSchema = z.object({ view: labourViewSchema }).strict();
export const createLabourViewRequestSchema = z
  .object({ name: name(2, 60), filters: labourViewFiltersSchema })
  .strict();

export type Trade = z.infer<typeof tradeSchema>;
export type SkillLevel = z.infer<typeof skillLevelSchema>;
export type LabourSettings = z.infer<typeof labourSettingsSchema>;
export type LabourSetupResponse = z.infer<typeof labourSetupResponseSchema>;
export type CreateTradeRequest = z.input<typeof createTradeRequestSchema>;
export type UpdateTradeRequest = z.input<typeof updateTradeRequestSchema>;
export type CreateSkillLevelRequest = z.input<typeof createSkillLevelRequestSchema>;
export type UpdateSkillLevelRequest = z.input<typeof updateSkillLevelRequestSchema>;
export type LabourRate = z.infer<typeof labourRateSchema>;
export type LabourRatesResponse = z.infer<typeof labourRatesResponseSchema>;
export type CreateLabourRateRequest = z.input<typeof createLabourRateRequestSchema>;
export type CreateLabourRateInput = z.output<typeof createLabourRateRequestSchema>;
export type ResolvedRateResponse = z.infer<typeof resolvedRateResponseSchema>;
export type RegisterLabourerRequest = z.input<typeof registerLabourerRequestSchema>;
export type RegisterLabourerInput = z.output<typeof registerLabourerRequestSchema>;
export type UpdateLabourerRequest = z.input<typeof updateLabourerRequestSchema>;
export type UpdateLabourerInput = z.output<typeof updateLabourerRequestSchema>;
export type LabourerStatusRequest = z.input<typeof labourerStatusRequestSchema>;
export type RevealRequest = z.input<typeof revealRequestSchema>;
export type RevealResponse = z.infer<typeof revealResponseSchema>;
export type DoNotRehireRequest = z.input<typeof doNotRehireRequestSchema>;
export type CreateEngagementRequest = z.input<typeof createEngagementRequestSchema>;
export type EndEngagementRequest = z.input<typeof endEngagementRequestSchema>;
export type CreateAccreditationRequest = z.input<typeof createAccreditationRequestSchema>;
export type UpdateAccreditationRequest = z.input<typeof updateAccreditationRequestSchema>;
export type ConsentCapture = z.input<typeof consentCaptureSchema>;
export type WithdrawConsentRequest = z.input<typeof withdrawConsentRequestSchema>;
export type LabourerSummary = z.infer<typeof labourerSummarySchema>;
export type LabourersResponse = z.infer<typeof labourersResponseSchema>;
export type LabourerDetail = z.infer<typeof labourerDetailSchema>;
export type LabourerResponse = z.infer<typeof labourerResponseSchema>;
export type LabourerWarning = z.infer<typeof labourerWarningSchema>;
export type LabourerMatch = z.infer<typeof labourerMatchSchema>;
export type AccreditationRecord = z.infer<typeof accreditationSchema>;
export type ConsentRecord = z.infer<typeof consentRecordSchema>;
export type Engagement = z.infer<typeof engagementSchema>;
export type AccreditationAlert = z.infer<typeof accreditationAlertSchema>;
export type AccreditationAlertsResponse = z.infer<typeof accreditationAlertsResponseSchema>;
export type Gang = z.infer<typeof gangSchema>;
export type GangsResponse = z.infer<typeof gangsResponseSchema>;
export type GangMember = z.infer<typeof gangMemberSchema>;
export type GangDetailResponse = z.infer<typeof gangDetailResponseSchema>;
export type CreateGangRequest = z.input<typeof createGangRequestSchema>;
export type UpdateGangRequest = z.input<typeof updateGangRequestSchema>;
export type LabourViewFilters = z.infer<typeof labourViewFiltersSchema>;
export type LabourView = z.infer<typeof labourViewSchema>;
export type LabourViewsResponse = z.infer<typeof labourViewsResponseSchema>;
