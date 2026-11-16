import { Injectable } from "@nestjs/common";
import {
  approvalLimitFor,
  approvalReadiness,
  approvalSnapshot,
  approvalSnapshotText,
  batchCommand,
  changeHoldUntil,
  evaluateApprovalFlags,
  maskPhone,
  planObligations,
  reviewConflict,
  type ApprovalLimit,
  type EvaluatedFlag,
  type ObligationPlan,
  type RecipientFacts,
} from "@pm-buddy/domain";
import {
  DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
  type PayrollBatchStatus,
  type RecipientVerificationState,
} from "@pm-buddy/types";
import {
  approveBatchResponseSchema,
  batchApprovalResponseSchema,
  batchDecisionResponseSchema,
  type ApproveBatchRequest,
  type ApproveBatchResponse,
  type BatchApprovalResponse,
  type BatchDecisionResponse,
  type RejectBatchRequest,
  type ReopenBatchRequest,
  type ReviewBatchRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { LabourCrypto } from "../labour/labour-support.js";
import { BatchBuilder } from "../payroll/batch-builder.js";
import { recordDecision } from "../payroll/payroll-decisions.js";
import { batchNames, toBatch, type BatchRow, type LineRow } from "../payroll/payroll-mappers.js";
import { PayrollAccess, PayrollCommands, sha256 } from "../payroll/payroll-support.js";
import { enqueueNotification } from "./notification-queue.js";
import {
  b2cLimits,
  currentPhone,
  loadRecipients,
  refreshBatchStatus,
  type RecipientState,
} from "./payout-facts.js";
import { postApprovalAccruals } from "./payout-postings.js";
import { loadApprovalLimits, loadPayoutSettings } from "./payout-settings.service.js";
import { actorOf, optionalActor, toDecision, toHold, toVerification } from "./payouts-mappers.js";
import {
  makerChecker,
  minor,
  notFound,
  payoutConflict,
  payoutForbidden,
  PayoutAccess,
  payoutVersionConflict,
  rethrowPayoutDbError,
} from "./payouts-support.js";

type Tx = Prisma.TransactionClient;

/** What an approval of the batch, as it stands, would create and bind (§2, D-167). */
type ApprovalPlan = {
  lines: LineRow[];
  recipients: Map<string, RecipientState>;
  plan: ObligationPlan;
  approvalDigest: string;
  flags: EvaluatedFlag[];
};

const PRE_APPROVAL: readonly PayrollBatchStatus[] = ["submitted", "reviewed"];

/**
 * The approval chain of a payroll batch (D4.3 §1–3): review by someone independent of the
 * preparation, rejection and reopening, and approval with a fresh step-up within the approver's
 * limit (or under the owner's segregation waiver), binding the approval snapshot. Approval creates
 * the obligations and carry-forwards (D-167), raises the unusual-payout flags, posts the accrued
 * payroll cost, notifies the other owners and records the decision, all in one transaction.
 */
@Injectable()
export class PayrollApprovalsService {
  constructor(
    private readonly commands: PayrollCommands,
    private readonly payroll: PayrollAccess,
    private readonly access: PayoutAccess,
    private readonly builder: BatchBuilder,
    private readonly labourCrypto: LabourCrypto,
  ) {}

  readiness(principal: Principal, req: Request, batchId: string): Promise<BatchApprovalResponse> {
    return this.commands.read(principal, req, async (scope) => {
      const batch = await this.batch(scope.tx, scope.access.tenantId, batchId);
      await this.access.require(scope, "viewApproval", batch.projectId);
      return this.readinessView(scope, batch);
    });
  }

  review(principal: Principal, req: Request, batchId: string, input: ReviewBatchRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.review",
      { batchId, input },
      async (scope): Promise<BatchDecisionResponse> => {
        const { tx, access } = scope;
        const batch = await this.batch(tx, access.tenantId, batchId);
        await this.access.require(scope, "review", batch.projectId);
        if (batch.version !== input.version) throw payoutVersionConflict();
        this.transition(batch, "review");
        if (input.digest !== batch.digest) throw snapshotChanged();
        await this.assertSnapshotIntact(tx, batch);
        if (reviewConflict(access.userId, batch.contributors))
          throw makerChecker("Someone who prepared or submitted this batch cannot review it.");
        const updated = await tx.payrollBatch.updateMany({
          where: { tenantId: access.tenantId, id: batchId, version: batch.version },
          data: {
            status: "reviewed",
            reviewedBy: access.userId,
            reviewNote: input.note?.trim() || null,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        const decision = await recordDecision(tx, {
          tenantId: access.tenantId,
          projectId: batch.projectId,
          batchId,
          action: "review",
          actorId: access.userId,
          batchVersion: batch.version + 1,
          digest: batch.digest,
          netMinor: minor(batch.netMinor),
          note: input.note?.trim() || null,
        });
        await this.commands.audit(scope, "payroll.batch_reviewed", batchId, {
          projectId: batch.projectId,
          digest: batch.digest,
          noteGiven: Boolean(input.note?.trim()),
        });
        return this.decisionView(scope, batchId, decision);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  reject(principal: Principal, req: Request, batchId: string, input: RejectBatchRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.reject",
      { batchId, input },
      async (scope): Promise<BatchDecisionResponse> => {
        const { tx, access } = scope;
        const batch = await this.batch(tx, access.tenantId, batchId);
        await this.access.require(
          scope,
          batch.status === "reviewed" ? "rejectReviewed" : "rejectSubmitted",
          batch.projectId,
        );
        if (batch.version !== input.version) throw payoutVersionConflict();
        this.transition(batch, "reject");
        const updated = await tx.payrollBatch.updateMany({
          where: { tenantId: access.tenantId, id: batchId, version: batch.version },
          data: {
            status: "rejected",
            rejectedBy: access.userId,
            rejectionReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        const decision = await recordDecision(tx, {
          tenantId: access.tenantId,
          projectId: batch.projectId,
          batchId,
          action: "reject",
          actorId: access.userId,
          batchVersion: batch.version + 1,
          digest: batch.digest,
          netMinor: minor(batch.netMinor),
          note: input.reason,
        });
        await this.commands.audit(scope, "payroll.batch_rejected", batchId, {
          projectId: batch.projectId,
          from: batch.status,
          reasonGiven: true,
        });
        return this.decisionView(scope, batchId, decision);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  reopen(principal: Principal, req: Request, batchId: string, input: ReopenBatchRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.reopen",
      { batchId, input },
      async (scope): Promise<BatchDecisionResponse> => {
        const { tx, access } = scope;
        const batch = await this.batch(tx, access.tenantId, batchId);
        await this.access.require(scope, "reopen", batch.projectId);
        const { project } = await this.payroll.project(scope, batch.projectId, ["payroll.prepare"]);
        this.payroll.assertWritable(project);
        if (batch.version !== input.version) throw payoutVersionConflict();
        this.transition(batch, "reopen");
        const updated = await tx.payrollBatch.updateMany({
          where: { tenantId: access.tenantId, id: batchId, version: batch.version },
          data: { status: "draft", reopenedBy: access.userId, version: { increment: 1 } },
        });
        if (!updated.count) throw payoutVersionConflict();
        const decision = await recordDecision(tx, {
          tenantId: access.tenantId,
          projectId: batch.projectId,
          batchId,
          action: "reopen",
          actorId: access.userId,
          batchVersion: batch.version + 1,
          digest: batch.digest,
          netMinor: minor(batch.netMinor),
        });
        await this.commands.audit(scope, "payroll.batch_reopened", batchId, {
          projectId: batch.projectId,
        });
        return this.decisionView(scope, batchId, decision);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  /**
   * reviewed → approved (§1, §2): binds the snapshot digest and the approval digest shown by the
   * readiness view, checks maker-checker, the limit and the recipients' verification, then
   * creates everything approval creates in this transaction (the company lock serialises two
   * approvals: the second finds a new version and is refused).
   */
  approve(principal: Principal, req: Request, batchId: string, input: ApproveBatchRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.batch.approve",
      { batchId, input },
      async (scope): Promise<ApproveBatchResponse> => {
        const { tx, access } = scope;
        const batch = await this.batch(tx, access.tenantId, batchId);
        await this.access.require(scope, "approve", batch.projectId);
        if (batch.version !== input.version) throw payoutVersionConflict();
        this.transition(batch, "approve");
        if (input.digest !== batch.digest) throw snapshotChanged();
        await this.assertSnapshotIntact(tx, batch);
        const planned = await this.plan(scope, batch);
        if (input.approvalDigest !== planned.approvalDigest) throw snapshotChanged();

        const settings = await loadPayoutSettings(tx, access.tenantId);
        const limit = await this.limitOf(scope);
        const netMinor = minor(batch.netMinor);
        const readiness = approvalReadiness({
          status: batch.status as PayrollBatchStatus,
          actorId: access.userId,
          contributors: batch.contributors,
          reviewerId: batch.reviewedBy,
          waiverEnabled: settings.waiverEnabled,
          waiverLimitMinor: settings.waiverLimitMinor,
          netMinor,
          limit,
          unverifiedLabourerIds: planned.plan.unverifiedLabourerIds,
        });
        for (const blocker of readiness.blockers)
          switch (blocker) {
            case "not-reviewed":
              throw payoutConflict("invalid-transition", "Only a reviewed batch can be approved.");
            case "maker-checker":
              throw makerChecker(
                batch.contributors.includes(access.userId)
                  ? "Someone who prepared or submitted this batch cannot approve it."
                  : "The reviewer cannot also approve this batch.",
              );
            case "no-approval-limit":
              throw payoutForbidden(
                "no-approval-limit",
                "Your role has no payroll approval limit.",
              );
            case "approval-limit-exceeded":
              throw payoutForbidden(
                "approval-limit-exceeded",
                "This batch is above your approval limit.",
                { limitMinor: readiness.appliedLimitMinor, netMinor },
              );
            case "unverified-recipients":
              throw payoutConflict(
                "unverified-recipients",
                "Some workers' M-Pesa numbers have not been verified in person.",
                { labourerIds: planned.plan.unverifiedLabourerIds },
              );
          }

        const approved = await tx.payrollBatch.updateMany({
          where: {
            tenantId: access.tenantId,
            id: batchId,
            version: batch.version,
            status: "reviewed",
          },
          data: {
            status: "approved",
            approvedBy: access.userId,
            approvalDigest: planned.approvalDigest,
            approvalNote: input.note?.trim() || null,
            approvedUnderWaiver: readiness.underWaiver,
            approvalLimitMinor: BigInt(readiness.appliedLimitMinor ?? 0),
            version: { increment: 1 },
          },
        });
        if (!approved.count) throw payoutVersionConflict();

        const obligationIds = new Map<string, string>();
        if (planned.plan.obligations.length)
          await tx.payrollObligation.createMany({
            data: planned.plan.obligations.map((obligation) => {
              const id = uuidv7();
              obligationIds.set(obligation.lineId, id);
              return {
                id,
                tenantId: access.tenantId,
                projectId: batch.projectId,
                batchId,
                lineId: obligation.lineId,
                labourerId: obligation.labourerId,
                amountMinor: BigInt(obligation.amountMinor),
                channel: obligation.channel,
                manualReason: obligation.manualReason,
                destinationBidx: obligation.destinationBidx,
                verificationId: obligation.verificationId,
                destinationApprovedBy: access.userId,
              };
            }),
          });
        if (planned.plan.carryForwards.length)
          await tx.payrollCarryForward.createMany({
            data: planned.plan.carryForwards.map((carry) => ({
              id: uuidv7(),
              tenantId: access.tenantId,
              projectId: batch.projectId,
              batchId,
              lineId: carry.lineId,
              labourerId: carry.labourerId,
              amountMinor: BigInt(carry.amountMinor),
            })),
          });
        const flags = planned.flags.flatMap((flag) => {
          const obligationId = obligationIds.get(flag.key);
          return obligationId
            ? [
                {
                  id: uuidv7(),
                  tenantId: access.tenantId,
                  batchId,
                  obligationId,
                  code: flag.code,
                  details: flag.details,
                },
              ]
            : [];
        });
        if (flags.length) await tx.payrollPayoutFlag.createMany({ data: flags });

        const decision = await recordDecision(tx, {
          tenantId: access.tenantId,
          projectId: batch.projectId,
          batchId,
          action: "approve",
          actorId: access.userId,
          batchVersion: batch.version + 1,
          digest: batch.digest,
          approvalDigest: planned.approvalDigest,
          netMinor,
          appliedLimitMinor: readiness.appliedLimitMinor,
          underWaiver: readiness.underWaiver,
          stepUpAt: scope.principal.session.mfaVerifiedAt ?? null,
          note: input.note?.trim() || null,
        });
        const accruals = await postApprovalAccruals(tx, {
          tenantId: access.tenantId,
          projectId: batch.projectId,
          batchId,
          payDate: batch.payDate,
          actorId: access.userId,
        });
        await refreshBatchStatus(tx, access.tenantId, batchId);
        const notices = await this.queueApprovalNotices(scope, batch);
        const amountMinor = planned.plan.obligations.reduce(
          (sum, obligation) => sum + obligation.amountMinor,
          0,
        );
        const carryForwardMinor = planned.plan.carryForwards.reduce(
          (sum, carry) => sum + carry.amountMinor,
          0,
        );
        const flagged = new Set(flags.map((flag) => flag.obligationId)).size;
        await this.commands.audit(scope, "payroll.approved", batchId, {
          projectId: batch.projectId,
          version: batch.version + 1,
          digest: batch.digest,
          approvalDigest: planned.approvalDigest,
          obligations: planned.plan.obligations.length,
          carryForwards: planned.plan.carryForwards.length,
          flagged,
          underWaiver: readiness.underWaiver,
          costEntries: accruals,
          notices,
        });
        await this.commands.outbox(scope, "payroll.batch_approved", batchId, {
          projectId: batch.projectId,
          obligations: planned.plan.obligations.length,
        });
        const fresh = await this.batch(tx, access.tenantId, batchId);
        const names = await displayNames(tx, batchNames(fresh));
        const decisionNames = await displayNames(tx, [decision.actorId]);
        return approveBatchResponseSchema.parse({
          batch: toBatch(fresh, names),
          decision: toDecision(decision, decisionNames),
          obligations: {
            total: planned.plan.obligations.length,
            mpesa: planned.plan.obligations.filter((row) => row.channel === "mpesa").length,
            manual: planned.plan.obligations.filter((row) => row.channel === "manual").length,
            flagged,
            amountMinor,
            carryForwards: planned.plan.carryForwards.length,
            carryForwardMinor,
          },
        });
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  // Helpers ------------------------------------------------------------------------------------

  private async batch(tx: Tx, tenantId: string, batchId: string): Promise<BatchRow> {
    const row = await tx.payrollBatch.findUnique({
      where: { tenantId_id: { tenantId, id: batchId } },
    });
    if (!row) throw notFound("Batch");
    return row;
  }

  private transition(batch: BatchRow, action: "review" | "reject" | "reopen" | "approve") {
    if (!batchCommand(batch.status as PayrollBatchStatus, action).ok)
      throw payoutConflict(
        "invalid-transition",
        `This batch cannot be ${action === "reopen" ? "reopened" : `${action}ed`} now.`,
      );
  }

  /** The stored lines must still produce the digest that was submitted (tamper evidence). */
  private async assertSnapshotIntact(tx: Tx, batch: BatchRow) {
    const stored = await this.builder.storedSnapshot(tx, batch.tenantId, batch.id);
    if (stored.digest !== batch.digest) throw snapshotChanged();
  }

  private async limitOf(scope: Scope): Promise<ApprovalLimit> {
    const rows = await loadApprovalLimits(scope.tx, scope.access.tenantId);
    return approvalLimitFor(
      { role: scope.access.role, customRoleId: scope.access.customRoleId },
      rows,
      DEFAULT_OWNER_APPROVAL_LIMIT_MINOR,
    );
  }

  private async plan(scope: Scope, batch: BatchRow): Promise<ApprovalPlan> {
    const { tx, access } = scope;
    const lines = await tx.payrollLine.findMany({
      where: { tenantId: access.tenantId, batchId: batch.id },
      orderBy: [{ workerNo: "asc" }, { id: "asc" }],
    });
    const recipients = await loadRecipients(
      tx,
      access.tenantId,
      lines.map((line) => line.labourerId),
    );
    const facts = new Map<string, RecipientFacts>(
      [...recipients.values()].map((recipient) => [
        recipient.labourerId,
        {
          currentPhoneBidx: recipient.phoneBidx,
          verificationId: recipient.currentVerification?.id ?? null,
        },
      ]),
    );
    const plan = planObligations(
      lines.map((line) => ({
        lineId: line.id,
        labourerId: line.labourerId,
        netMinor: minor(line.netMinor),
        payeePhoneBidx: line.payeePhoneBidx,
      })),
      facts,
      await b2cLimits(tx, access.tenantId),
    );
    const approvalDigest = sha256(
      approvalSnapshotText(
        approvalSnapshot({
          batchId: batch.id,
          version: batch.version,
          digest: batch.digest,
          obligations: plan.obligations,
          carryForwards: plan.carryForwards,
        }),
      ),
    );
    const flags = await this.flagsFor(tx, access.tenantId, plan);
    return { lines, recipients, plan, approvalDigest, flags };
  }

  /**
   * §7 flags of the M-Pesa obligations (keyed by line): a large first payout to a number, or a
   * number shared with another active worker or another obligation of the batch. Manual
   * obligations are paid by cash or bank and are not flagged.
   */
  private async flagsFor(tx: Tx, tenantId: string, plan: ObligationPlan) {
    const candidates = plan.obligations
      .filter((obligation) => obligation.channel === "mpesa")
      .map((obligation) => ({
        key: obligation.lineId,
        labourerId: obligation.labourerId,
        amountMinor: obligation.amountMinor,
        destinationBidx: obligation.destinationBidx,
      }));
    const bidxs = [
      ...new Set(candidates.flatMap((row) => (row.destinationBidx ? [row.destinationBidx] : []))),
    ];
    if (!bidxs.length) return [];
    const paid = await tx.payrollPayout.findMany({
      where: { tenantId, method: "mpesa", status: "confirmed", destinationBidx: { in: bidxs } },
      select: { destinationBidx: true },
      distinct: ["destinationBidx"],
    });
    const holders = await tx.labourer.findMany({
      where: { tenantId, status: "active", phoneBidx: { in: bidxs } },
      select: { id: true, phoneBidx: true },
    });
    const byBidx = new Map<string, string[]>();
    for (const holder of holders)
      if (holder.phoneBidx)
        byBidx.set(holder.phoneBidx, [...(byBidx.get(holder.phoneBidx) ?? []), holder.id]);
    const settings = await loadPayoutSettings(tx, tenantId);
    return evaluateApprovalFlags({
      candidates,
      paidDestinations: new Set(paid.flatMap((row) => (row.destinationBidx ? [row.destinationBidx] : []))),
      activeLabourersByBidx: byBidx,
      unusualNewRecipientMinor: settings.unusualNewRecipientMinor,
    });
  }

  /** A notice to every other member whose system role is owner (A-17), once per batch and owner. */
  private async queueApprovalNotices(scope: Scope, batch: BatchRow): Promise<number> {
    const { tx, access } = scope;
    const owners = await tx.membership.findMany({
      where: { tenantId: access.tenantId, role: "owner", userId: { not: access.userId } },
      select: { userId: true, user: { select: { identifier: true } } },
    });
    for (const owner of owners)
      await enqueueNotification(tx, this.labourCrypto.cipher, {
        tenantId: access.tenantId,
        kind: "approval_notice",
        subjectKey: `batch:${batch.id}`,
        channel: owner.user.identifier.includes("@") ? "email" : "sms",
        recipient: owner.user.identifier,
        language: "en",
        batchId: batch.id,
        userId: owner.userId,
      });
    return owners.length;
  }

  private async decisionView(
    scope: Scope,
    batchId: string,
    decision: Awaited<ReturnType<typeof recordDecision>>,
  ): Promise<BatchDecisionResponse> {
    const fresh = await this.batch(scope.tx, scope.access.tenantId, batchId);
    const names = await displayNames(scope.tx, [...batchNames(fresh), decision.actorId]);
    return batchDecisionResponseSchema.parse({
      batch: toBatch(fresh, names),
      decision: toDecision(decision, names),
    });
  }

  private async readinessView(scope: Scope, batch: BatchRow): Promise<BatchApprovalResponse> {
    const { tx, access } = scope;
    const project = await tx.project.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: batch.projectId } },
    });
    if (!project) throw notFound("Project");
    const status = batch.status as PayrollBatchStatus;
    const planned = await this.plan(scope, batch);
    const settings = await loadPayoutSettings(tx, access.tenantId);
    const limit = await this.limitOf(scope);
    const netMinor = minor(batch.netMinor);
    const readiness = approvalReadiness({
      status,
      actorId: access.userId,
      contributors: batch.contributors,
      reviewerId: batch.reviewedBy,
      waiverEnabled: settings.waiverEnabled,
      waiverLimitMinor: settings.waiverLimitMinor,
      netMinor,
      limit,
      unverifiedLabourerIds: planned.plan.unverifiedLabourerIds,
    });
    const decisions = await tx.payrollBatchDecision.findMany({
      where: { tenantId: access.tenantId, batchId: batch.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const names = await displayNames(tx, [
      ...batchNames(batch),
      ...batch.contributors,
      batch.reviewedBy,
      batch.approvedBy,
      settings.waiverChangedBy,
      ...decisions.map((row) => row.actorId),
      ...[...planned.recipients.values()].flatMap((recipient) => [
        ...recipient.verifications.map((row) => row.verifiedBy),
        ...recipient.activeHolds.flatMap((row) => (row.createdBy ? [row.createdBy] : [])),
      ]),
    ]);
    const lineById = new Map(planned.lines.map((line) => [line.id, line]));
    const flagsByLine = new Map<string, EvaluatedFlag[]>();
    for (const flag of planned.flags)
      flagsByLine.set(flag.key, [...(flagsByLine.get(flag.key) ?? []), flag]);
    const labourerRef = (line: LineRow) => ({
      id: line.labourerId,
      workerNo: line.workerNo,
      fullName: line.fullName,
    });
    const unverified = new Set(planned.plan.unverifiedLabourerIds);
    const recipients = planned.plan.obligations.map((obligation) => {
      const line = lineById.get(obligation.lineId)!;
      const recipient = planned.recipients.get(line.labourerId);
      const payee = line.payeePhoneBidx;
      const verification =
        payee && recipient?.phoneBidx === payee ? recipient.currentVerification : null;
      const verificationState: RecipientVerificationState = !payee
        ? "no_number"
        : verification
          ? "verified"
          : "unverified";
      return {
        lineId: line.id,
        labourer: labourerRef(line),
        lineNetMinor: minor(line.netMinor),
        broughtForwardMinor: minor(line.broughtForwardMinor),
        amountMinor: obligation.amountMinor,
        carryForwardMinor: obligation.carryForwardMinor,
        channel: obligation.channel,
        manualReason: obligation.manualReason,
        phoneMasked: recipient ? this.maskedNumber(access.tenantId, recipient, payee) : null,
        numberChanged: payee !== (recipient?.phoneBidx ?? null),
        verificationState,
        verification: verification
          ? toVerification(verification, recipient?.phoneBidx ?? null, names)
          : null,
        activeHolds: (recipient?.activeHolds ?? []).map((row) => toHold(row, names)),
        changeHoldUntil: recipient?.phoneChangedAt
          ? changeHoldUntil(recipient.phoneChangedAt.toISOString(), settings.payeeChangeHoldHours)
          : null,
        flags: (flagsByLine.get(line.id) ?? []).map((flag) => ({
          code: flag.code,
          details: flag.details,
        })),
      };
    });
    const withObligation = new Set(planned.plan.obligations.map((row) => row.lineId));
    const carryForwardOnly = planned.plan.carryForwards
      .filter((carry) => !withObligation.has(carry.lineId))
      .map((carry) => ({
        lineId: carry.lineId,
        labourer: labourerRef(lineById.get(carry.lineId)!),
        carryForwardMinor: carry.amountMinor,
      }));
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    const pending = PRE_APPROVAL.includes(status);
    const reviewer = batch.reviewedBy;
    const canReview =
      status === "submitted" &&
      !batch.contributors.includes(access.userId) &&
      (await this.access.allows(scope, "review", batch.projectId));
    const canReject =
      (status === "submitted" &&
        (await this.access.allows(scope, "rejectSubmitted", batch.projectId))) ||
      (status === "reviewed" && (await this.access.allows(scope, "rejectReviewed", batch.projectId)));
    const canReopen =
      status === "rejected" &&
      !["closed", "cancelled"].includes(project.status) &&
      (await this.access.allows(scope, "reopen", batch.projectId));
    const canApprove =
      readiness.blockers.length === 0 &&
      (await this.access.allows(scope, "approve", batch.projectId));
    return batchApprovalResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name },
      batch: toBatch(batch, names),
      approvalDigest: pending ? planned.approvalDigest : (batch.approvalDigest ?? null),
      recipients,
      carryForwardOnly,
      zeroNetLines: planned.lines.filter((line) => line.netMinor === 0n).length,
      totals: {
        obligations: planned.plan.obligations.length,
        netMinor,
        mpesaMinor: sum(
          planned.plan.obligations
            .filter((row) => row.channel === "mpesa")
            .map((row) => row.amountMinor),
        ),
        manualMinor: sum(
          planned.plan.obligations
            .filter((row) => row.channel === "manual")
            .map((row) => row.amountMinor),
        ),
        carryForwardMinor: sum(planned.plan.carryForwards.map((row) => row.amountMinor)),
        broughtForwardMinor: sum(planned.lines.map((line) => minor(line.broughtForwardMinor))),
        unverified: unverified.size,
        flagged: new Set(planned.flags.map((flag) => flag.key)).size,
      },
      limit: {
        source: limit.source,
        maxBatchNetMinor: limit.maxBatchNetMinor,
        appliedLimitMinor: readiness.appliedLimitMinor,
      },
      waiver: {
        enabled: settings.waiverEnabled,
        reason: settings.waiverReason,
        limitMinor: settings.waiverLimitMinor,
        changedBy: optionalActor(names, settings.waiverChangedBy),
        changedAt: settings.waiverChangedAt ? settings.waiverChangedAt.toISOString() : null,
        appliesToCaller: readiness.underWaiver,
      },
      blockers: readiness.blockers,
      unverifiedLabourerIds: planned.plan.unverifiedLabourerIds,
      separation: {
        contributors: batch.contributors.map((id) => actorOf(names, id)),
        reviewer: optionalActor(names, reviewer),
        approver: optionalActor(names, batch.approvedBy),
      },
      approvedUnderWaiver: batch.approvedUnderWaiver,
      decisions: decisions.map((row) => toDecision(row, names)),
      permissions: { canReview, canReject, canReopen, canApprove },
    });
  }

  /** The line's payee number masked: the current number, or the verified one it was. */
  private maskedNumber(tenantId: string, recipient: RecipientState, bidx: string | null) {
    if (!bidx) return null;
    if (recipient.phoneBidx === bidx) {
      const phone = currentPhone(this.labourCrypto, tenantId, recipient);
      return phone ? maskPhone(phone) : null;
    }
    return recipient.verifications.find((row) => row.phoneBidx === bidx)?.phoneMasked ?? null;
  }
}

const snapshotChanged = () =>
  payoutConflict(
    "snapshot-changed",
    "The batch changed since you opened it. Reload and check it again.",
  );
