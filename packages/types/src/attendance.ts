/**
 * Attendance and timesheets (D3.3, web-only slice): capture methods, statuses, anomaly kinds, the
 * timesheet rule and period vocabularies, the Q-C3/Q-C4 demonstration values and the Kenyan public
 * holiday calendar used to seed companies. Every legal value here is COMPLIANCE-REVIEW material
 * (CR-PAY-08, CR-PAY-14): companies can change it, and unverified values cannot be approved for
 * production calculations.
 */

/**
 * How an attendance record was captured (brief §5.5: a pluggable capture method). Only
 * `web_manual` (a supervisor's entry on the web muster roll) is implemented in D3.3. The others
 * are reserved for the site app (QR/NFC card + photo, D3.3 site slice), kiosk face matching and
 * USB fingerprint scanners (D3.4) and standalone terminals; their evidence columns exist on
 * `attendance_records` but stay empty until those deliverables land.
 */
export const CAPTURE_METHODS = [
  "web_manual",
  "qr_card",
  "face",
  "fingerprint",
  "terminal",
] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];
export const IMPLEMENTED_CAPTURE_METHODS = [
  "web_manual",
] as const satisfies readonly CaptureMethod[];

/** Evidence each capture method will carry (null for `web_manual`, see ARCHITECTURE §13). */
export const CAPTURE_EVIDENCE_FIELDS = [
  "deviceId",
  "deviceTime",
  "serverReceivedAt",
  "latitude",
  "longitude",
  "accuracyM",
  "geofenceResult",
  "geofenceVersion",
  "matchConfidence",
  "photoFileId",
  "clientEventId",
] as const;
export type CaptureEvidenceField = (typeof CAPTURE_EVIDENCE_FIELDS)[number];
export const GEOFENCE_RESULTS = ["inside", "outside", "unknown"] as const;
export type GeofenceResult = (typeof GEOFENCE_RESULTS)[number];

/** A labourer's day on one site. Leave and sick days are recorded; payroll decides their pay. */
export const ATTENDANCE_STATUSES = ["present", "half_day", "absent", "leave", "sick"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
/** Statuses that carry check-in and check-out times and count as worked time. */
export const WORKED_ATTENDANCE_STATUSES = [
  "present",
  "half_day",
] as const satisfies readonly AttendanceStatus[];
export const isWorkedStatus = (status: AttendanceStatus): boolean =>
  (WORKED_ATTENDANCE_STATUSES as readonly AttendanceStatus[]).includes(status);

/** A muster sheet (project + site + date): recorded, submitted, then confirmed by someone else. */
export const ATTENDANCE_DAY_STATUSES = ["draft", "submitted", "confirmed"] as const;
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number];

/** A project's timesheet period: approved periods are locked and feed payroll (D4.1). */
export const TIMESHEET_PERIOD_STATUSES = ["open", "submitted", "rejected", "approved"] as const;
export type TimesheetPeriodStatus = (typeof TIMESHEET_PERIOD_STATUSES)[number];

/** Corrections (before approval) and adjustments (after approval) need a distinct decider. */
export const DECISION_STATUSES = ["pending", "approved", "rejected"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DAY_TYPES = ["weekday", "rest_day", "public_holiday"] as const;
export type DayType = (typeof DAY_TYPES)[number];

/**
 * Review signals, never automatic pay decisions (brief §15 E, CR-DP-09). Recording for a labourer
 * who is not engaged on the project that day is refused at entry; `not_engaged` catches records
 * that fall outside an engagement later (for example an engagement ended retroactively).
 */
export const ANOMALY_KINDS = [
  "two_sites",
  "overlapping_times",
  "excess_hours",
  "not_engaged",
  "labourer_inactive",
  "do_not_rehire",
  "accreditation_invalid",
  "manual_override",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export const ANOMALY_SEVERITIES = ["critical", "warning", "info"] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];
export const ANOMALY_SEVERITY: Readonly<Record<AnomalyKind, AnomalySeverity>> = {
  two_sites: "critical",
  overlapping_times: "critical",
  excess_hours: "warning",
  not_engaged: "critical",
  labourer_inactive: "warning",
  do_not_rehire: "critical",
  accreditation_invalid: "warning",
  manual_override: "info",
};
/** `cleared`: the system closed it because the condition no longer holds after a change. */
export const ANOMALY_STATUSES = ["open", "resolved", "dismissed", "cleared"] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];
export const ANOMALY_DECISIONS = ["resolve", "dismiss"] as const;
export type AnomalyDecision = (typeof ANOMALY_DECISIONS)[number];

/** Where a public holiday comes from: the Act's schedule, a Gazette notice, s.4 or the company. */
export const HOLIDAY_KINDS = ["statutory", "gazetted", "observed", "company"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

/** Legal values stay `unverified` until a named reviewer approves them (COMPLIANCE_TODO). */
export const RULE_COMPLIANCE_STATUSES = ["unverified", "approved"] as const;
export type RuleComplianceStatus = (typeof RULE_COMPLIANCE_STATUSES)[number];

/** Pay-period frequencies. Only weekly periods are implemented (Q-C4); the others are reserved. */
export const PERIOD_FREQUENCIES = ["weekly"] as const;
export type PeriodFrequency = (typeof PERIOD_FREQUENCIES)[number];

/** ISO weekdays: 1 = Monday … 7 = Sunday. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type IsoWeekday = (typeof ISO_WEEKDAYS)[number];

/** Bounds the API and the database apply to timesheet rule values (minutes unless stated). */
export const TIMESHEET_RULE_LIMITS = {
  normalMinutes: { min: 60, max: 720 },
  defaultBreakMinutes: { min: 0, max: 180 },
  breakAfterMinutes: { min: 0, max: 720 },
  dayStartMinutes: { min: 0, max: 1439 },
  lateGraceMinutes: { min: 0, max: 240 },
  halfDayThresholdMinutes: { min: 30, max: 720 },
  maxPlausibleMinutes: { min: 240, max: 1440 },
  multiplier: { min: "1.00", max: "5.00" },
} as const;

export type TimesheetRuleValues = {
  /** Normal (non-overtime) minutes on a weekday. */
  normalMinutes: number;
  /** Unpaid break deducted when the recorder enters none and the day is longer than below. */
  defaultBreakMinutes: number;
  breakAfterMinutes: number;
  /** Expected start (minutes after midnight); a check-in after start + grace counts as late. */
  dayStartMinutes: number;
  lateGraceMinutes: number;
  /** A worked day shorter than this counts as half a day for daily-rate pay. */
  halfDayThresholdMinutes: number;
  /** Anything longer is flagged `excess_hours` for review (never cut automatically). */
  maxPlausibleMinutes: number;
  restDays: IsoWeekday[];
  /** Overtime multipliers as decimal strings (applied by payroll, D4.1). */
  otWeekdayMultiplier: string;
  otRestDayMultiplier: string;
  otHolidayMultiplier: string;
};

/**
 * Demonstration values (QUESTIONS Q-C3: 8-hour day, overtime 1.5× on weekdays and 2.0× on rest
 * days and public holidays; CONFIGURATION `attendance.*`). COMPLIANCE-REVIEW: CR-PAY-08. They are
 * seeded as `unverified`: production approval of a period refuses unverified rules.
 */
export const DEMO_TIMESHEET_RULE: Readonly<TimesheetRuleValues> & { sourceReference: string } = {
  normalMinutes: 480,
  defaultBreakMinutes: 60,
  breakAfterMinutes: 300,
  dayStartMinutes: 420,
  lateGraceMinutes: 15,
  halfDayThresholdMinutes: 240,
  maxPlausibleMinutes: 720,
  restDays: [7],
  otWeekdayMultiplier: "1.50",
  otRestDayMultiplier: "2.00",
  otHolidayMultiplier: "2.00",
  sourceReference: "Demo values (QUESTIONS Q-C3); COMPLIANCE-REVIEW CR-PAY-08",
};

export type PeriodSettings = {
  frequency: PeriodFrequency;
  /** The last day of each weekly period (4 = Thursday). */
  weekEndsOn: IsoWeekday;
  /** Cut-off on the last day, minutes after midnight Africa/Nairobi (1080 = 18:00). */
  cutoffMinutes: number;
  /** Pay day shown to users (5 = Friday); payroll (D4.1) schedules payouts. */
  paydayWeekday: IsoWeekday;
};

/** QUESTIONS Q-C4 default: weekly, timesheets locked Thursday 18:00, Friday payout (PRODUCT). */
export const DEFAULT_PERIOD_SETTINGS: Readonly<PeriodSettings> = {
  frequency: "weekly",
  weekEndsOn: 4,
  cutoffMinutes: 1080,
  paydayWeekday: 5,
};

/** Overrides of a confirmed day need step-up MFA (CONFIGURATION `attendance.override.step_up`). */
export const ATTENDANCE_OVERRIDE_STEP_UP = true;

export type PublicHolidayEntry = {
  date: string;
  nameEn: string;
  nameSw: string;
  kind: Exclude<HolidayKind, "company">;
  source: string;
};

/** Citations for the calendar below (verified on 11/11/2026; legal review still required). */
export const KENYA_HOLIDAY_SOURCES = {
  act: "Public Holidays Act (Cap. 110) s.2 and Schedule Part I, Kenya Law revision 26/04/2024 (https://new.kenyalaw.org/akn/ke/act/1912/21/eng@2024-04-26); 10 October renamed Mazingira Day by the Statute Law (Miscellaneous Amendments) Act, 2024",
  sundayRule:
    "Public Holidays Act (Cap. 110) s.4: a Part I day falling on a Sunday moves to the first succeeding day that is not a public holiday",
  iddUlFitr2026:
    "Kenya Gazette special notice of 18/03/2026 (Public Holidays Act s.2(1)): Friday 20/03/2026, Idd-ul-Fitr; gazette notice number not independently verified",
  iddUlAdha2026:
    "Kenya Gazette Vol. 91 special issue of 25/05/2026 (https://kenyalaw.org/akn/ke/officialGazette/2026-05-25/90/eng@2026-05-25/source): Wednesday 27/05/2026, Idd-ul-Adha",
  election2027:
    "Constitution of Kenya Art. 101(1) (second Tuesday in August of every fifth year) and Public Holidays Act s.2(4): general election day 10/08/2027",
} as const;

const act = KENYA_HOLIDAY_SOURCES.act;
const sunday = KENYA_HOLIDAY_SOURCES.sundayRule;

/**
 * Kenyan public holidays for 2026 and 2027 (brief §5.5; COMPLIANCE-REVIEW CR-PAY-14). The 2026
 * moveable Idd holidays are the gazetted dates; Idd-ul-Fitr and Idd-ul-Adha 2027 depend on the moon
 * and are left out until gazetted (add them on the settings screen). Saturdays do not move; Sunday
 * holidays move to Monday (s.4) and are listed as `observed`.
 */
export const KENYA_PUBLIC_HOLIDAYS: readonly PublicHolidayEntry[] = [
  {
    date: "2026-01-01",
    nameEn: "New Year's Day",
    nameSw: "Siku ya Mwaka Mpya",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-03-20",
    nameEn: "Idd-ul-Fitr",
    nameSw: "Idd-ul-Fitr",
    kind: "gazetted",
    source: KENYA_HOLIDAY_SOURCES.iddUlFitr2026,
  },
  {
    date: "2026-04-03",
    nameEn: "Good Friday",
    nameSw: "Ijumaa Kuu",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-04-06",
    nameEn: "Easter Monday",
    nameSw: "Jumatatu ya Pasaka",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-05-01",
    nameEn: "Labour Day",
    nameSw: "Siku ya Wafanyakazi",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-05-27",
    nameEn: "Idd-ul-Adha",
    nameSw: "Idd-ul-Adha",
    kind: "gazetted",
    source: KENYA_HOLIDAY_SOURCES.iddUlAdha2026,
  },
  {
    date: "2026-06-01",
    nameEn: "Madaraka Day",
    nameSw: "Siku ya Madaraka",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-10-10",
    nameEn: "Mazingira Day",
    nameSw: "Siku ya Mazingira",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-10-20",
    nameEn: "Mashujaa Day",
    nameSw: "Siku ya Mashujaa",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-12-12",
    nameEn: "Jamhuri Day",
    nameSw: "Siku ya Jamhuri",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-12-25",
    nameEn: "Christmas Day",
    nameSw: "Siku ya Krismasi",
    kind: "statutory",
    source: act,
  },
  {
    date: "2026-12-26",
    nameEn: "Boxing Day",
    nameSw: "Siku ya Kutoa Zawadi",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-01-01",
    nameEn: "New Year's Day",
    nameSw: "Siku ya Mwaka Mpya",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-03-26",
    nameEn: "Good Friday",
    nameSw: "Ijumaa Kuu",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-03-29",
    nameEn: "Easter Monday",
    nameSw: "Jumatatu ya Pasaka",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-05-01",
    nameEn: "Labour Day",
    nameSw: "Siku ya Wafanyakazi",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-06-01",
    nameEn: "Madaraka Day",
    nameSw: "Siku ya Madaraka",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-08-10",
    nameEn: "General election day",
    nameSw: "Siku ya Uchaguzi Mkuu",
    kind: "statutory",
    source: KENYA_HOLIDAY_SOURCES.election2027,
  },
  {
    date: "2027-10-11",
    nameEn: "Mazingira Day (observed; 10 October is a Sunday)",
    nameSw: "Siku ya Mazingira (siku mbadala; 10 Oktoba ni Jumapili)",
    kind: "observed",
    source: sunday,
  },
  {
    date: "2027-10-20",
    nameEn: "Mashujaa Day",
    nameSw: "Siku ya Mashujaa",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-12-13",
    nameEn: "Jamhuri Day (observed; 12 December is a Sunday)",
    nameSw: "Siku ya Jamhuri (siku mbadala; 12 Desemba ni Jumapili)",
    kind: "observed",
    source: sunday,
  },
  {
    date: "2027-12-25",
    nameEn: "Christmas Day",
    nameSw: "Siku ya Krismasi",
    kind: "statutory",
    source: act,
  },
  {
    date: "2027-12-27",
    nameEn: "Boxing Day (observed; 26 December is a Sunday)",
    nameSw: "Siku ya Kutoa Zawadi (siku mbadala; 26 Desemba ni Jumapili)",
    kind: "observed",
    source: sunday,
  },
];
