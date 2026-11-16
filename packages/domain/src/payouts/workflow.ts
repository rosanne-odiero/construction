import {
  APPROVAL_BLOCKERS,
  DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
  PAYROLL_BATCH_COMMANDS,
  PAYROLL_BATCH_TRANSITIONS,
  PAYROLL_SETTLEMENT_STATUSES,
  type ApprovalBlocker,
  type PayrollBatchAction,
  type PayrollBatchStatus,
  type PayrollSettlementStatus,
} from "@pm-buddy/types";

/**
 * Payroll batch workflow after D4.1 (D4.3; WORKFLOWS "Payroll", brief §15 C, THREAT_MODEL A-16,
 * A-17, OR-04). Pure rules shared by the API service checks and repeated by the database guard
 * (`app.guard_payroll_batch`): which command may run from which state, the settlement status an
 * approved batch derives from its obligations and payouts, maker-checker separation, approval
 * limits and the segregation waiver.
 */

/** Whether a batch may move `from` → `to`: a command or a derived settlement move. */
export const canTransitionBatch = (from: PayrollBatchStatus, to: PayrollBatchStatus): boolean =>
  PAYROLL_BATCH_TRANSITIONS[from].includes(to);

export type BatchCommandResult =
  { ok: true; to: PayrollBatchStatus } | { ok: false; error: "invalid-transition" };

/** The state a command leads to from `status`, or `invalid-transition` (409). */
export function batchCommand(
  status: PayrollBatchStatus,
  action: PayrollBatchAction,
): BatchCommandResult {
  const command = PAYROLL_BATCH_COMMANDS[action];
  return command.from.includes(status)
    ? { ok: true, to: command.to }
    : { ok: false, error: "invalid-transition" };
}

export const isSettlementStatus = (status: PayrollBatchStatus): status is PayrollSettlementStatus =>
  (PAYROLL_SETTLEMENT_STATUSES as readonly PayrollBatchStatus[]).includes(status);

export type SettlementFacts = {
  /** Every obligation of the batch with its net confirmed allocations (`paid_minor`). */
  obligations: readonly { amountMinor: number; paidMinor: number }[];
  /** Payouts of the batch's obligations in any state, live or finished (never deleted). */
  payoutCount: number;
};

/**
 * The derived status of an approved batch: `settled` when every obligation is settled (also when
 * it has none, because every line nets to zero); else `partially_settled` when some confirmed net
 * allocation exists; else `disbursing` when any payout exists; else `approved`.
 */
export function settlementStatusOf(facts: SettlementFacts): PayrollSettlementStatus {
  if (facts.obligations.every((obligation) => obligation.paidMinor >= obligation.amountMinor))
    return "settled";
  if (facts.obligations.some((obligation) => obligation.paidMinor > 0)) return "partially_settled";
  if (facts.payoutCount > 0) return "disbursing";
  return "approved";
}

/**
 * The status to store after any change to a batch's obligations, payouts or allocations, in the
 * same transaction. Batches that are not approved (pre-approval or cancelled) keep their status:
 * a recompute never moves a batch into or out of the approval workflow.
 */
export function recomputeBatchStatus(
  current: PayrollBatchStatus,
  facts: SettlementFacts,
): PayrollBatchStatus {
  return isSettlementStatus(current) ? settlementStatusOf(facts) : current;
}

// Maker-checker ----------------------------------------------------------------------------------

/**
 * The people a decision must be independent of. `contributor` is everyone who created, calculated
 * or recalculated, submitted or reopened the batch (`payroll_batches.contributors`).
 */
export type SeparationRole =
  "contributor" | "reviewer" | "approver" | "number_changer" | "registrar" | "recorder" | "starter";

/**
 * The first role in `roles` that `actorId` holds (in the order given), or null when the actor is
 * independent of all of them. A conflict is answered with 403 `maker-checker`.
 */
export function separationConflict(
  actorId: string,
  roles: Partial<Record<SeparationRole, string | readonly string[] | null | undefined>>,
): SeparationRole | null {
  for (const [role, holders] of Object.entries(roles) as [
    SeparationRole,
    string | readonly string[] | null | undefined,
  ][]) {
    if (holders === null || holders === undefined) continue;
    if (typeof holders === "string" ? holders === actorId : holders.includes(actorId)) return role;
  }
  return null;
}

/** The reviewer must not be a contributor (the preparer can never review). */
export const reviewConflict = (actorId: string, contributors: readonly string[]) =>
  separationConflict(actorId, { contributor: contributors });

export type ApprovalSeparation =
  | { ok: true; underWaiver: boolean }
  | { ok: false; role: Extract<SeparationRole, "contributor" | "reviewer"> };

/**
 * The approver must not be a contributor nor the reviewer — unless the owner's segregation waiver
 * is on (OR-04), when the reviewer may also approve (the approval is marked as under the waiver).
 * A contributor can never approve.
 */
export function approvalSeparation(input: {
  actorId: string;
  contributors: readonly string[];
  reviewerId: string | null;
  waiverEnabled: boolean;
}): ApprovalSeparation {
  if (input.contributors.includes(input.actorId)) return { ok: false, role: "contributor" };
  if (input.reviewerId === input.actorId)
    return input.waiverEnabled ? { ok: true, underWaiver: true } : { ok: false, role: "reviewer" };
  return { ok: true, underWaiver: false };
}

/**
 * Who may verify a worker's M-Pesa number in person (owner decision 5): not whoever last changed
 * it, and not whoever registered the worker when the number was entered at registration.
 */
export const verificationConflict = (
  actorId: string,
  facts: {
    phoneChangedBy: string | null;
    registeredBy: string | null;
    numberFromRegistration: boolean;
  },
) =>
  separationConflict(actorId, {
    number_changer: facts.phoneChangedBy,
    registrar: facts.numberFromRegistration ? facts.registeredBy : null,
  });

/** Re-approving a changed destination: not a batch contributor, not whoever changed the number. */
export const destinationApprovalConflict = (
  actorId: string,
  facts: { contributors: readonly string[]; phoneChangedBy: string | null },
) =>
  separationConflict(actorId, {
    contributor: facts.contributors,
    number_changer: facts.phoneChangedBy,
  });

/**
 * Clearing an unusual-payout flag: not a batch contributor, not the batch approver and, for
 * `outside_business_hours`, not whoever tried to start the payout (`startedBy`, else null).
 */
export const flagClearConflict = (
  actorId: string,
  facts: { contributors: readonly string[]; approverId: string | null; startedBy: string | null },
) =>
  separationConflict(actorId, {
    contributor: facts.contributors,
    approver: facts.approverId,
    starter: facts.startedBy,
  });

// Approval limits and the waiver -----------------------------------------------------------------

/** A configured limit row: a system role key or a custom role ID (exactly one). */
export type ApprovalLimitRow = {
  systemRole: string | null;
  customRoleId: string | null;
  maxBatchNetMinor: number;
};

/** A member's role as stored on the membership (`role` is `custom` for a custom role). */
export type ApproverRole = { role: string; customRoleId: string | null };

export type ApprovalLimit =
  | { source: "configured" | "owner_default"; maxBatchNetMinor: number }
  | { source: "none"; maxBatchNetMinor: null };

/**
 * The approver's batch limit: their custom role's row, else their system role's row, else the
 * owner default (KES 2,000,000) for owners; any other role without a row cannot approve.
 */
export function approvalLimitFor(
  member: ApproverRole,
  rows: readonly ApprovalLimitRow[],
  ownerDefaultMinor: number = DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
): ApprovalLimit {
  const row = member.customRoleId
    ? rows.find((entry) => entry.customRoleId === member.customRoleId)
    : rows.find((entry) => entry.customRoleId === null && entry.systemRole === member.role);
  if (row) return { source: "configured", maxBatchNetMinor: row.maxBatchNetMinor };
  if (!member.customRoleId && member.role === "owner")
    return { source: "owner_default", maxBatchNetMinor: ownerDefaultMinor };
  return { source: "none", maxBatchNetMinor: null };
}

export type ApprovalLimitCheck =
  | { ok: true; appliedLimitMinor: number }
  | { ok: false; code: "no-approval-limit" }
  | { ok: false; code: "approval-limit-exceeded"; limitMinor: number; netMinor: number };

/**
 * The batch net must be within the approver's limit; under the waiver the applied limit is
 * `min(role limit, waiver limit)`. Refusals are 403 (`approval-limit-exceeded` carries the limit).
 */
export function checkApprovalLimit(input: {
  netMinor: number;
  limit: ApprovalLimit;
  underWaiver: boolean;
  waiverLimitMinor: number;
}): ApprovalLimitCheck {
  if (input.limit.maxBatchNetMinor === null) return { ok: false, code: "no-approval-limit" };
  const applied = input.underWaiver
    ? Math.min(input.limit.maxBatchNetMinor, input.waiverLimitMinor)
    : input.limit.maxBatchNetMinor;
  return input.netMinor <= applied
    ? { ok: true, appliedLimitMinor: applied }
    : { ok: false, code: "approval-limit-exceeded", limitMinor: applied, netMinor: input.netMinor };
}

export type ApprovalReadiness = {
  /** In precedence order: the approve command answers with the first one. */
  blockers: ApprovalBlocker[];
  underWaiver: boolean;
  /** The limit that applies to this approver now, null when they have none. */
  appliedLimitMinor: number | null;
};

/**
 * Everything that stops `actorId` approving the batch now, for the readiness view and the approve
 * command: not `reviewed` (409 `invalid-transition`), maker-checker (403), no limit (403), over the
 * limit (403), unverified recipients (409 with the labourer IDs). The digest comparisons
 * (`snapshot-changed`) belong to the command.
 */
export function approvalReadiness(input: {
  status: PayrollBatchStatus;
  actorId: string;
  contributors: readonly string[];
  reviewerId: string | null;
  waiverEnabled: boolean;
  waiverLimitMinor: number;
  netMinor: number;
  limit: ApprovalLimit;
  unverifiedLabourerIds: readonly string[];
}): ApprovalReadiness {
  const blockers = new Set<ApprovalBlocker>();
  if (input.status !== "reviewed") blockers.add("not-reviewed");
  const separation = approvalSeparation(input);
  if (!separation.ok) blockers.add("maker-checker");
  const underWaiver = separation.ok && separation.underWaiver;
  const limit = checkApprovalLimit({
    netMinor: input.netMinor,
    limit: input.limit,
    underWaiver,
    waiverLimitMinor: input.waiverLimitMinor,
  });
  if (!limit.ok) blockers.add(limit.code);
  if (input.unverifiedLabourerIds.length > 0) blockers.add("unverified-recipients");
  const appliedLimitMinor =
    input.limit.maxBatchNetMinor === null
      ? null
      : underWaiver
        ? Math.min(input.limit.maxBatchNetMinor, input.waiverLimitMinor)
        : input.limit.maxBatchNetMinor;
  return {
    blockers: APPROVAL_BLOCKERS.filter((code) => blockers.has(code)),
    underWaiver,
    appliedLimitMinor,
  };
}
