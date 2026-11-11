import type { EngagementType, NcaCategory } from "./labour.js";

/**
 * Payroll vocabulary shared by web, API and database (D4.1, brief §5.6, §6, §15 C). The database
 * CHECK constraints list the same keys, so adding a value needs a migration as well as a change
 * here. Every statutory value below is a seed for review, never a legal confirmation:
 * COMPLIANCE-REVIEW (CR-PAY-01 … CR-PAY-16).
 */

/** Pay-calendar frequencies per project (brief §5.6). Weekly is the default (QUESTIONS Q-C4). */
export const PAY_FREQUENCIES = ["daily", "weekly", "fortnightly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

/** Days between the end of a pay period and its pay date (Friday after a Thursday cut-off = 1). */
export const PAYDAY_OFFSET_LIMITS = { min: 0, max: 14 } as const;

/**
 * Batch states implemented in D4.1 (WORKFLOWS "Payroll"): draft → submitted (immutable snapshot)
 * and draft/submitted → cancelled. Review, rejection, approval and disbursement are D4.3.
 */
export const PAYROLL_BATCH_STATUSES = ["draft", "submitted", "cancelled"] as const;
export type PayrollBatchStatus = (typeof PAYROLL_BATCH_STATUSES)[number];

/** Statutory rule kinds, each an effective-dated, versioned parameter set. */
export const STATUTORY_RULE_KINDS = [
  "paye",
  "nssf",
  "shif",
  "ahl",
  "nita",
  "method",
  "applicability",
] as const;
export type StatutoryRuleKind = (typeof STATUTORY_RULE_KINDS)[number];

/** The statutory items whose applicability per engagement type is configurable (CR-PAY-07). */
export const STATUTORY_ITEMS = ["paye", "nssf", "shif", "ahl", "nita"] as const;
export type StatutoryItem = (typeof STATUTORY_ITEMS)[number];

/** Employee deductions withheld from pay, in withholding order (statutory first; CR-PAY-06). */
export const EMPLOYEE_STATUTORY = ["nssf", "shif", "ahl", "paye"] as const;
export type EmployeeStatutory = (typeof EMPLOYEE_STATUTORY)[number];

/** Employer on-costs: computed and shown separately, never deducted from pay. */
export const EMPLOYER_COSTS = ["nssf_employer", "ahl_employer", "nita"] as const;
export type EmployerCost = (typeof EMPLOYER_COSTS)[number];

/** Pre-tax deductions PAYE may subtract (Tax Laws (Amendment) Act, 2024 from 27/12/2024). */
export const PRE_TAX_DEDUCTIONS = ["nssf", "shif", "ahl"] as const;
export type PreTaxDeduction = (typeof PRE_TAX_DEDUCTIONS)[number];

/**
 * How non-monthly pay periods meet monthly statutory rules. Only the cumulative month-to-date method
 * is implemented: every batch recomputes the month's liability on the month's aggregate pay (per
 * employer, by pay date) and withholds the difference from what earlier submitted batches of the
 * month already withheld. A period-equivalent method needs an adviser's divisor first (CR-PAY-01).
 */
export const STATUTORY_METHODS = ["cumulative_month_to_date"] as const;
export type StatutoryMethod = (typeof STATUTORY_METHODS)[number];

/** A rule version is `unverified` until someone with payroll.verify_rules confirms it. */
export const RULE_VERIFICATION_STATUSES = ["unverified", "verified"] as const;
export type RuleVerificationStatus = (typeof RULE_VERIFICATION_STATUSES)[number];

/** Earnings components (brief §5.6). Overtime carries its day-type category. */
export const EARNING_KINDS = ["attendance", "overtime", "piece_rate", "allowance"] as const;
export type EarningKind = (typeof EARNING_KINDS)[number];

export const ALLOWANCE_BASES = ["per_day_worked", "per_period"] as const;
export type AllowanceBasis = (typeof ALLOWANCE_BASES)[number];

/** Piece-rate output entries: recorded, then approved or rejected by someone else. */
export const OUTPUT_STATUSES = ["pending", "approved", "rejected"] as const;
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];

/** Salary advances. "Recovering" and "recovered" are derived from recoveries, not stored. */
export const ADVANCE_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "cancelled",
  "disbursed",
] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];
export const ADVANCE_DISPLAY_STATUSES = [...ADVANCE_STATUSES, "recovering", "recovered"] as const;
export type AdvanceDisplayStatus = (typeof ADVANCE_DISPLAY_STATUSES)[number];

/** D4.1 records an advance paid outside PM-Buddy; M-Pesa disbursement arrives with D4.3. */
export const ADVANCE_DISBURSEMENT_METHODS = ["cash", "mpesa_outside", "bank_outside"] as const;
export type AdvanceDisbursementMethod = (typeof ADVANCE_DISBURSEMENT_METHODS)[number];

/** Statutory export templates (CSV to map to the official formats; COMPLIANCE-REVIEW CR-PAY-11). */
export const PAYROLL_EXPORT_KINDS = ["paye", "nssf", "shif", "nita"] as const;
export type PayrollExportKind = (typeof PAYROLL_EXPORT_KINDS)[number];

/** Why a source was left out of a batch (it stays available for a later batch). */
export const PAYROLL_EXCLUSION_REASONS = [
  "period-not-approved",
  "output-not-approved",
  "missing-rate",
  "rule-missing",
  "timesheet-rule-unverified",
  "negative-gross",
  "day-paid-by-attendance",
  "labourer-not-found",
] as const;
export type PayrollExclusionReason = (typeof PAYROLL_EXCLUSION_REASONS)[number];

/** Warnings shown on a line or batch; they never change pay by themselves. */
export const PAYROLL_WARNING_CODES = [
  "rules-unverified",
  "below-minimum-wage",
  "minimum-wage-not-configured",
  "attendance-replaced-by-piece-rate",
  "piece-rate-engagement",
  "statutory-shortfall",
  "statutory-refund",
  "brought-forward",
  "advance-recovery-capped",
  "zero-pay",
] as const;
export type PayrollWarningCode = (typeof PAYROLL_WARNING_CODES)[number];

/** Minimum-wage areas of the Regulation of Wages (General) Order (CR-PAY-09). */
export const MINIMUM_WAGE_AREAS = ["cities", "municipalities", "other"] as const;
export type MinimumWageArea = (typeof MINIMUM_WAGE_AREAS)[number];

/** Occupations of the General Order seeded for comparison (not the construction order). */
export const MINIMUM_WAGE_OCCUPATIONS = [
  "general_labourer",
  "night_watchman",
  "artisan_ungraded",
  "artisan_grade_iii",
  "artisan_grade_ii",
  "artisan_grade_i",
] as const;
export type MinimumWageOccupation = (typeof MINIMUM_WAGE_OCCUPATIONS)[number];

/**
 * Demonstration mapping from a skill level's NCA category to a General Order occupation, used only
 * for the below-minimum warning. COMPLIANCE-REVIEW CR-PAY-09: which wages order governs building
 * and construction work (General Order or the Building and Construction Industry Order) and how
 * trades map to its occupations is unresolved.
 */
export const DEFAULT_MINIMUM_WAGE_OCCUPATION: Readonly<Record<NcaCategory, MinimumWageOccupation>> =
  {
    unskilled: "general_labourer",
    semi_skilled: "artisan_ungraded",
    skilled: "artisan_grade_iii",
    supervisor: "artisan_grade_i",
  };

/**
 * Derived comparisons when only the monthly minimum is configured: monthly ÷ 26 working days and
 * monthly ÷ 225 hours (the 52-hour week convention). The gazetted daily and hourly figures are set
 * separately and must replace these when configured (research note: never derive one from another).
 */
export const MINIMUM_WAGE_DERIVATION = { workingDaysPerMonth: 26, hoursPerMonth: 225 } as const;

/** Company payroll settings (PRODUCT): advance limits and the recovery cap per batch. */
export type PayrollSettingsValues = {
  /** Largest single advance, KES minor units. */
  advanceMaxMinor: number;
  /** Largest outstanding advance balance per labourer, KES minor units. */
  advanceMaxOutstandingMinor: number;
  /** Advance recovery per batch is capped at this percentage of pay after statutory deductions. */
  recoveryMaxPercent: string;
};
export const DEFAULT_PAYROLL_SETTINGS: Readonly<PayrollSettingsValues> = {
  advanceMaxMinor: 500_000,
  advanceMaxOutstandingMinor: 1_000_000,
  recoveryMaxPercent: "50",
};
export const PAYROLL_SETTINGS_LIMITS = {
  amountMinor: { min: 100, max: 100_000_000 },
  recoveryMaxPercent: { min: "1", max: "100" },
} as const;

// Statutory parameter shapes (all money in KES minor units, all rates as decimal percent strings).

export type PayeBand = { upToMinor: number | null; ratePercent: string };
export type PayeParameters = {
  /** Monthly bands, ascending; the last has no upper limit. */
  bands: PayeBand[];
  personalReliefMinor: number;
  /** Employee contributions subtracted from gross before PAYE (from 27/12/2024: NSSF, SHIF, AHL). */
  deductibleBeforeTax: PreTaxDeduction[];
};
export type NssfParameters = {
  employeeRatePercent: string;
  employerRatePercent: string;
  /** Tier I covers pensionable pay up to the LEL; Tier II from the LEL to the UEL. */
  lowerEarningsLimitMinor: number;
  upperEarningsLimitMinor: number;
};
export type ShifParameters = {
  employeeRatePercent: string;
  minimumMinor: number;
  maximumMinor: number | null;
};
export type AhlParameters = { employeeRatePercent: string; employerRatePercent: string };
export type NitaParameters = { employerAmountPerEmployeeMinor: number };
export type MethodParameters = { method: StatutoryMethod };
export type ApplicabilityParameters = Record<EngagementType, Record<StatutoryItem, boolean>>;

export type StatutoryParameters = {
  paye: PayeParameters;
  nssf: NssfParameters;
  shif: ShifParameters;
  ahl: AhlParameters;
  nita: NitaParameters;
  method: MethodParameters;
  applicability: ApplicabilityParameters;
};

export type StatutoryRuleSeed = {
  [K in StatutoryRuleKind]: {
    kind: K;
    effectiveFrom: string;
    parameters: StatutoryParameters[K];
    sourceReference: string;
    notes: string;
  };
}[StatutoryRuleKind];

/**
 * Citations (accessed 11/11/2026). Kenya Law blocked direct fetches during research, so most
 * entries are official notices or professional tax alerts quoting the primary text: every seeded
 * version stays `unverified` until a named adviser confirms it (COMPLIANCE_TODO).
 */
export const PAYROLL_SOURCES = {
  payeBands:
    "Income Tax Act (Cap. 470) Third Schedule as amended by the Finance Act, 2023 (bands from 01/07/2023; 32.5% and 35% added), unchanged by the Finance Act, 2025; KRA PAYE guide 01/2025 (https://www.kra.go.ke/images/publications/PAYE-AS-YOU-EARN-PAYE_4-01-2025.pdf)",
  personalRelief:
    "Tax Laws (Amendment) Act, 2020: personal relief KES 2,400/month from 25/04/2020 (PwC Tax Summaries https://taxsummaries.pwc.com/kenya/individual/other-tax-credits-and-incentives)",
  preTax:
    "Tax Laws (Amendment) Act, 2024: employee NSSF, SHIF and AHL deductible before PAYE from 27/12/2024; KRA public notice 'Amendments to PAYE Computation' (https://www.kra.go.ke/news-center/public-notices/2157-amendments-to-paye-computation-pursuant-to-the-tax-laws-amendment-act,-2024)",
  payeRules2026:
    "Income Tax (PAYE) Rules, 2026 (Legal Notice 185 of 2026, 18/09/2026): administrative only per EY (https://globaltaxnews.ey.com/news/2026-2241-kenya-issues-new-paye-rules-introducing-employee-dispute-resolution-and-enhanced-payroll-reporting-requirements) and CRS (10/11/2026); primary text not independently read",
  nssfYear3:
    "NSSF Act, 2013 (No. 45 of 2013) Third Schedule, Year 3 from 01/02/2025: LEL 8,000, UEL 72,000, 6% + 6% (Grant Thornton Kenya Tax Alert 1 of 2026, https://www.grantthornton.co.ke/insights/tax-alert-1-of-2026/)",
  nssfYear4:
    "NSSF Act, 2013 Third Schedule, Year 4 from 01/02/2026: LEL 9,000, UEL 108,000, 6% + 6% (Grant Thornton Kenya Tax Alert 1 of 2026, https://www.grantthornton.co.ke/insights/tax-alert-1-of-2026/; NSSF Year 4 notice to employers not fetched)",
  shif: "Social Health Insurance Act, 2023 and Social Health Insurance (General) Regulations, 2024 (Legal Notice 49 of 2024): 2.75% of gross, minimum KES 300/month, no cap, employee only, from 01/10/2024 (Bowmans, https://bowmanslaw.com/insights/kenya-transition-to-the-social-health-insurance-fund-shif/)",
  ahl: "Affordable Housing Act, 2024 (assent 19/03/2024): 1.5% employee + 1.5% employer of gross; KRA public notice 2099 (https://www.kra.go.ke/news-center/public-notices/2099-collection-of-the-affordable-housing-levy-by-kenya-revenue-authority-2); upheld by the Court of Appeal on 25/09/2026",
  nita: "Industrial Training (Training Levy) Order, Legal Notice 113 of 2007 (Industrial Training Act, Cap. 237): KES 50 per employee per month, employer only, 'employee' includes casual workers (RSM Kenya FAQ; Order not fetched)",
  method:
    "PM-Buddy design proposal: monthly statutory rules applied to the month's aggregate pay per employer by pay date (KRA remits monthly; NSSF is a monthly scheme); no official divisor for weekly or daily pay was found (research §1.7, §2.1)",
  applicability:
    "Research synthesis: no casual carve-out found for PAYE, NSSF, SHIF, AHL or NITA; QUESTIONS Q-C2 (the adviser decides what casual workers pay; nothing assumed)",
  minimumWage2026:
    "Regulation of Wages (General) (Amendment) Order, 2026, Legal Notice 95 of 2026 (Kenya Gazette Supplement No. 128, 29/05/2026, effective 01/05/2026) as corrected by Legal Notice 108 of 2026 (26/06/2026); figures from Grant Thornton Kenya 'Kenya Minimum Wage Guide 2026' (https://www.grantthornton.co.ke/insights/kenya-minimum-wage-guide-2026/) and work.ke; monthly, excluding housing allowance; the Building and Construction Industry wages order status is unresolved",
} as const;

const allApply = { paye: true, nssf: true, shif: true, ahl: true, nita: true } as const;

/**
 * Seed rule versions (COMPLIANCE-REVIEW CR-PAY-01 … CR-PAY-07): installed per company as
 * `unverified`. NSSF has Year 3 and Year 4 so effective dating is exercised. Values are exactly the
 * research figures; changing one needs a new version, never an edit.
 */
export const KENYA_STATUTORY_SEED: readonly StatutoryRuleSeed[] = [
  {
    kind: "paye",
    effectiveFrom: "2024-12-27",
    parameters: {
      bands: [
        { upToMinor: 2_400_000, ratePercent: "10" },
        { upToMinor: 3_233_300, ratePercent: "25" },
        { upToMinor: 50_000_000, ratePercent: "30" },
        { upToMinor: 80_000_000, ratePercent: "32.5" },
        { upToMinor: null, ratePercent: "35" },
      ],
      personalReliefMinor: 240_000,
      deductibleBeforeTax: ["nssf", "shif", "ahl"],
    },
    sourceReference: `${PAYROLL_SOURCES.payeBands}; ${PAYROLL_SOURCES.personalRelief}; ${PAYROLL_SOURCES.preTax}`,
    notes:
      "Insurance relief (15% of premiums, cap KES 5,000/month; SHIF reportedly eligible) is not modelled: open question CR-PAY-01. Personal relief applies once per month per employee at one employer. PAYE Rules 2026 (LN 185/2026) are administrative.",
  },
  {
    kind: "nssf",
    effectiveFrom: "2025-02-01",
    parameters: {
      employeeRatePercent: "6",
      employerRatePercent: "6",
      lowerEarningsLimitMinor: 800_000,
      upperEarningsLimitMinor: 7_200_000,
    },
    sourceReference: PAYROLL_SOURCES.nssfYear3,
    notes:
      "Year 3, superseded by Year 4 from 01/02/2026. Tier I up to the LEL, Tier II to the UEL.",
  },
  {
    kind: "nssf",
    effectiveFrom: "2026-02-01",
    parameters: {
      employeeRatePercent: "6",
      employerRatePercent: "6",
      lowerEarningsLimitMinor: 900_000,
      upperEarningsLimitMinor: 10_800_000,
    },
    sourceReference: PAYROLL_SOURCES.nssfYear4,
    notes:
      "Year 4. Monthly aggregation for casual and weekly-paid workers is inferred, not sourced (CR-PAY-02). Contracted-out Tier II schemes are not modelled.",
  },
  {
    kind: "shif",
    effectiveFrom: "2024-10-01",
    parameters: { employeeRatePercent: "2.75", minimumMinor: 30_000, maximumMinor: null },
    sourceReference: PAYROLL_SOURCES.shif,
    notes:
      "The KES 300 minimum is applied to the month's aggregate (CR-PAY-03). Interaction with the 15% insurance relief is an open question.",
  },
  {
    kind: "ahl",
    effectiveFrom: "2024-03-19",
    parameters: { employeeRatePercent: "1.5", employerRatePercent: "1.5" },
    sourceReference: PAYROLL_SOURCES.ahl,
    notes:
      "Base is gross pay including regular cash allowances; irregular payments excluded (KRA circular via EY). Confirm no pending Supreme Court appeal (CR-PAY-04).",
  },
  {
    kind: "nita",
    effectiveFrom: "2024-01-01",
    parameters: { employerAmountPerEmployeeMinor: 5_000 },
    sourceReference: PAYROLL_SOURCES.nita,
    notes:
      "Effective-from date chosen to cover the demonstration data; the Order dates from 2007. The 12-month exemption for new employers with fewer than 100 employees and the remittance date are not modelled (CR-PAY-05).",
  },
  {
    kind: "method",
    effectiveFrom: "2024-01-01",
    parameters: { method: "cumulative_month_to_date" },
    sourceReference: PAYROLL_SOURCES.method,
    notes:
      "Statutory month = calendar month of the batch pay date (Africa/Nairobi). Earlier submitted batches of the month are subtracted; drafts are not (CR-PAY-01, CR-PAY-02, CR-PAY-03).",
  },
  {
    kind: "applicability",
    effectiveFrom: "2024-01-01",
    parameters: { casual: allApply, term: allApply, piece_rate: allApply },
    sourceReference: PAYROLL_SOURCES.applicability,
    notes:
      "Every item applies to every engagement type until the adviser decides otherwise (Q-C2, CR-PAY-07, CR-PAY-16).",
  },
];

export type MinimumWageSeed = {
  effectiveFrom: string;
  area: MinimumWageArea;
  occupation: MinimumWageOccupation;
  monthlyMinor: number;
  source: string;
};

const minimumWage2026 = (
  occupation: MinimumWageOccupation,
  cities: number,
  municipalities: number,
  other: number,
): MinimumWageSeed[] =>
  (
    [
      ["cities", cities],
      ["municipalities", municipalities],
      ["other", other],
    ] as const
  ).map(([area, monthlyMinor]) => ({
    effectiveFrom: "2026-05-01",
    area,
    occupation,
    monthlyMinor,
    source: PAYROLL_SOURCES.minimumWage2026,
  }));

/**
 * 2026 General Order monthly minimums (KES minor units, excluding housing allowance) for the
 * occupations above. Areas: cities = Nairobi, Mombasa, Kisumu, Nakuru, Eldoret; municipalities
 * include Mavoko, Ruiru and Limuru; other = everywhere else. COMPLIANCE-REVIEW CR-PAY-09.
 */
export const KENYA_MINIMUM_WAGES_2026: readonly MinimumWageSeed[] = [
  ...minimumWage2026("general_labourer", 1_804_740, 1_665_095, 962_807),
  ...minimumWage2026("night_watchman", 2_013_372, 1_866_588, 1_148_343),
  ...minimumWage2026("artisan_ungraded", 2_435_879, 2_248_183, 1_858_277),
  ...minimumWage2026("artisan_grade_iii", 3_063_474, 2_815_587, 2_505_823),
  ...minimumWage2026("artisan_grade_ii", 3_308_744, 3_155_531, 2_847_938),
  ...minimumWage2026("artisan_grade_i", 4_072_423, 3_832_371, 3_593_286),
];

/** Exports and rule verification need MFA verified within five minutes (step-up). */
export const PAYROLL_STEP_UP_ACTIONS = ["rule-verify", "export", "advance-disburse"] as const;
