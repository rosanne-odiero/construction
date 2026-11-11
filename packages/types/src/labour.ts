/**
 * Labour registry vocabulary shared by web, API and database (D3.1, brief §5.4). The database
 * CHECK constraints list the same keys, so adding a value needs a migration as well as a change
 * here.
 */

/**
 * Nobody under this age can be registered (brief §6 "Child labour"). Age is computed on the
 * registration date in Africa/Nairobi. A code and database constant (`labourers_minimum_age_check`),
 * not runtime configuration: it may only be raised, through a migration.
 * COMPLIANCE-REVIEW: CR-DP-10 (`labour.minimum_age_years`).
 */
export const MINIMUM_LABOURER_AGE_YEARS = 18;

export const LABOURER_STATUSES = ["active", "inactive", "left"] as const;
export type LabourerStatus = (typeof LABOURER_STATUSES)[number];

/** How the worker is engaged. Casual-to-term conversion rules: COMPLIANCE-REVIEW CR-PAY-10. */
export const ENGAGEMENT_TYPES = ["casual", "term", "piece_rate"] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

/** Time-based pay bases. Piece-rate jobs are priced per measured quantity (D4.1). */
export const RATE_BASES = ["daily", "hourly"] as const;
export type RateBasis = (typeof RATE_BASES)[number];

export const GENDERS = ["female", "male", "intersex", "undisclosed"] as const;
export type Gender = (typeof GENDERS)[number];

export const ID_DOCUMENT_TYPES = ["national_id", "alien_id", "passport"] as const;
export type IdDocumentType = (typeof ID_DOCUMENT_TYPES)[number];

/**
 * The NCA worker category a company skill level maps to (brief §5.4: skilled, semi-skilled,
 * unskilled; accreditation for skilled workers and site supervisors).
 * COMPLIANCE-REVIEW: CR-NCA-03 (which trades and roles need accreditation).
 */
export const NCA_CATEGORIES = ["skilled", "semi_skilled", "unskilled", "supervisor"] as const;
export type NcaCategory = (typeof NCA_CATEGORIES)[number];

/** National Construction Authority accreditation kinds. COMPLIANCE-REVIEW: CR-NCA-03. */
export const ACCREDITATION_CATEGORIES = ["nca_skilled_worker", "nca_site_supervisor"] as const;
export type AccreditationCategory = (typeof ACCREDITATION_CATEGORIES)[number];

/** A labourer's accreditation state on a day, given the company's alert lead time. */
export const ACCREDITATION_STATUSES = [
  "valid",
  "expiring",
  "expired",
  "missing",
  "not_required",
] as const;
export type AccreditationStatus = (typeof ACCREDITATION_STATUSES)[number];

/** Default lead time for NCA expiry alerts (`labour.accreditation_alert_days`, PRODUCT). */
export const DEFAULT_ACCREDITATION_ALERT_DAYS = 30;
export const ACCREDITATION_ALERT_DAYS_LIMITS = { min: 1, max: 365 } as const;

/**
 * Consent kinds. D3.1 records consent to process registration data. Biometric consent
 * (`biometric_face`, `biometric_fingerprint`) is the D3.4 extension point: it needs its own
 * notice, a DPIA gate and a migration widening `labourer_consents_kind_check`.
 */
export const CONSENT_KINDS = ["registration_data"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** How consent was captured: a signed paper form, or read aloud with a named witness. */
export const CONSENT_METHODS = ["signed", "witnessed_verbal"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const CONSENT_STATUSES = ["granted", "withdrawn", "missing"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/**
 * Versioned consent notices. The text lives in the EN/SW catalogues
 * (`labourConsentNotices.<messageKey>` in packages/i18n); `digests` pin the SHA-256 of that text in
 * each language, so changing a published notice fails the i18n tests until a new version is added.
 * The consent record stores the version, language and digest that were shown.
 * COMPLIANCE-REVIEW: CR-DP-03, CR-DP-11 (draft legal wording; professional Kiswahili review).
 */
export const CONSENT_NOTICE_VERSIONS = ["registration-2026-11-v1"] as const;
export type ConsentNoticeVersion = (typeof CONSENT_NOTICE_VERSIONS)[number];

export type ConsentNotice = {
  version: ConsentNoticeVersion;
  kind: ConsentKind;
  /** Key under `labourConsentNotices` in the EN/SW catalogues. */
  messageKey: string;
  effectiveFrom: string;
  /** SHA-256 (hex) of JSON.stringify(catalogue.labourConsentNotices[messageKey]) per language. */
  digests: { en: string; sw: string };
};

export const LABOUR_CONSENT_NOTICES: readonly ConsentNotice[] = [
  {
    version: "registration-2026-11-v1",
    kind: "registration_data",
    messageKey: "registrationV1",
    effectiveFrom: "2026-11-11",
    digests: {
      en: "3f0be44f63d204a5570ab4e6449573ec53662640892c72875c18de02fb27b992",
      sw: "6112d76bb466b5590716d81a8f2957d95cfe45963932fb9475a913bc61f83bcc",
    },
  },
];

/** The notice new registrations show (the latest version). */
export const CURRENT_CONSENT_NOTICE: ConsentNotice =
  LABOUR_CONSENT_NOTICES[LABOUR_CONSENT_NOTICES.length - 1]!;

export const consentNotice = (version: string): ConsentNotice | undefined =>
  LABOUR_CONSENT_NOTICES.find((notice) => notice.version === version);

/** Identifiers stored encrypted (brief §7 field-level encryption); revealing one is audited. */
export const SENSITIVE_LABOUR_FIELDS = [
  "idNumber",
  "phone",
  "kraPin",
  "nssfNumber",
  "shaNumber",
  "nextOfKin",
] as const;
export type SensitiveLabourField = (typeof SENSITIVE_LABOUR_FIELDS)[number];

/** Why a full value was revealed (recorded in the audit log instead of free text). */
export const REVEAL_PURPOSES = [
  "identity_verification",
  "payroll_setup",
  "statutory_filing",
  "emergency_contact",
  "data_subject_request",
] as const;
export type RevealPurpose = (typeof REVEAL_PURPOSES)[number];

export const GANG_STATUSES = ["active", "archived"] as const;
export type GangStatus = (typeof GANG_STATUSES)[number];

/** Registry views every user has; users add their own saved views (stored per user). */
export const BUILT_IN_LABOUR_VIEWS = ["all", "active", "attention", "doNotRehire"] as const;
export type BuiltInLabourView = (typeof BUILT_IN_LABOUR_VIEWS)[number];

/**
 * The standard trade list from brief §5.4, installed per company on request (each company can
 * rename, add or deactivate trades). Kiswahili names need a native-speaker review (Q-U2).
 */
export const DEFAULT_TRADES = [
  { key: "mason", nameEn: "Mason", nameSw: "Fundi mwashi" },
  { key: "carpenter", nameEn: "Carpenter", nameSw: "Seremala" },
  { key: "steel_fixer", nameEn: "Steel fixer", nameSw: "Fundi chuma" },
  { key: "plumber", nameEn: "Plumber", nameSw: "Fundi bomba" },
  { key: "electrician", nameEn: "Electrician", nameSw: "Fundi umeme" },
  { key: "painter", nameEn: "Painter", nameSw: "Mpaka rangi" },
  { key: "tiler", nameEn: "Tiler", nameSw: "Fundi vigae" },
  { key: "welder", nameEn: "Welder", nameSw: "Fundi wa kuchomelea" },
  { key: "plasterer", nameEn: "Plasterer", nameSw: "Fundi lipu" },
  { key: "roofer", nameEn: "Roofer", nameSw: "Fundi paa" },
  { key: "machine_operator", nameEn: "Machine/plant operator", nameSw: "Mwendeshaji mitambo" },
  { key: "foreman", nameEn: "Foreman", nameSw: "Msimamizi (foreman)" },
  { key: "general_labourer", nameEn: "General labourer (kibarua)", nameSw: "Kibarua" },
  { key: "watchman", nameEn: "Watchman", nameSw: "Mlinzi" },
  { key: "storekeeper", nameEn: "Storekeeper", nameSw: "Mtunza stoo" },
] as const;

/** Default skill levels aligned to the NCA categories. COMPLIANCE-REVIEW: CR-NCA-03. */
export const DEFAULT_SKILL_LEVELS = [
  {
    key: "skilled",
    nameEn: "Skilled",
    nameSw: "Mwenye ujuzi",
    ncaCategory: "skilled",
    accreditationExpected: true,
  },
  {
    key: "semi_skilled",
    nameEn: "Semi-skilled",
    nameSw: "Ujuzi wa kati",
    ncaCategory: "semi_skilled",
    accreditationExpected: false,
  },
  {
    key: "unskilled",
    nameEn: "Unskilled",
    nameSw: "Asiye na ujuzi",
    ncaCategory: "unskilled",
    accreditationExpected: false,
  },
  {
    key: "site_supervisor",
    nameEn: "Site supervisor",
    nameSw: "Msimamizi wa eneo la kazi",
    ncaCategory: "supervisor",
    accreditationExpected: true,
  },
] as const satisfies readonly {
  key: string;
  nameEn: string;
  nameSw: string;
  ncaCategory: NcaCategory;
  accreditationExpected: boolean;
}[];
