import {
  BODY_PARTS,
  CERTIFICATE_STATES,
  CORRECTIVE_ACTION_ACTIONS,
  CORRECTIVE_ACTION_SOURCES,
  CORRECTIVE_ACTION_STATUSES,
  FIRST_AID_KIT_STATUSES,
  FIRST_AID_REFERRALS,
  FIRST_AID_TREATMENTS,
  FIRST_AIDER_STATUSES,
  INCIDENT_KINDS,
  INCIDENT_PERSON_ROLES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INDUCTION_ACKNOWLEDGEMENTS,
  INDUCTION_PERSON_KINDS,
  INDUCTION_STATES,
  INDUCTION_STATUSES,
  INJURY_TYPES,
  KIT_CHECK_OUTCOMES,
  KIT_STATES,
  PPE_ISSUE_STATUSES,
  PPE_ITEMS,
  PPE_REPLACEMENT_STATES,
  PPE_RETURN_CONDITIONS,
  REGULATOR_DECISIONS,
  REGULATOR_STATES,
  ROOT_CAUSE_CATEGORIES,
  SAFETY_LIMITS,
  SAFETY_SETTINGS_LIMITS,
  STARTER_INDUCTION_TOPICS,
  TOOLBOX_TALK_ACTIONS,
  TOOLBOX_TALK_STATUSES,
  TREATMENT_STATUSES,
  type PpeItem,
} from "@pm-buddy/types";
import { z } from "zod";
import { planningDateSchema } from "./primitives.js";

/**
 * Health and safety (D8.2): inductions, toolbox talks, the PPE register, incidents and near misses
 * with investigation and the regulator decision, corrective actions, first-aid kits, first-aiders
 * and treatments, and the company settings. Requests are strict (a body never carries a tenant or
 * project ID); responses are strict so the web never trusts an unexpected shape. Dates are business
 * dates (YYYY-MM-DD, Africa/Nairobi). Personal and injury details are null in responses for callers
 * without safety.manage (decision D-74).
 */

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();
const version = z.number().int().min(1).max(2_147_483_647);
const person = z.strictObject({ id: uuid, displayName: z.string() });
const count = z.number().int().min(0);

/** Characters as PostgreSQL's char_length counts them (code points), not UTF-16 units. */
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
/** Keyset cursor: the record number to continue below. */
const numberCursor = z.coerce.number().int().min(1).optional();
/** Offset cursor for lists ordered by a computed rank (overdue first, due first). */
const offsetCursor = z.coerce.number().int().min(0).max(100_000).optional();
const limit = z.coerce.number().int().min(1).max(SAFETY_LIMITS.maxPageSize).default(30);
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

export const incidentKindSchema = z.enum(INCIDENT_KINDS);
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES);
export const correctiveActionStatusSchema = z.enum(CORRECTIVE_ACTION_STATUSES);
export const ppeItemSchema = z.enum(PPE_ITEMS);

/** A labourer as the safety screens show them (registry number and name only). */
export const safetyLabourerSchema = z.strictObject({
  id: uuid,
  workerNo: z.string(),
  fullName: z.string(),
});
export type SafetyLabourer = z.infer<typeof safetyLabourerSchema>;
/** A linked site photo (thumbnails come from the photos endpoint). */
export const safetyPhotoSchema = z.strictObject({
  id: uuid,
  verified: z.boolean(),
  caption: z.string().nullable(),
});
const recordRef = z.strictObject({ id: uuid, code: z.string() });

// Settings --------------------------------------------------------------------------------------

const topicKey = z.string().regex(/^[a-z0-9_]{2,40}$/, "invalid_topic_key");
export const inductionTopicSchema = z.strictObject({
  key: topicKey,
  /** Null for a starter topic (translated on screen); the company's own wording otherwise. */
  label: text(2, SAFETY_SETTINGS_LIMITS.topicLabelChars).nullable(),
});
const ppeDays = z
  .number()
  .int()
  .min(SAFETY_SETTINGS_LIMITS.ppeReplacementDays.min)
  .max(SAFETY_SETTINGS_LIMITS.ppeReplacementDays.max);
const ppeReplacementDays = z.strictObject(
  Object.fromEntries(PPE_ITEMS.map((item) => [item, ppeDays])) as Record<PpeItem, typeof ppeDays>,
);
const settingsValues = {
  inductionTopics: z
    .array(inductionTopicSchema)
    .min(SAFETY_SETTINGS_LIMITS.inductionTopics.min)
    .max(SAFETY_SETTINGS_LIMITS.inductionTopics.max),
  /** Null: inductions do not expire. */
  inductionValidityDays: z
    .number()
    .int()
    .min(SAFETY_SETTINGS_LIMITS.inductionValidityDays.min)
    .max(SAFETY_SETTINGS_LIMITS.inductionValidityDays.max)
    .nullable(),
  inductionLookbackDays: z
    .number()
    .int()
    .min(SAFETY_SETTINGS_LIMITS.inductionLookbackDays.min)
    .max(SAFETY_SETTINGS_LIMITS.inductionLookbackDays.max),
  kitCheckIntervalDays: z
    .number()
    .int()
    .min(SAFETY_SETTINGS_LIMITS.kitCheckIntervalDays.min)
    .max(SAFETY_SETTINGS_LIMITS.kitCheckIntervalDays.max),
  ppeReplacementDays,
};
const starterTopics = new Set<string>(STARTER_INDUCTION_TOPICS);
export const updateSafetySettingsRequestSchema = z
  .strictObject({ ...settingsValues, version: z.number().int().min(0).max(2_147_483_647) })
  .superRefine((value, ctx) => {
    const keys = value.inductionTopics.map((topic) => topic.key);
    if (!uniqueIds(keys))
      ctx.addIssue({ code: "custom", path: ["inductionTopics"], message: "duplicate_topic" });
    value.inductionTopics.forEach((topic, index) => {
      if (topic.label === null && !starterTopics.has(topic.key))
        ctx.addIssue({
          code: "custom",
          path: ["inductionTopics", index, "label"],
          message: "label_required",
        });
    });
  });
export const safetySettingsSchema = z.strictObject({
  ...settingsValues,
  /** 0 while the company uses the defaults. */
  version: z.number().int().min(0),
  updatedAt: timestamp.nullable(),
  permissions: z.strictObject({ canEdit: z.boolean() }),
});
export const safetySettingsResponseSchema = z.strictObject({ settings: safetySettingsSchema });

// Summary, options and the company overview ----------------------------------------------------

const safetyPermissions = z.strictObject({
  /** Record inductions, talks, PPE, incidents (report), treatments and kit checks. */
  canRecord: z.boolean(),
  /** Investigate, raise and verify actions, close incidents, manage first aid (safety.manage). */
  canManage: z.boolean(),
  /** See people and injury details on incidents and treatments (safety.manage). */
  canSeePersonal: z.boolean(),
});
export const safetySummaryResponseSchema = z.strictObject({
  incidents: z.strictObject({
    reported: count,
    investigated: count,
    regulatorPending: count,
    last90Days: count,
    nearMissesLast90Days: count,
  }),
  actions: z.strictObject({ open: count, overdue: count, awaitingVerification: count }),
  /** Labourers who worked at a site in the look-back window without a valid induction there. */
  inductions: z.strictObject({ flagged: count, lookbackDays: z.number().int().min(1) }),
  talks: z.strictObject({ draft: count, last30Days: count }),
  ppe: z.strictObject({ due: count, dueSoon: count }),
  firstAid: z.strictObject({ kitsAttention: count, certificatesExpired: count }),
  permissions: safetyPermissions,
});
/** People and gangs for the forms: staff who can read safety records, and the project's gangs. */
export const safetyOptionsResponseSchema = z.strictObject({
  staff: z.array(person.extend({ canRecord: z.boolean(), canManage: z.boolean() }).strict()),
  gangs: z.array(
    z.strictObject({ id: uuid, name: z.string(), siteId: uuid.nullable(), members: count }),
  ),
  inductionTopics: z.array(inductionTopicSchema),
});
export const safetyOverviewResponseSchema = z.strictObject({
  projects: z.array(
    z.strictObject({
      id: uuid,
      code: z.string(),
      name: z.string(),
      status: z.string(),
      openIncidents: count,
      overdueActions: count,
      flaggedLabourers: count,
      ppeDue: count,
      kitsAttention: count,
    }),
  ),
});

// Inductions ------------------------------------------------------------------------------------

export const createInductionRequestSchema = z
  .strictObject({
    siteId: uuid,
    personKind: z.enum(INDUCTION_PERSON_KINDS),
    labourerId: uuid.optional(),
    userId: uuid.optional(),
    visitorName: text(2, 120).optional(),
    visitorOrganisation: optionalText(120).optional().default(null),
    inductedOn: planningDateSchema,
    inductorId: uuid,
    /** Keys of the company's current checklist topics that were covered. */
    topics: z.array(topicKey).min(1).max(SAFETY_SETTINGS_LIMITS.inductionTopics.max),
    acknowledgement: z.enum(INDUCTION_ACKNOWLEDGEMENTS),
    notes: optionalText(500, true).optional().default(null),
  })
  .superRefine((value, ctx) => {
    const given = {
      labourer: value.labourerId !== undefined,
      staff: value.userId !== undefined,
      visitor: value.visitorName !== undefined,
    };
    for (const kind of INDUCTION_PERSON_KINDS)
      if (given[kind] !== (value.personKind === kind))
        ctx.addIssue({ code: "custom", path: ["personKind"], message: "person_mismatch" });
    if (value.personKind !== "visitor" && value.visitorOrganisation)
      ctx.addIssue({ code: "custom", path: ["visitorOrganisation"], message: "visitor_only" });
    if (!uniqueIds(value.topics))
      ctx.addIssue({ code: "custom", path: ["topics"], message: "duplicate_topic" });
  });
export const voidRequestSchema = z.strictObject({ version, reason });
export const inductionsQuerySchema = z.strictObject({
  siteId: uuid.optional(),
  personKind: z.enum(INDUCTION_PERSON_KINDS).optional(),
  status: z.enum(INDUCTION_STATUSES).optional(),
  search,
  cursor: numberCursor,
  limit,
});
export const inductionSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  personKind: z.enum(INDUCTION_PERSON_KINDS),
  labourer: safetyLabourerSchema.nullable(),
  staff: person.nullable(),
  visitorName: z.string().nullable(),
  visitorOrganisation: z.string().nullable(),
  inductedOn: calendarDate,
  /** Last day it counts (null: no expiry). */
  validUntil: calendarDate.nullable(),
  /** Today's state of this induction (voided ones are `none`). */
  state: z.enum(INDUCTION_STATES),
  inductor: person,
  topics: z.array(inductionTopicSchema),
  /** Topics on the company checklist when it was recorded. */
  topicsTotal: count,
  acknowledgement: z.enum(INDUCTION_ACKNOWLEDGEMENTS),
  notes: z.string().nullable(),
  status: z.enum(INDUCTION_STATUSES),
  recordedBy: person,
  recordedAt: timestamp,
  voidedBy: person.nullable(),
  voidedAt: timestamp.nullable(),
  voidReason: z.string().nullable(),
  version,
  permissions: z.strictObject({ canVoid: z.boolean() }),
});
export const inductionResponseSchema = z.strictObject({ induction: inductionSchema });
export const inductionsResponseSchema = z.strictObject({
  inductions: z.array(inductionSchema),
  nextCursor: z.number().int().min(1).nullable(),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

/** Induction status per labourer at one site, with the attendance flags (decision D-71). */
export const inductionStatusQuerySchema = z.strictObject({
  siteId: uuid,
  /** `flagged`: worked at the site in the look-back window without a valid induction. */
  filter: z.enum(["all", "not_inducted", "flagged"]).optional().default("all"),
  search,
  cursor: offsetCursor,
  limit: z.coerce.number().int().min(1).max(SAFETY_LIMITS.maxPageSize).default(50),
});
export const inductionStatusRowSchema = z.strictObject({
  labourer: safetyLabourerSchema,
  gang: z.strictObject({ id: uuid, name: z.string() }).nullable(),
  state: z.enum(INDUCTION_STATES),
  inductedOn: calendarDate.nullable(),
  validUntil: calendarDate.nullable(),
  /** Days in the look-back window worked at this site without a valid induction (newest first). */
  uninductedDays: z.array(calendarDate),
  flagged: z.boolean(),
});
export const inductionStatusResponseSchema = z.strictObject({
  siteId: uuid,
  lookbackDays: z.number().int().min(1),
  from: calendarDate,
  rows: z.array(inductionStatusRowSchema),
  nextCursor: z.number().int().min(0).nullable(),
  counts: z.strictObject({
    labourers: count,
    valid: count,
    expired: count,
    none: count,
    flagged: count,
  }),
});

// Toolbox talks ---------------------------------------------------------------------------------

const talkContent = {
  heldOn: planningDateSchema,
  topic: text(3, 200),
  notes: optionalText(2000, true).optional().default(null),
  durationMinutes: z.number().int().min(5).max(240).nullable().optional().default(null),
  presenterId: uuid,
  photoId: uuid.nullable().optional().default(null),
  otherAttendees: z
    .number()
    .int()
    .min(0)
    .max(SAFETY_LIMITS.maxOtherAttendees)
    .optional()
    .default(0),
  /** Every member of these gangs on the day attends (merged with the picked labourers). */
  gangIds: z.array(uuid).max(20).optional().default([]),
  labourerIds: z.array(uuid).max(SAFETY_LIMITS.maxTalkAttendees).optional().default([]),
};
const talkRefine = (value: { gangIds: string[]; labourerIds: string[] }, ctx: z.RefinementCtx) => {
  if (!uniqueIds(value.gangIds))
    ctx.addIssue({ code: "custom", path: ["gangIds"], message: "duplicate_gang" });
  if (!uniqueIds(value.labourerIds))
    ctx.addIssue({ code: "custom", path: ["labourerIds"], message: "duplicate_labourer" });
};
export const createToolboxTalkRequestSchema = z
  .strictObject({
    siteId: uuid,
    ...talkContent,
    /** Confirm (and lock) at once instead of saving a draft. */
    confirm: z.boolean().optional().default(false),
  })
  .superRefine(talkRefine);
export const updateToolboxTalkRequestSchema = z
  .strictObject({ version, ...talkContent })
  .superRefine(talkRefine);
export const toolboxTalkActionRequestSchema = z
  .strictObject({ version, action: z.enum(TOOLBOX_TALK_ACTIONS), reason: reason.optional() })
  .superRefine((value, ctx) => {
    if (value.action === "cancel" && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (value.action !== "cancel" && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
  });
export const toolboxTalksQuerySchema = z.strictObject({
  siteId: uuid.optional(),
  status: z.enum(TOOLBOX_TALK_STATUSES).optional(),
  search,
  cursor: numberCursor,
  limit,
});
export const toolboxTalkSummarySchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  heldOn: calendarDate,
  topic: z.string(),
  notes: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  presenter: person,
  photo: safetyPhotoSchema.nullable(),
  otherAttendees: count,
  /** Registered labourers who attended. */
  attendeeCount: count,
  status: z.enum(TOOLBOX_TALK_STATUSES),
  createdBy: person,
  createdAt: timestamp,
  confirmedBy: person.nullable(),
  confirmedAt: timestamp.nullable(),
  cancelledBy: person.nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  version,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canConfirm: z.boolean(),
    canCancel: z.boolean(),
    canRaiseAction: z.boolean(),
  }),
});
export const toolboxTalkSchema = toolboxTalkSummarySchema.extend({
  attendees: z.array(
    z.strictObject({
      labourer: safetyLabourerSchema,
      gang: z.strictObject({ id: uuid, name: z.string() }).nullable(),
    }),
  ),
});
export const toolboxTalkResponseSchema = z.strictObject({ talk: toolboxTalkSchema });
export const toolboxTalksResponseSchema = z.strictObject({
  talks: z.array(toolboxTalkSummarySchema),
  nextCursor: z.number().int().min(1).nullable(),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

// PPE register ----------------------------------------------------------------------------------

export const issuePpeRequestSchema = z.strictObject({
  siteId: uuid,
  labourerId: uuid,
  item: ppeItemSchema,
  size: optionalText(12).optional().default(null),
  quantity: z.number().int().min(1).max(SAFETY_LIMITS.maxPpeQuantity),
  issuedOn: planningDateSchema,
  /** The issue this one replaces (still with the same labourer). */
  replacesIssueId: uuid.optional(),
});
export const returnPpeRequestSchema = z.strictObject({
  version,
  returnedOn: planningDateSchema,
  condition: z.enum(PPE_RETURN_CONDITIONS),
});
export const ppeQuerySchema = z.strictObject({
  siteId: uuid.optional(),
  labourerId: uuid.optional(),
  item: ppeItemSchema.optional(),
  /** `due`: still issued and due (or due soon) for replacement. */
  status: z.enum([...PPE_ISSUE_STATUSES, "due"]).optional(),
  search,
  cursor: offsetCursor,
  limit,
});
export const ppeIssueSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  labourer: safetyLabourerSchema,
  item: ppeItemSchema,
  size: z.string().nullable(),
  quantity: z.number().int().min(1),
  issuedOn: calendarDate,
  replacementDueOn: calendarDate,
  /** Null once returned, replaced or voided. */
  replacementState: z.enum(PPE_REPLACEMENT_STATES).nullable(),
  status: z.enum(PPE_ISSUE_STATUSES),
  returnedOn: calendarDate.nullable(),
  returnCondition: z.enum(PPE_RETURN_CONDITIONS).nullable(),
  replacesIssueId: uuid.nullable(),
  issuedBy: person,
  issuedAt: timestamp,
  returnedBy: person.nullable(),
  voidedBy: person.nullable(),
  voidedAt: timestamp.nullable(),
  voidReason: z.string().nullable(),
  version,
  permissions: z.strictObject({
    canReturn: z.boolean(),
    canReplace: z.boolean(),
    canVoid: z.boolean(),
  }),
});
export const ppeIssueResponseSchema = z.strictObject({ issue: ppeIssueSchema });
export const ppeIssuesResponseSchema = z.strictObject({
  issues: z.array(ppeIssueSchema),
  nextCursor: z.number().int().min(0).nullable(),
  counts: z.strictObject({ issued: count, due: count, dueSoon: count }),
  permissions: z.strictObject({ canIssue: z.boolean() }),
});

// Incidents -------------------------------------------------------------------------------------

export const incidentPersonInputSchema = z
  .strictObject({
    role: z.enum(INCIDENT_PERSON_ROLES),
    labourerId: uuid.optional(),
    userId: uuid.optional(),
    /** Someone not registered (a visitor or a member of the public): a name only. */
    name: text(2, 120).optional(),
    injuryType: z.enum(INJURY_TYPES).optional(),
    bodyPart: z.enum(BODY_PARTS).optional(),
  })
  .superRefine((value, ctx) => {
    const given = [value.labourerId, value.userId, value.name].filter(
      (entry) => entry !== undefined,
    );
    if (given.length !== 1)
      ctx.addIssue({ code: "custom", path: ["name"], message: "one_person_reference" });
    const injured = value.role === "injured";
    if (injured !== (value.injuryType !== undefined) || injured !== (value.bodyPart !== undefined))
      ctx.addIssue({ code: "custom", path: ["injuryType"], message: "injury_for_injured_only" });
  });
const peopleList = z
  .array(incidentPersonInputSchema)
  .max(SAFETY_LIMITS.maxIncidentPeople)
  .superRefine((people, ctx) => {
    const keys = people.map(
      (entry) => `${entry.role}:${entry.labourerId ?? entry.userId ?? entry.name?.toLowerCase()}`,
    );
    if (!uniqueIds(keys)) ctx.addIssue({ code: "custom", message: "duplicate_person" });
  });
const incidentRefine = (
  value: {
    kind?: (typeof INCIDENT_KINDS)[number];
    people?: z.infer<typeof incidentPersonInputSchema>[];
  },
  ctx: z.RefinementCtx,
) => {
  if (!value.kind || !value.people) return;
  const injured = value.people.some((entry) => entry.role === "injured");
  if (value.kind === "injury" && !injured)
    ctx.addIssue({ code: "custom", path: ["people"], message: "injured_person_required" });
  if (value.kind === "near_miss" && injured)
    ctx.addIssue({ code: "custom", path: ["people"], message: "near_miss_without_injury" });
};
const incidentContent = {
  kind: incidentKindSchema,
  severity: incidentSeveritySchema,
  /** When it happened (sent with the Nairobi offset); never in the future. */
  occurredAt: timestamp,
  location: text(2, 200),
  description: text(10, 2000, true),
  immediateActions: optionalText(2000, true).optional().default(null),
  firstAidGiven: z.boolean(),
  people: peopleList,
};
export const reportIncidentRequestSchema = z
  .strictObject({
    siteId: uuid,
    ...incidentContent,
    photoIds: z.array(uuid).max(SAFETY_LIMITS.maxIncidentPhotos).optional().default([]),
    /** A closed incident this report follows up (a finding after closure is a new incident). */
    followUpOfId: uuid.optional(),
  })
  .superRefine((value, ctx) => {
    incidentRefine(value, ctx);
    if (!uniqueIds(value.photoIds))
      ctx.addIssue({ code: "custom", path: ["photoIds"], message: "duplicate_photo" });
  });
export const updateIncidentRequestSchema = z
  .strictObject({
    version,
    kind: incidentKindSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    occurredAt: timestamp.optional(),
    location: text(2, 200).optional(),
    description: text(10, 2000, true).optional(),
    immediateActions: optionalText(2000, true).optional(),
    firstAidGiven: z.boolean().optional(),
    /** Replaces the people listed (only for safety.manage, who can see them). */
    people: peopleList.optional(),
  })
  .superRefine(incidentRefine);
export const investigateIncidentRequestSchema = z.strictObject({
  version,
  rootCauseCategory: z.enum(ROOT_CAUSE_CATEGORIES),
  rootCause: text(10, 2000, true),
  contributingFactors: optionalText(2000, true).optional().default(null),
});
export const regulatorDecisionRequestSchema = z
  .strictObject({
    version,
    decision: z.enum(REGULATOR_DECISIONS),
    notifiedOn: planningDateSchema.optional(),
    reference: optionalText(60).optional(),
    reason: reason.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "notified" && !value.notifiedOn)
      ctx.addIssue({ code: "custom", path: ["notifiedOn"], message: "date_required" });
    if (value.decision === "notified" && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
    if (value.decision === "not_notifiable" && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (
      value.decision === "not_notifiable" &&
      (value.notifiedOn !== undefined || value.reference !== undefined)
    )
      ctx.addIssue({ code: "custom", path: ["notifiedOn"], message: "notified_only" });
  });
export const closeIncidentRequestSchema = z.strictObject({
  version,
  closureNote: optionalText(1000, true).optional().default(null),
  /** Why no corrective action was needed (required when none was verified). */
  noActionReason: optionalText(500, true).optional().default(null),
});
export const addIncidentPhotosRequestSchema = z
  .strictObject({ version, photoIds: z.array(uuid).min(1).max(SAFETY_LIMITS.maxIncidentPhotos) })
  .superRefine((value, ctx) => {
    if (!uniqueIds(value.photoIds))
      ctx.addIssue({ code: "custom", path: ["photoIds"], message: "duplicate_photo" });
  });
export const incidentsQuerySchema = z.strictObject({
  siteId: uuid.optional(),
  kind: incidentKindSchema.optional(),
  /** `open`: reported or investigated. */
  status: z.enum([...INCIDENT_STATUSES, "open"]).optional(),
  search,
  cursor: numberCursor,
  limit,
});

export const incidentPersonSchema = z.strictObject({
  id: uuid,
  role: z.enum(INCIDENT_PERSON_ROLES),
  labourer: safetyLabourerSchema.nullable(),
  staff: person.nullable(),
  name: z.string().nullable(),
  injuryType: z.enum(INJURY_TYPES).nullable(),
  bodyPart: z.enum(BODY_PARTS).nullable(),
});
export const incidentCloseBlockerSchema = z.enum([
  "not_investigated",
  "actions_outstanding",
  "no_verified_action",
  "regulator_decision_required",
]);
export const incidentSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  siteId: uuid,
  siteName: z.string(),
  number: z.number().int().min(1),
  code: z.string(),
  kind: incidentKindSchema,
  severity: incidentSeveritySchema,
  occurredAt: timestamp,
  location: z.string(),
  description: z.string(),
  immediateActions: z.string().nullable(),
  firstAidGiven: z.boolean(),
  /** Null for callers without safety.manage (decision D-74); the counts are always shown. */
  people: z.array(incidentPersonSchema).nullable(),
  peopleCounts: z.strictObject({ injured: count, involved: count, witness: count }),
  photos: z.array(safetyPhotoSchema),
  status: incidentStatusSchema,
  reportedBy: person,
  reportedAt: timestamp,
  investigation: z
    .strictObject({
      rootCauseCategory: z.enum(ROOT_CAUSE_CATEGORIES),
      rootCause: z.string(),
      contributingFactors: z.string().nullable(),
      investigatedBy: person,
      investigatedAt: timestamp,
    })
    .nullable(),
  regulator: z.strictObject({
    state: z.enum(REGULATOR_STATES),
    notifiedOn: calendarDate.nullable(),
    reference: z.string().nullable(),
    reason: z.string().nullable(),
    decidedBy: person.nullable(),
    decidedAt: timestamp.nullable(),
  }),
  actionCounts: z.strictObject({
    open: count,
    overdue: count,
    done: count,
    verified: count,
    cancelled: count,
  }),
  /** Why it cannot close yet (empty once closable or no longer open). */
  closeBlockers: z.array(incidentCloseBlockerSchema),
  closedBy: person.nullable(),
  closedAt: timestamp.nullable(),
  closureNote: z.string().nullable(),
  noActionReason: z.string().nullable(),
  voidedBy: person.nullable(),
  voidedAt: timestamp.nullable(),
  voidReason: z.string().nullable(),
  followUpOf: recordRef.nullable(),
  version,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canInvestigate: z.boolean(),
    canDecideRegulator: z.boolean(),
    canClose: z.boolean(),
    canVoid: z.boolean(),
    canAddPhotos: z.boolean(),
    canRaiseAction: z.boolean(),
    canSeePeople: z.boolean(),
  }),
});
export const incidentsResponseSchema = z.strictObject({
  incidents: z.array(incidentSchema),
  nextCursor: z.number().int().min(1).nullable(),
  counts: z.strictObject({
    reported: count,
    investigated: count,
    closed: count,
    regulatorPending: count,
  }),
  permissions: z.strictObject({ canReport: z.boolean() }),
});

// Corrective actions ----------------------------------------------------------------------------

export const createCorrectiveActionRequestSchema = z
  .strictObject({
    source: z.enum(CORRECTIVE_ACTION_SOURCES),
    incidentId: uuid.optional(),
    inspectionId: uuid.optional(),
    toolboxTalkId: uuid.optional(),
    description: text(5, 1000, true),
    ownerId: uuid,
    dueOn: planningDateSchema,
  })
  .superRefine((value, ctx) => {
    const refs = {
      incident: value.incidentId,
      inspection: value.inspectionId,
      toolbox_talk: value.toolboxTalkId,
    };
    for (const [source, id] of Object.entries(refs))
      if ((id !== undefined) !== (value.source === source))
        ctx.addIssue({ code: "custom", path: ["source"], message: "source_mismatch" });
  });
export const updateCorrectiveActionRequestSchema = z.strictObject({
  version,
  description: text(5, 1000, true).optional(),
  ownerId: uuid.optional(),
  dueOn: planningDateSchema.optional(),
});
export const correctiveActionActionRequestSchema = z
  .strictObject({
    version,
    action: z.enum(CORRECTIVE_ACTION_ACTIONS),
    /** What was done (done only, optional). */
    note: text(3, 1000, true).optional(),
    reason: reason.optional(),
  })
  .superRefine((value, ctx) => {
    const needsReason = value.action === "reject" || value.action === "cancel";
    if (needsReason && !value.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_required" });
    if (!needsReason && value.reason !== undefined)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_not_allowed" });
    if (value.action !== "done" && value.note !== undefined)
      ctx.addIssue({ code: "custom", path: ["note"], message: "done_only" });
  });
export const correctiveActionsQuerySchema = z.strictObject({
  /** `active`: open or done; `overdue`: open past the due date. */
  status: z.enum([...CORRECTIVE_ACTION_STATUSES, "active", "overdue"]).optional(),
  incidentId: uuid.optional(),
  /** Only the caller's own actions. */
  mine: z.enum(["true", "false"]).optional(),
  search,
  cursor: offsetCursor,
  limit,
});
export const correctiveActionSchema = z.strictObject({
  id: uuid,
  projectId: uuid,
  number: z.number().int().min(1),
  code: z.string(),
  source: z.enum(CORRECTIVE_ACTION_SOURCES),
  incident: recordRef.nullable(),
  inspection: recordRef.nullable(),
  toolboxTalk: recordRef.nullable(),
  description: z.string(),
  owner: person,
  dueOn: calendarDate,
  overdue: z.boolean(),
  daysOverdue: z.number().int().min(1).nullable(),
  status: correctiveActionStatusSchema,
  doneBy: person.nullable(),
  doneAt: timestamp.nullable(),
  doneNote: z.string().nullable(),
  verifiedBy: person.nullable(),
  verifiedAt: timestamp.nullable(),
  rejectCount: count,
  lastRejectReason: z.string().nullable(),
  cancelledBy: person.nullable(),
  cancelledAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  raisedBy: person,
  raisedAt: timestamp,
  version,
  permissions: z.strictObject({
    canEdit: z.boolean(),
    canMarkDone: z.boolean(),
    canVerify: z.boolean(),
    canReject: z.boolean(),
    canCancel: z.boolean(),
  }),
});
export const correctiveActionResponseSchema = z.strictObject({ action: correctiveActionSchema });
export const correctiveActionsResponseSchema = z.strictObject({
  actions: z.array(correctiveActionSchema),
  nextCursor: z.number().int().min(0).nullable(),
  counts: z.strictObject({ open: count, overdue: count, done: count, verified: count }),
  permissions: z.strictObject({ canCreate: z.boolean() }),
});

// First aid -------------------------------------------------------------------------------------

export const createFirstAidKitRequestSchema = z.strictObject({
  siteId: uuid,
  label: text(2, 80),
  location: optionalText(200).optional().default(null),
});
export const recordKitCheckRequestSchema = z.strictObject({
  checkedOn: planningDateSchema,
  outcome: z.enum(KIT_CHECK_OUTCOMES),
  /** The earliest expiry date of anything in the kit (null: nothing dated). */
  expiresOn: planningDateSchema.nullable(),
  notes: optionalText(500, true).optional().default(null),
});
export const addFirstAiderRequestSchema = z
  .strictObject({
    siteId: uuid,
    labourerId: uuid.optional(),
    userId: uuid.optional(),
    certificateExpiresOn: planningDateSchema,
    certificateReference: optionalText(60).optional().default(null),
  })
  .superRefine((value, ctx) => {
    if ((value.labourerId === undefined) === (value.userId === undefined))
      ctx.addIssue({ code: "custom", path: ["labourerId"], message: "one_person_reference" });
  });
export const recordTreatmentRequestSchema = z
  .strictObject({
    siteId: uuid,
    treatedAt: timestamp,
    labourerId: uuid.optional(),
    personName: text(2, 120).optional(),
    injuryType: z.enum(INJURY_TYPES),
    treatment: z.enum(FIRST_AID_TREATMENTS),
    referral: z.enum(FIRST_AID_REFERRALS),
    firstAiderId: uuid.optional(),
    incidentId: uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.labourerId === undefined) === (value.personName === undefined))
      ctx.addIssue({ code: "custom", path: ["labourerId"], message: "one_person_reference" });
  });
export const linkTreatmentRequestSchema = z.strictObject({ version, incidentId: uuid });
export const firstAidQuerySchema = z.strictObject({
  siteId: uuid.optional(),
  cursor: numberCursor,
  limit,
});

export const firstAidKitSchema = z.strictObject({
  id: uuid,
  siteId: uuid,
  siteName: z.string(),
  label: z.string(),
  location: z.string().nullable(),
  status: z.enum(FIRST_AID_KIT_STATUSES),
  lastCheck: z
    .strictObject({
      checkedOn: calendarDate,
      outcome: z.enum(KIT_CHECK_OUTCOMES),
      expiresOn: calendarDate.nullable(),
      notes: z.string().nullable(),
      checkedBy: person,
    })
    .nullable(),
  nextCheckOn: calendarDate.nullable(),
  state: z.enum(KIT_STATES),
  checkCount: count,
  retiredReason: z.string().nullable(),
  version,
  permissions: z.strictObject({ canCheck: z.boolean(), canRetire: z.boolean() }),
});
export const firstAiderSchema = z.strictObject({
  id: uuid,
  siteId: uuid,
  siteName: z.string(),
  labourer: safetyLabourerSchema.nullable(),
  staff: person.nullable(),
  certificateExpiresOn: calendarDate,
  certificateReference: z.string().nullable(),
  certificateState: z.enum(CERTIFICATE_STATES),
  status: z.enum(FIRST_AIDER_STATUSES),
  removedReason: z.string().nullable(),
  version,
  permissions: z.strictObject({ canRemove: z.boolean() }),
});
export const treatmentSchema = z.strictObject({
  id: uuid,
  number: z.number().int().min(1),
  code: z.string(),
  siteId: uuid,
  siteName: z.string(),
  treatedAt: timestamp,
  /** Who was treated and the injury: null without safety.manage (decision D-74). */
  labourer: safetyLabourerSchema.nullable(),
  personName: z.string().nullable(),
  injuryType: z.enum(INJURY_TYPES).nullable(),
  treatment: z.enum(FIRST_AID_TREATMENTS).nullable(),
  restricted: z.boolean(),
  referral: z.enum(FIRST_AID_REFERRALS),
  firstAider: z.strictObject({ id: uuid, displayName: z.string() }).nullable(),
  incident: recordRef.nullable(),
  status: z.enum(TREATMENT_STATUSES),
  recordedBy: person,
  recordedAt: timestamp,
  voidReason: z.string().nullable(),
  version,
  permissions: z.strictObject({ canVoid: z.boolean(), canLink: z.boolean() }),
});
export const firstAidKitResponseSchema = z.strictObject({ kit: firstAidKitSchema });
export const firstAiderResponseSchema = z.strictObject({ firstAider: firstAiderSchema });
export const treatmentResponseSchema = z.strictObject({ treatment: treatmentSchema });
export const firstAidResponseSchema = z.strictObject({
  kits: z.array(firstAidKitSchema),
  firstAiders: z.array(firstAiderSchema),
  treatments: z.array(treatmentSchema),
  nextCursor: z.number().int().min(1).nullable(),
  kitCheckIntervalDays: z.number().int().min(1),
  counts: z.strictObject({
    kitsAttention: count,
    certificatesExpired: count,
    treatmentsLast30Days: count,
  }),
  permissions: safetyPermissions,
});

export const incidentDetailResponseSchema = z.strictObject({
  incident: incidentSchema,
  correctiveActions: z.array(correctiveActionSchema),
  treatments: z.array(treatmentSchema),
});

export type SafetyPhoto = z.infer<typeof safetyPhotoSchema>;
export type SafetySettings = z.infer<typeof safetySettingsSchema>;
export type UpdateSafetySettingsRequest = z.infer<typeof updateSafetySettingsRequestSchema>;
export type SafetySummaryResponse = z.infer<typeof safetySummaryResponseSchema>;
export type SafetyOptionsResponse = z.infer<typeof safetyOptionsResponseSchema>;
export type SafetyOverviewResponse = z.infer<typeof safetyOverviewResponseSchema>;
export type CreateInductionRequest = z.infer<typeof createInductionRequestSchema>;
export type VoidRequest = z.infer<typeof voidRequestSchema>;
export type InductionsQuery = z.infer<typeof inductionsQuerySchema>;
export type Induction = z.infer<typeof inductionSchema>;
export type InductionsResponse = z.infer<typeof inductionsResponseSchema>;
export type InductionStatusQuery = z.infer<typeof inductionStatusQuerySchema>;
export type InductionStatusRow = z.infer<typeof inductionStatusRowSchema>;
export type InductionStatusResponse = z.infer<typeof inductionStatusResponseSchema>;
export type CreateToolboxTalkRequest = z.infer<typeof createToolboxTalkRequestSchema>;
export type UpdateToolboxTalkRequest = z.infer<typeof updateToolboxTalkRequestSchema>;
export type ToolboxTalkActionRequest = z.infer<typeof toolboxTalkActionRequestSchema>;
export type ToolboxTalksQuery = z.infer<typeof toolboxTalksQuerySchema>;
export type ToolboxTalkSummary = z.infer<typeof toolboxTalkSummarySchema>;
export type ToolboxTalk = z.infer<typeof toolboxTalkSchema>;
export type ToolboxTalksResponse = z.infer<typeof toolboxTalksResponseSchema>;
export type IssuePpeRequest = z.infer<typeof issuePpeRequestSchema>;
export type ReturnPpeRequest = z.infer<typeof returnPpeRequestSchema>;
export type PpeQuery = z.infer<typeof ppeQuerySchema>;
export type PpeIssue = z.infer<typeof ppeIssueSchema>;
export type PpeIssuesResponse = z.infer<typeof ppeIssuesResponseSchema>;
export type IncidentPersonInput = z.infer<typeof incidentPersonInputSchema>;
export type ReportIncidentRequest = z.infer<typeof reportIncidentRequestSchema>;
export type UpdateIncidentRequest = z.infer<typeof updateIncidentRequestSchema>;
export type InvestigateIncidentRequest = z.infer<typeof investigateIncidentRequestSchema>;
export type RegulatorDecisionRequest = z.infer<typeof regulatorDecisionRequestSchema>;
export type CloseIncidentRequest = z.infer<typeof closeIncidentRequestSchema>;
export type AddIncidentPhotosRequest = z.infer<typeof addIncidentPhotosRequestSchema>;
export type IncidentsQuery = z.infer<typeof incidentsQuerySchema>;
export type IncidentPerson = z.infer<typeof incidentPersonSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type IncidentsResponse = z.infer<typeof incidentsResponseSchema>;
export type IncidentDetailResponse = z.infer<typeof incidentDetailResponseSchema>;
export type CreateCorrectiveActionRequest = z.infer<typeof createCorrectiveActionRequestSchema>;
export type UpdateCorrectiveActionRequest = z.infer<typeof updateCorrectiveActionRequestSchema>;
export type CorrectiveActionActionRequest = z.infer<typeof correctiveActionActionRequestSchema>;
export type CorrectiveActionsQuery = z.infer<typeof correctiveActionsQuerySchema>;
export type CorrectiveAction = z.infer<typeof correctiveActionSchema>;
export type CorrectiveActionsResponse = z.infer<typeof correctiveActionsResponseSchema>;
export type CreateFirstAidKitRequest = z.infer<typeof createFirstAidKitRequestSchema>;
export type RecordKitCheckRequest = z.infer<typeof recordKitCheckRequestSchema>;
export type AddFirstAiderRequest = z.infer<typeof addFirstAiderRequestSchema>;
export type RecordTreatmentRequest = z.infer<typeof recordTreatmentRequestSchema>;
export type LinkTreatmentRequest = z.infer<typeof linkTreatmentRequestSchema>;
export type FirstAidQuery = z.infer<typeof firstAidQuerySchema>;
export type FirstAidKit = z.infer<typeof firstAidKitSchema>;
export type FirstAider = z.infer<typeof firstAiderSchema>;
export type Treatment = z.infer<typeof treatmentSchema>;
export type FirstAidResponse = z.infer<typeof firstAidResponseSchema>;
