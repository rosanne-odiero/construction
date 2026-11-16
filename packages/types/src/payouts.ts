import type { Permission } from "./permissions.js";

/**
 * Payroll approvals and payouts (D4.3; brief §5.6, §5.7, §15 C/D/I; WORKFLOWS "Payroll" and
 * "Payment attempts"; ARCHITECTURE §4.19 and §14; THREAT_MODEL A-01, A-04, A-05, A-08, A-12, A-16,
 * A-17, A-22, OR-04 … OR-06). An approved payroll line with net pay becomes an **obligation** for its
 * whole shillings and a **carry-forward** for the cents (decision D-167); each payment towards an
 * obligation is a **payout** (M-Pesa B2C through a D4.2 payment request, or a recorded cash or bank
 * payment); a confirmed payout **allocates** to its obligation. The database CHECK constraints list
 * the same keys, so adding a value needs a migration as well as a change here. Money is integer KES
 * minor units; business dates are Africa/Nairobi calendar dates.
 */

// Obligations ------------------------------------------------------------------------------------

/**
 * `settled` ⇔ net confirmed allocations equal the amount (CHECK `0 ≤ paid ≤ amount`). Amounts are
 * whole shillings on every channel (D-167): `amount = net − (net mod 100)`.
 */
export const PAYROLL_OBLIGATION_STATUSES = ["open", "settled"] as const;
export type PayrollObligationStatus = (typeof PAYROLL_OBLIGATION_STATUSES)[number];

/** How an obligation is meant to be paid, decided at approval and bound by the approval digest. */
export const PAYROLL_OBLIGATION_CHANNELS = ["mpesa", "manual"] as const;
export type PayrollObligationChannel = (typeof PAYROLL_OBLIGATION_CHANNELS)[number];

/**
 * Why an obligation is paid manually (cash or bank) instead of by M-Pesa: no number on the line, or
 * an amount one B2C payment cannot carry (below the company's B2C minimum or above its maximum).
 * Cents never decide the channel: they are carried forward (D-167).
 */
export const MANUAL_CHANNEL_REASONS = ["no_number", "below_b2c_min", "above_b2c_max"] as const;
export type ManualChannelReason = (typeof MANUAL_CHANNEL_REASONS)[number];

// Carry-forwards (decision D-167) ----------------------------------------------------------------

/**
 * The cents of an approved line's net (0–99 minor units; the whole net when it is below KES 1) are
 * owed to the worker and carried to their next payroll: `open` until a D4.1 batch calculation for
 * the worker (any project of the company) adds them to that line's net as "brought forward"
 * (after deductions, never part of gross or a statutory base); `consumed` from then on. Like the
 * other one-time D4.1 sources, a consumption is released (back to `open`) when the consuming batch
 * is cancelled, or recalculated without the worker's line; it becomes final when that batch is
 * approved. A worker can have several open carry-forwards; one calculation consumes them all.
 */
export const CARRY_FORWARD_STATUSES = ["open", "consumed"] as const;
export type CarryForwardStatus = (typeof CARRY_FORWARD_STATUSES)[number];

// Payouts and allocations ------------------------------------------------------------------------

export const PAYROLL_PAYOUT_METHODS = ["mpesa", "cash", "bank"] as const;
export type PayrollPayoutMethod = (typeof PAYROLL_PAYOUT_METHODS)[number];

/**
 * Record-only methods (owner decisions 2 and 7, Q-M3, Q-M4): no provider call, a second person
 * confirms.
 */
export const MANUAL_PAYOUT_METHODS = [
  "cash",
  "bank",
] as const satisfies readonly PayrollPayoutMethod[];
export type ManualPayoutMethod = (typeof MANUAL_PAYOUT_METHODS)[number];

/**
 * Business-level payout states. M-Pesa: `active` (its D4.2 request is `in_progress` or
 * `uncertain`) → `confirmed` | `failed`, and `confirmed` → `reversed` on a D4.2 reversal outcome.
 * Cash and bank: `pending_confirmation` → `confirmed` | `rejected` by a second person with step-up.
 */
export const PAYROLL_PAYOUT_STATUSES = [
  "active",
  "pending_confirmation",
  "confirmed",
  "failed",
  "rejected",
  "reversed",
] as const;
export type PayrollPayoutStatus = (typeof PAYROLL_PAYOUT_STATUSES)[number];

export const PAYROLL_PAYOUT_TRANSITIONS: Readonly<
  Record<PayrollPayoutStatus, readonly PayrollPayoutStatus[]>
> = {
  active: ["confirmed", "failed"],
  pending_confirmation: ["confirmed", "rejected"],
  confirmed: ["reversed"],
  failed: [],
  rejected: [],
  reversed: [],
};

/**
 * Live payouts reserve the obligation's outstanding amount: at most one per obligation (unique
 * partial index), so two starts or a start and a cash record cannot both pay it.
 */
export const LIVE_PAYOUT_STATUSES = [
  "active",
  "pending_confirmation",
] as const satisfies readonly PayrollPayoutStatus[];

/**
 * What the payouts screen shows per payout: an M-Pesa payout mirrors its D4.2 attempt (`queued` …
 * `reversed`, `unknown` shown as `uncertain`); a manual payout shows its own state.
 */
export const PAYOUT_DISPLAY_STATUSES = [
  "queued",
  "submitting",
  "pending",
  "uncertain",
  "confirmed",
  "failed",
  "reversal_pending",
  "reversed",
  "pending_confirmation",
  "rejected",
] as const;
export type PayoutDisplayStatus = (typeof PAYOUT_DISPLAY_STATUSES)[number];

/** One status per worker row on the payouts screen (derived; see `obligationProgress`). */
export const OBLIGATION_PROGRESS_STATUSES = [
  "ready",
  "blocked",
  "in_flight",
  "uncertain",
  "failed",
  "reversed",
  "partially_paid",
  "settled",
] as const;
export type ObligationProgressStatus = (typeof OBLIGATION_PROGRESS_STATUSES)[number];

/**
 * An allocation adds a confirmed payout's amount; its reversal row takes it back (unique per row).
 */
export const PAYROLL_ALLOCATION_KINDS = ["payment", "reversal"] as const;
export type PayrollAllocationKind = (typeof PAYROLL_ALLOCATION_KINDS)[number];

/**
 * Receiver-name check on a confirmed B2C result (A-22, CR-PMT-06): detection evidence after the
 * payout, never pre-payment verification. `unavailable` when the result carries no name.
 */
export const NAME_CHECK_RESULTS = ["match", "mismatch", "unavailable"] as const;
export type NameCheckResult = (typeof NAME_CHECK_RESULTS)[number];

// Recipients: verification, holds, change hold ----------------------------------------------------

/** Owner decision 5: a second person checks the worker's ID in person before the first payout. */
export const RECIPIENT_VERIFICATION_METHODS = ["in_person_id_check"] as const;
export type RecipientVerificationMethod = (typeof RECIPIENT_VERIFICATION_METHODS)[number];

/** Derived: a verification is valid only for the labourer's current phone blind index. */
export const RECIPIENT_VERIFICATION_STATES = ["verified", "unverified", "no_number"] as const;
export type RecipientVerificationState = (typeof RECIPIENT_VERIFICATION_STATES)[number];

/**
 * A hold blocks M-Pesa payouts to the worker until released (payments.approve, step-up, reason).
 */
export const PAYOUT_HOLD_KINDS = ["name_mismatch", "manual"] as const;
export type PayoutHoldKind = (typeof PAYOUT_HOLD_KINDS)[number];
export const PAYOUT_HOLD_STATES = ["active", "released"] as const;
export type PayoutHoldState = (typeof PAYOUT_HOLD_STATES)[number];

/**
 * Why an obligation cannot get a new M-Pesa payout now (§4 eligibility), most fundamental first.
 * `settled`: nothing outstanding; `not-payable-by-mpesa`: the outstanding amount is outside the
 * company's current B2C minimum/maximum (after a partial cash or bank payment, or a limit change).
 */
export const PAYOUT_BLOCK_REASONS = [
  "settled",
  "manual-channel",
  "in-flight",
  "uncertain",
  "not-payable-by-mpesa",
  "destination-changed",
  "unverified",
  "on-hold",
  "change-hold",
  "flagged",
] as const;
export type PayoutBlockReason = (typeof PAYOUT_BLOCK_REASONS)[number];

// Unusual-payout flags ---------------------------------------------------------------------------

/**
 * Unusual payouts need extra approval (ARCHITECTURE §14.5): evaluated at approval
 * (`new_recipient_large`, `shared_number`, A-01) or when a payout is started outside business
 * hours (`outside_business_hours`). An open flag blocks the obligation until cleared.
 */
export const PAYOUT_FLAG_CODES = [
  "new_recipient_large",
  "shared_number",
  "outside_business_hours",
] as const;
export type PayoutFlagCode = (typeof PAYOUT_FLAG_CODES)[number];
export const PAYOUT_FLAG_STATUSES = ["open", "cleared"] as const;
export type PayoutFlagStatus = (typeof PAYOUT_FLAG_STATUSES)[number];

// Approval ---------------------------------------------------------------------------------------

/** Why the current caller cannot approve a batch now (the readiness view lists all that apply). */
export const APPROVAL_BLOCKERS = [
  "not-reviewed",
  "maker-checker",
  "no-approval-limit",
  "approval-limit-exceeded",
  "unverified-recipients",
] as const;
export type ApprovalBlocker = (typeof APPROVAL_BLOCKERS)[number];

/** Where an approver's limit comes from: a configured row, the owner default, or nothing (403). */
export const APPROVAL_LIMIT_SOURCES = ["configured", "owner_default", "none"] as const;
export type ApprovalLimitSource = (typeof APPROVAL_LIMIT_SOURCES)[number];

/**
 * The owner's batch approval limit when no row is configured: KES 2,000,000 per batch (net).
 * Any other role without a configured row cannot approve (`no-approval-limit`).
 */
export const DEFAULT_OWNER_APPROVAL_LIMIT_MINOR = 200_000_000;

/**
 * OR-04 segregation waiver: the reviewer may also approve, under `min(role limit, waiver limit)`.
 * Default waiver limit KES 500,000 per batch (owner decision 3).
 */
export const DEFAULT_WAIVER_LIMIT_MINOR = 50_000_000;

/** Bounds a company can set approval and waiver limits within (sanity, not policy). */
export const APPROVAL_LIMIT_BOUNDS = { minMinor: 100, maxMinor: 100_000_000_000 } as const;

// Settings ---------------------------------------------------------------------------------------

/**
 * Company payout settings (CONFIGURATION "D4.3" rows, all proposals): one row per company, these
 * defaults when absent. Times of day are 24-hour `HH:MM` in Africa/Nairobi; the business-hours
 * window includes its start and excludes its end.
 */
export type PayoutSettingsValues = {
  /**
   * `payments.cash.max_per_worker_period`: cash (pending + confirmed) per worker per pay period;
   * 0 disables cash.
   */
  cashMaxPerWorkerPeriodMinor: number;
  /** `payments.name_match.threshold`: similarity at or above which a receiver name matches. */
  nameMatchThreshold: number;
  /** `payments.name_mismatch.hold_future_payouts`: a mismatch places a `name_mismatch` hold. */
  nameMismatchHold: boolean;
  /**
   * `payments.payee_change_hold_hours`: no M-Pesa payout this long after a number change (OR-05).
   */
  payeeChangeHoldHours: number;
  /**
   * `payments.unusual.new_recipient_amount`: first payout to a number at or above this is flagged.
   */
  unusualNewRecipientMinor: number;
  /** `payments.unusual.business_hours`: payouts started outside are flagged instead of sent. */
  businessHoursStart: string;
  businessHoursEnd: string;
  /** A payout start needs a float (Account Balance) answer at most this old. */
  floatCheckMaxAgeMinutes: number;
  /** OR-04 waiver: owner only, step-up and a reason; shown as a banner while enabled. */
  waiverEnabled: boolean;
  waiverReason: string | null;
  waiverLimitMinor: number;
};

export const DEFAULT_PAYOUT_SETTINGS: Readonly<PayoutSettingsValues> = {
  cashMaxPerWorkerPeriodMinor: 2_000_000,
  nameMatchThreshold: 0.8,
  nameMismatchHold: true,
  payeeChangeHoldHours: 24,
  unusualNewRecipientMinor: 5_000_000,
  businessHoursStart: "06:00",
  businessHoursEnd: "20:00",
  floatCheckMaxAgeMinutes: 15,
  waiverEnabled: false,
  waiverReason: null,
  waiverLimitMinor: DEFAULT_WAIVER_LIMIT_MINOR,
};

export const PAYOUT_SETTINGS_LIMITS = {
  cashMaxPerWorkerPeriodMinor: { min: 0, max: 100_000_000 },
  nameMatchThreshold: { min: 0.5, max: 1 },
  payeeChangeHoldHours: { min: 0, max: 168 },
  unusualNewRecipientMinor: { min: 100, max: 100_000_000 },
  floatCheckMaxAgeMinutes: { min: 1, max: 120 },
  waiverLimitMinor: { min: APPROVAL_LIMIT_BOUNDS.minMinor, max: APPROVAL_LIMIT_BOUNDS.maxMinor },
} as const;

// Manual (cash and bank) payments ----------------------------------------------------------------

/**
 * Cash needs a reason and photo or signature evidence (uploaded after recording, before
 * confirmation); bank needs its reference. Amounts are whole shillings, at most the outstanding
 * (obligations are whole shillings, D-167). Evidence images follow the receipt rules of D5.4.
 */
export const MANUAL_PAYMENT_LIMITS = {
  referenceMin: 3,
  referenceMax: 40,
  reasonMin: 10,
  reasonMax: 500,
  evidencePerPayment: 3,
  evidenceMaxBytes: 5 * 1024 * 1024,
  evidenceContentTypes: ["image/jpeg", "image/png", "image/webp"],
  /** A paid-on date may be at most this many days back (never in the future). */
  paidOnMaxAgeDays: 90,
} as const;

// Notifications (durable outbox) -----------------------------------------------------------------

export const PAYROLL_NOTIFICATION_KINDS = ["payslip", "number_change", "approval_notice"] as const;
export type PayrollNotificationKind = (typeof PAYROLL_NOTIFICATION_KINDS)[number];
export const PAYROLL_NOTIFICATION_CHANNELS = ["sms", "email"] as const;
export type PayrollNotificationChannel = (typeof PAYROLL_NOTIFICATION_CHANNELS)[number];

/** `failed` means the dispatcher gave up; a manual resend re-queues only that notification. */
export const PAYROLL_NOTIFICATION_STATUSES = ["queued", "sent", "failed"] as const;
export type PayrollNotificationStatus = (typeof PAYROLL_NOTIFICATION_STATUSES)[number];

/** Safe, stable reasons for the last failed attempt (never provider text or recipients). */
export const NOTIFICATION_ERROR_CODES = [
  "provider_unavailable",
  "provider_rejected",
  "recipient_invalid",
  "render_failed",
  "too_long",
  "timeout",
] as const;
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

/**
 * Backoff before each retry after a failed send: the first send plus up to five retries, after 1
 * minute, 5 minutes, 30 minutes, 2 hours and 6 hours; then `failed`. A notification failure never
 * touches payment state (ARCHITECTURE §14.5).
 */
export const NOTIFICATION_RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360] as const;

/** A number change notifies both numbers (A-04): the old one (if any) and the new one. */
export const NUMBER_CHANGE_NOTICE_TARGETS = ["old_number", "new_number"] as const;
export type NumberChangeNoticeTarget = (typeof NUMBER_CHANGE_NOTICE_TARGETS)[number];

/**
 * The payslip column on the payouts screen: not due until the obligation settles; `no_number`
 * when the worker has no phone number (no SMS is sent); otherwise the notification's status.
 */
export const PAYSLIP_NOTICE_STATES = ["not_due", "no_number", "queued", "sent", "failed"] as const;
export type PayslipNoticeState = (typeof PAYSLIP_NOTICE_STATES)[number];

// SMS texts (EN/SW ICU messages under `payoutSms` in packages/i18n) -------------------------------

/**
 * GSM 03.38 7-bit default alphabet (without the escape code) and its extension table, whose
 * characters cost two septets. One character outside both turns the whole SMS into UCS-2 (70
 * characters per segment), so every value placed in an SMS is reduced to these first.
 */
export const GSM7_BASIC_CHARACTERS =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
export const GSM7_EXTENSION_CHARACTERS = "\f^{}\\[~]|€";

/** A concatenated GSM-7 SMS carries 153 septets per segment; payout SMS stay within three. */
export const SMS_LIMITS = {
  singleSegmentSeptets: 160,
  multipartSegmentSeptets: 153,
  maxSegments: 3,
  maxSeptets: 459,
} as const;

/** Amounts printed in SMS are at most KES 999,999,999.99 ("999,999,999.99", 14 characters). */
export const SMS_AMOUNT_MAX_MINOR = 99_999_999_999;

/**
 * Values of `payoutSms.payslip.text` (CR-PAY-12), already formatted for the worker's language by
 * `payslipSmsParams`: dates DD/MM/YYYY, amounts "1,234" or "1,234.50" (KES implied by the text),
 * strings reduced to GSM-7 and cut to PAYSLIP_SMS_LIMITS. `net` is the line's exact net (cents
 * included, brought-forward included); `paid` is the whole shillings paid (the obligation);
 * `carryForward` the cents carried to the next pay (D-167). `rateBasis`, `method`,
 * `withBroughtForward` and `withCarryForward` select the optional parts (an unused amount is "");
 * `others` counts further payments to the same obligation.
 */
export type PayslipSmsParams = {
  company: string;
  periodStart: string;
  periodEnd: string;
  days: string;
  rateBasis: "daily" | "hourly" | "none";
  rate: string;
  gross: string;
  deductions: string;
  net: string;
  withBroughtForward: "yes" | "no";
  broughtForward: string;
  paid: string;
  method: "mpesa" | "cash" | "bank";
  reference: string;
  others: number;
  withCarryForward: "yes" | "no";
  carryForward: string;
};

/** Longest value (in characters, all GSM-7 basic) each payslip parameter may take. */
export const PAYSLIP_SMS_LIMITS = {
  company: 40,
  date: 10,
  days: 5,
  amount: 15,
  reference: 30,
  others: 99,
  /** A carry-forward is below KES 1 ("0.99"). */
  carryForward: 4,
} as const;

/**
 * Values of `payoutSms.approvalNotice.*` (A-17): to every other owner, by their identifier's
 * channel.
 */
export type ApprovalNoticeParams = {
  company: string;
  batchReference: string;
  project: string;
  periodStart: string;
  periodEnd: string;
  net: string;
  approver: string;
  approvedAt: string;
  waiver: "yes" | "no";
};
export const APPROVAL_NOTICE_LIMITS = {
  company: 40,
  batchReference: 30,
  project: 40,
  approver: 40,
  date: 10,
  dateTime: 16,
  amount: 15,
} as const;

/** Values of `payoutSms.numberChange.*`: never amounts (A-04). */
export type NumberChangeNoticeParams = { company: string; date: string };

// Reconciliation (daily job and statement upload) -------------------------------------------------

/**
 * Reconciliation item kinds for a Nairobi business date (§11): `matched` is resolved
 * automatically; `unmatched_internal` waits for a statement covering its date and is then an
 * exception; `unmatched_statement` is a withdrawal PM-Buddy never requested (critical, A-08);
 * `uncertain` is a payroll payout whose D4.2 request has been uncertain for over an hour;
 * `worker_dispute` is opened by a reviewer on a payout (A-12).
 */
export const RECONCILIATION_ITEM_KINDS = [
  "matched",
  "unmatched_internal",
  "unmatched_statement",
  "amount_mismatch",
  "charge_mismatch",
  "duplicate",
  "uncertain",
  "worker_dispute",
] as const;
export type ReconciliationItemKind = (typeof RECONCILIATION_ITEM_KINDS)[number];

export const RECONCILIATION_ITEM_STATUSES = ["open", "resolved"] as const;
export type ReconciliationItemStatus = (typeof RECONCILIATION_ITEM_STATUSES)[number];

/** ARCHITECTURE §14.5: results are matched, unmatched or disputed. */
export const RECONCILIATION_ITEM_CATEGORIES = ["matched", "unmatched", "disputed"] as const;
export type ReconciliationItemCategory = (typeof RECONCILIATION_ITEM_CATEGORIES)[number];
export const RECONCILIATION_ITEM_CATEGORY: Readonly<
  Record<ReconciliationItemKind, ReconciliationItemCategory>
> = {
  matched: "matched",
  unmatched_internal: "unmatched",
  unmatched_statement: "unmatched",
  uncertain: "unmatched",
  amount_mismatch: "disputed",
  charge_mismatch: "disputed",
  duplicate: "disputed",
  worker_dispute: "disputed",
};

export const RECONCILIATION_ITEM_SEVERITIES = ["info", "warning", "critical"] as const;
export type ReconciliationItemSeverity = (typeof RECONCILIATION_ITEM_SEVERITIES)[number];
/** An `unmatched_internal` item is `info` while it awaits a statement, `warning` after. */
export const RECONCILIATION_ITEM_SEVERITY: Readonly<
  Record<ReconciliationItemKind, ReconciliationItemSeverity>
> = {
  matched: "info",
  unmatched_internal: "warning",
  unmatched_statement: "critical",
  amount_mismatch: "critical",
  charge_mismatch: "warning",
  duplicate: "critical",
  uncertain: "warning",
  worker_dispute: "warning",
};

/**
 * How an item was resolved. Resolution never posts money: a charge difference is corrected by a
 * D5.4 cost journal (`charge_journal`, the journal is named); `paid_outside` explains a statement
 * withdrawal made outside PM-Buddy; `escalated` hands a suspected fraud to the owner's incident
 * process. The system's own outcomes: `auto_matched` for a `matched` item, `superseded` for an
 * item that no longer applies after new evidence (another kind now describes its subject).
 */
export const RECONCILIATION_ITEM_OUTCOMES = [
  "auto_matched",
  "superseded",
  "explained",
  "charge_journal",
  "paid_outside",
  "escalated",
  "dispute_upheld",
  "dispute_rejected",
] as const;
export type ReconciliationItemOutcome = (typeof RECONCILIATION_ITEM_OUTCOMES)[number];

/**
 * The outcomes a person may choose for each kind (never the system's own; `matched` is automatic).
 */
export const RECONCILIATION_OUTCOMES_BY_KIND: Readonly<
  Record<ReconciliationItemKind, readonly ReconciliationItemOutcome[]>
> = {
  matched: [],
  unmatched_internal: ["explained", "escalated"],
  unmatched_statement: ["paid_outside", "escalated", "explained"],
  amount_mismatch: ["explained", "escalated"],
  charge_mismatch: ["charge_journal", "explained"],
  duplicate: ["explained", "escalated"],
  uncertain: ["explained", "escalated"],
  worker_dispute: ["dispute_upheld", "dispute_rejected", "escalated"],
};

/** Append-only item history: `reopened` happens only when new evidence changes the result. */
export const RECONCILIATION_ITEM_EVENTS = [
  "opened",
  "auto_resolved",
  "evidence_updated",
  "assigned",
  "note",
  "resolved",
  "reopened",
] as const;
export type ReconciliationItemEvent = (typeof RECONCILIATION_ITEM_EVENTS)[number];

/** What an item is about; items are unique per (business date, kind, subject). */
export const RECONCILIATION_SUBJECT_TYPES = ["payout", "statement_line", "obligation"] as const;
export type ReconciliationSubjectType = (typeof RECONCILIATION_SUBJECT_TYPES)[number];

/** A payroll payout whose D4.2 request is still `uncertain` after this long becomes an item. */
export const RECONCILIATION_UNCERTAIN_AFTER_MINUTES = 60;

/** Why a reconciliation run happened. */
export const RECONCILIATION_RUN_TRIGGERS = ["schedule", "manual", "statement"] as const;
export type ReconciliationRunTrigger = (typeof RECONCILIATION_RUN_TRIGGERS)[number];

// M-Pesa organisation-portal statements ----------------------------------------------------------

export const STATEMENT_FORMATS = ["csv", "xlsx"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

/**
 * `payout`: a withdrawal with a receipt; `charge`: its transaction charge (linked to the payout).
 */
export const STATEMENT_LINE_CLASSES = ["payout", "charge", "deposit", "other"] as const;
export type StatementLineClass = (typeof STATEMENT_LINE_CLASSES)[number];

export const STATEMENT_COLUMNS = [
  "receipt",
  "completionTime",
  "initiationTime",
  "details",
  "transactionStatus",
  "paidIn",
  "withdrawn",
  "balance",
  "reasonType",
  "otherPartyInfo",
  "linkedTransactionId",
  "accountNumber",
] as const;
export type StatementColumn = (typeof STATEMENT_COLUMNS)[number];

/**
 * Header names recognised for each column (compared without case, punctuation or extra spaces).
 * The first name is the organisation-portal export's own; the layout is ASSUMED from Safaricom's
 * published export and must be checked against a real export at the sandbox gate. Only the
 * receipt, completion time and one of paid in / withdrawn are required.
 */
export const STATEMENT_COLUMN_HEADERS: Readonly<Record<StatementColumn, readonly string[]>> = {
  receipt: ["Receipt No.", "Receipt Number", "Receipt", "Transaction ID"],
  completionTime: ["Completion Time", "Completion Date", "Completed Time"],
  initiationTime: ["Initiation Time", "Initiation Date"],
  details: ["Details", "Description"],
  transactionStatus: ["Transaction Status", "Status"],
  paidIn: ["Paid In", "Paid In (KES)", "Credit"],
  withdrawn: ["Withdrawn", "Withdrawn (KES)", "Paid Out", "Debit"],
  balance: ["Balance", "Balance (KES)"],
  reasonType: ["Reason Type", "Transaction Type"],
  otherPartyInfo: ["Other Party Info", "Other Party", "Opposite Party"],
  linkedTransactionId: ["Linked Transaction ID", "Linked Transaction"],
  accountNumber: ["A/C No.", "Account No.", "Account Number"],
};

/** Upload limits (§11): 5 MB, CSV or XLSX; rows beyond the cap are refused, not truncated. */
export const STATEMENT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 20_000,
  maxCellLength: 500,
  /** Rows searched for the header line (titles, account and period rows come first). */
  maxPreambleRows: 50,
  contentTypes: {
    "text/csv": "csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  },
} as const;

/** Why a statement file cannot be read at all. */
export const STATEMENT_ERRORS = ["empty", "no_header", "too_many_rows"] as const;
export type StatementError = (typeof STATEMENT_ERRORS)[number];

/** Rows that could not be read; they are listed, never guessed (the rest of the file is kept). */
export const STATEMENT_ROW_ISSUES = [
  "missing_receipt",
  "invalid_time",
  "invalid_amount",
  "no_amount",
  "both_amounts",
  "cell_too_long",
] as const;
export type StatementRowIssue = (typeof STATEMENT_ROW_ISSUES)[number];

// Charges tariff ----------------------------------------------------------------------------------

export const TARIFF_KINDS = ["b2c"] as const;
export type TariffKind = (typeof TARIFF_KINDS)[number];
/** `demo` until the company confirms its own Safaricom tariff (CR-PMT-02, Q-M2). */
export const TARIFF_STATUSES = ["demo", "verified"] as const;
export type TariffStatus = (typeof TARIFF_STATUSES)[number];

/** A band charges `chargeMinor` for amounts up to and including `upToMinor` (bands ascending). */
export type TariffBand = { upToMinor: number; chargeMinor: number };

export const TARIFF_LIMITS = {
  maxBands: 30,
  chargeMaxMinor: 1_000_000,
  upToMaxMinor: 100_000_000_000,
} as const;

/**
 * DEMO B2C charge bands (CR-PMT-02): illustrative placeholders, NOT Safaricom's published tariff.
 * They cover the DEMO B2C range (KES 10 to KES 250,000), are seeded per company as status `demo`,
 * and the mock Daraja statement export uses the same bands so normal tests match. Owner decision
 * 6: the estimate is booked when a payout confirms; statement differences become disputes.
 */
export const DEMO_B2C_TARIFF_BANDS: readonly TariffBand[] = [
  { upToMinor: 10_000, chargeMinor: 0 },
  { upToMinor: 150_000, chargeMinor: 500 },
  { upToMinor: 500_000, chargeMinor: 900 },
  { upToMinor: 2_000_000, chargeMinor: 1_100 },
  { upToMinor: 25_000_000, chargeMinor: 1_300 },
];

export const DEMO_B2C_TARIFF = {
  kind: "b2c",
  effectiveFrom: "2024-01-01",
  status: "demo",
  bands: DEMO_B2C_TARIFF_BANDS,
  source:
    "DEMO placeholder bands for development and tests (CR-PMT-02, Q-M2); replace with the company's verified Safaricom B2C tariff",
} as const satisfies {
  kind: TariffKind;
  effectiveFrom: string;
  status: TariffStatus;
  bands: readonly TariffBand[];
  source: string;
};

// Problems and permissions -----------------------------------------------------------------------

/** Stable problem codes of the D4.3 endpoints (the web maps each to an EN/SW message). */
export const PAYOUT_PROBLEMS = [
  "version-conflict",
  "idempotency-key-required",
  "invalid-idempotency-key",
  "idempotency-key-reused",
  "mfa-required",
  "step-up-required",
  "invalid-transition",
  "snapshot-changed",
  "maker-checker",
  "owner-only",
  "no-approval-limit",
  "approval-limit-exceeded",
  "unverified-recipients",
  "payouts-paused",
  "float-check-required",
  "insufficient-float",
  "daily-limit-exceeded",
  "tariff-missing",
  "nothing-eligible",
  "obligation-settled",
  "payout-in-flight",
  "amount-above-outstanding",
  "cash-disabled",
  "cash-cap-exceeded",
  "evidence-required",
  "evidence-limit",
  "destination-unchanged",
  "destination-unverified",
  "no-number",
  "flag-cleared",
  "hold-released",
  "change-hold-inactive",
  "notification-not-failed",
  "statement-already-uploaded",
  "statement-unreadable",
  "statement-too-large",
  "statement-type",
  "item-resolved",
  "outcome-not-allowed",
  "journal-required",
  "tariff-invalid",
  "payout-rule",
] as const;
export type PayoutProblem = (typeof PAYOUT_PROBLEMS)[number];

/** Keys allowed in a problem's `facts` extension (see ProblemDetails); anything else is dropped. */
export const PROBLEM_FACT_KEYS = [
  "limitMinor",
  "netMinor",
  "labourerIds",
  "obligationIds",
  "availableMinor",
  "inFlightMinor",
  "amountsMinor",
  "chargesMinor",
  "requiredMinor",
  "shortfallMinor",
  "answeredAt",
  "ageMinutes",
  "maxAgeMinutes",
  "dailyLimitMinor",
  "usedTodayMinor",
  "capMinor",
  "usedMinor",
  "outstandingMinor",
  "statementId",
  "until",
] as const;
export type ProblemFactKey = (typeof PROBLEM_FACT_KEYS)[number];

/**
 * Who may do what (existing permission keys only; no new keys, so no permission CHECK changes).
 * The caller needs one of `anyOf` (company-wide or on the batch's project, as the API scopes it);
 * `stepUp` = MFA verified within five minutes; `ownerOnly` = the caller's system role is `owner`.
 * Maker-checker rules (contributors, reviewer, recorder) are checked on top of these.
 */
export type PayoutActionRule = {
  anyOf: readonly Permission[];
  stepUp: boolean;
  ownerOnly: boolean;
};

const rule = (
  anyOf: readonly Permission[],
  stepUp = false,
  ownerOnly = false,
): PayoutActionRule => ({
  anyOf,
  stepUp,
  ownerOnly,
});

export const PAYOUT_ACTION_RULES = {
  /** GET batches/:id/approval (readiness). */
  viewApproval: rule(["payroll.view", "payroll.prepare", "payroll.review", "payroll.approve"]),
  review: rule(["payroll.review"]),
  /** A submitted batch: reviewer or approver; a reviewed batch: approver only. */
  rejectSubmitted: rule(["payroll.review", "payroll.approve"]),
  rejectReviewed: rule(["payroll.approve"]),
  reopen: rule(["payroll.prepare"]),
  approve: rule(["payroll.approve"], true),
  /** GET batches/:id/payouts. */
  viewPayouts: rule([
    "payments.view",
    "payments.disburse",
    "payments.approve",
    "payments.review",
    "payroll.approve",
  ]),
  floatCheck: rule(["payments.disburse"]),
  startPayouts: rule(["payments.disburse"], true),
  recordManualPayment: rule(["payments.record_cash"], true),
  addPaymentEvidence: rule(["payments.record_cash"]),
  confirmManualPayment: rule(["payments.approve"], true),
  rejectManualPayment: rule(["payments.approve"], true),
  approveDestination: rule(["payroll.approve"], true),
  clearFlag: rule(["payments.approve"], true),
  resendNotification: rule(["payments.disburse"]),
  /** The receiver name of a mismatched B2C result (personal data, CR-PMT-06). */
  viewReceiverName: rule(["payments.approve", "payments.review"]),
  viewSettings: rule(["payments.view", "payroll.approve", "config.manage"]),
  updateSettings: rule(["config.manage"], true),
  updateWaiver: rule(["config.manage"], true, true),
  viewApprovalLimits: rule(["config.manage", "payroll.approve"]),
  updateApprovalLimits: rule(["config.manage"], true),
  /** Labour: the payout side of a worker record. */
  viewPayoutStatus: rule(["labour.view", "labour.manage", "payments.view", "payroll.approve"]),
  verifyRecipient: rule(["labour.manage"], true),
  setPreferredLanguage: rule(["labour.manage"]),
  placeHold: rule(["payments.approve"]),
  releaseHold: rule(["payments.approve"], true),
  overrideChangeHold: rule(["payments.approve"], true, true),
  /** Payments: reconciliation, statements and the charges tariff. */
  viewReconciliation: rule(["payments.view", "payments.review"]),
  assignItem: rule(["payments.review"]),
  noteItem: rule(["payments.review"]),
  resolveItem: rule(["payments.review"], true),
  runReconciliation: rule(["payments.review"]),
  openDispute: rule(["payments.review"]),
  uploadStatement: rule(["payments.review"]),
  viewStatements: rule(["payments.view", "payments.review"]),
  viewTariffs: rule(["payments.view", "config.manage"]),
  updateTariffs: rule(["config.manage"], true),
} as const satisfies Record<string, PayoutActionRule>;
export type PayoutAction = keyof typeof PAYOUT_ACTION_RULES;

/** The D4.3 actions that need a fresh step-up (MFA verified within five minutes). */
export const PAYOUT_STEP_UP_ACTIONS = (Object.keys(PAYOUT_ACTION_RULES) as PayoutAction[]).filter(
  (action) => PAYOUT_ACTION_RULES[action].stepUp,
);
