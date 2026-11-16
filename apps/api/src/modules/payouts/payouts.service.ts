import { Injectable } from "@nestjs/common";
import {
  canonicalJson,
  destinationApprovalConflict,
  flagClearConflict,
  isWithinBusinessHours,
  nairobiDate,
  payoutBlockReasons,
  planPayoutStart,
  tariffVersionOn,
  utilityBalanceMinor,
} from "@pm-buddy/domain";
import { OBLIGATION_PROGRESS_STATUSES } from "@pm-buddy/types";
import {
  batchPayoutsResponseSchema,
  floatCheckResponseSchema,
  obligationResponseSchema,
  payoutFlagResponseSchema,
  payrollNotificationResponseSchema,
  startPayoutsResponseSchema,
  type BatchPayoutsResponse,
  type ClearFlagRequest,
  type DestinationApprovalRequest,
  type FloatCheckResponse,
  type ObligationResponse,
  type PayoutFlagResponse,
  type PayrollNotificationResponse,
  type StartPayoutsRequest,
  type StartPayoutsResponse,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { PayrollObligation, Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { LabourCrypto } from "../labour/labour-support.js";
import { PaymentRequestsService } from "../payments/requests.service.js";
import { PaymentsRelay } from "../payments/payments-relay.js";
import { chargeOn, tariffVersions } from "../payments/tariffs.service.js";
import { recordDecision } from "../payroll/payroll-decisions.js";
import { batchNames, toBatch, type BatchRow } from "../payroll/payroll-mappers.js";
import {
  PayrollCommands,
  SETTLEMENT_BATCH_STATUSES,
  sha256,
} from "../payroll/payroll-support.js";
import {
  carryForwardViews,
  floatStatus,
  inFlightMinor,
  loadObligationContext,
  obligationView,
} from "./obligation-views.js";
import { currentPhone, eligibilityFacts, refreshBatchStatus } from "./payout-facts.js";
import { toDecision, toFlag, toNotification } from "./payouts-mappers.js";
import {
  batchReference,
  lockBatch,
  makerChecker,
  minor,
  notFound,
  payoutConflict,
  PayoutAccess,
  payoutVersionConflict,
  rethrowPayoutDbError,
} from "./payouts-support.js";

type Tx = Prisma.TransactionClient;

const settling = (status: string) =>
  (SETTLEMENT_BATCH_STATUSES as readonly string[]).includes(status);

/**
 * Paying an approved batch (D4.3 §4, §6, §7, §16): the per-worker payouts view joined live from
 * D4.2, the float check, starting M-Pesa payouts for eligible obligations (manual, after a fresh
 * float check, never automatic), re-approving a changed destination, clearing unusual-payout flags
 * and re-queuing a failed notification.
 */
@Injectable()
export class PayrollPayoutsService {
  constructor(
    private readonly commands: PayrollCommands,
    private readonly access: PayoutAccess,
    private readonly requests: PaymentRequestsService,
    private readonly relay: PaymentsRelay,
    private readonly labourCrypto: LabourCrypto,
  ) {}

  // The payouts view -------------------------------------------------------------------------------

  view(principal: Principal, req: Request, batchId: string): Promise<BatchPayoutsResponse> {
    return this.commands.read(principal, req, async (scope) => {
      const batch = await batchOf(scope.tx, scope.access.tenantId, batchId);
      await this.access.require(scope, "viewPayouts", batch.projectId);
      return this.batchView(scope, batch);
    });
  }

  async batchView(scope: Scope, batch: BatchRow): Promise<BatchPayoutsResponse> {
    const { tx, access } = scope;
    const project = await tx.project.findUnique({
      where: { tenantId_id: { tenantId: access.tenantId, id: batch.projectId } },
    });
    if (!project) throw notFound("Project");
    const obligations = await tx.payrollObligation.findMany({
      where: { tenantId: access.tenantId, batchId: batch.id },
    });
    const ctx = await loadObligationContext(tx, access.tenantId, obligations);
    const can = {
      floatCheck: await this.access.allows(scope, "floatCheck", batch.projectId),
      start: await this.access.allows(scope, "startPayouts", batch.projectId),
      recordManual: await this.access.allows(scope, "recordManualPayment", batch.projectId),
      confirmManual: await this.access.allows(scope, "confirmManualPayment", batch.projectId),
      approveDestination: await this.access.allows(scope, "approveDestination", batch.projectId),
      clearFlags: await this.access.allows(scope, "clearFlag", batch.projectId),
      resend: await this.access.allows(scope, "resendNotification", batch.projectId),
      receiverNames: await this.access.allows(scope, "viewReceiverName", batch.projectId),
    };
    const views = obligations
      .map((row) => obligationView(ctx, row, this.labourCrypto, can.receiverNames))
      .sort(
        (a, b) =>
          a.labourer.workerNo.localeCompare(b.labourer.workerNo) || a.id.localeCompare(b.id),
      );
    const today = nairobiDate(ctx.now);
    const eligible = views.filter((row) => row.blockReasons.length === 0);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    const charges = eligible.map(
      (row) => chargeOn(ctx.versions, today, row.outstandingMinor)?.chargeMinor ?? 0,
    );
    const carried = await tx.payrollCarryForward.findMany({
      where: { tenantId: access.tenantId, batchId: batch.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const lines = await tx.payrollLine.findMany({
      where: { tenantId: access.tenantId, batchId: batch.id },
      select: { broughtForwardMinor: true },
    });
    const payment = await tx.paymentSettings.findUnique({ where: { tenantId: access.tenantId } });
    const names = await displayNames(tx, batchNames(batch));
    return batchPayoutsResponseSchema.parse({
      project: { id: project.id, code: project.code, name: project.name },
      batch: toBatch(batch, names),
      approvedUnderWaiver: batch.approvedUnderWaiver,
      obligations: views,
      totals: {
        obligations: views.length,
        amountMinor: sum(views.map((row) => row.amountMinor)),
        paidMinor: sum(views.map((row) => row.paidMinor)),
        outstandingMinor: sum(views.map((row) => row.outstandingMinor)),
        settled: views.filter((row) => row.status === "settled").length,
        eligible: eligible.length,
        eligibleMinor: sum(eligible.map((row) => row.outstandingMinor)),
        eligibleChargesMinor: sum(charges),
        chargesMinor: sum(
          ctx.payouts.flatMap((entry) =>
            entry.payout.chargeMinor !== null ? [minor(entry.payout.chargeMinor)] : [],
          ),
        ),
        carryForwardMinor: sum(carried.map((row) => minor(row.amountMinor))),
        broughtForwardMinor: sum(lines.map((row) => minor(row.broughtForwardMinor))),
        byProgress: Object.fromEntries(
          OBLIGATION_PROGRESS_STATUSES.map((status) => [
            status,
            views.filter((row) => row.progress === status).length,
          ]),
        ),
      },
      carryForwards: await carryForwardViews(tx, access.tenantId, carried),
      float: await floatStatus(tx, access.tenantId, ctx.settings, ctx.versions, ctx.now),
      payoutsEnabled: payment?.payoutsEnabled ?? false,
      businessHours: {
        start: ctx.settings.businessHoursStart,
        end: ctx.settings.businessHoursEnd,
        open: isWithinBusinessHours(
          ctx.now,
          ctx.settings.businessHoursStart,
          ctx.settings.businessHoursEnd,
        ),
      },
      permissions: {
        canFloatCheck: can.floatCheck,
        canStart: can.start,
        canRecordManual: can.recordManual,
        canConfirmManual: can.confirmManual,
        canApproveDestination: can.approveDestination,
        canClearFlags: can.clearFlags,
        canResend: can.resend,
        canViewReceiverNames: can.receiverNames,
      },
    });
  }

  /** One obligation's row (the answer to commands on it). */
  async obligationRow(scope: Scope, obligation: PayrollObligation) {
    const ctx = await loadObligationContext(scope.tx, scope.access.tenantId, [obligation]);
    const names = await this.access.allows(scope, "viewReceiverName", obligation.projectId);
    return obligationView(ctx, obligation, this.labourCrypto, names);
  }

  // Float check and start ----------------------------------------------------------------------

  /**
   * Asks D4.2 for the M-Pesa Account Balance (advisory, owner decision 4); the payouts view shows
   * the answer and its age, and a start needs one at most `floatCheckMaxAgeMinutes` old.
   */
  floatCheck(principal: Principal, req: Request, batchId: string): Promise<FloatCheckResponse> {
    return this.requests
      .requestBalance(principal, req, async (scope) => {
        const batch = await batchOf(scope.tx, scope.access.tenantId, batchId);
        await this.access.require(scope, "floatCheck", batch.projectId);
        if (!settling(batch.status))
          throw payoutConflict("invalid-transition", "Only an approved batch is paid.");
      })
      .then((result) => floatCheckResponseSchema.parse(result));
  }

  /**
   * Starts M-Pesa payouts for the batch's eligible obligations (or the given ones), all or
   * nothing, in one transaction under the company lock: the refusals of planPayoutStart, the
   * outside-hours flags, or one payout with its D4.2 B2C request per obligation.
   */
  start(principal: Principal, req: Request, batchId: string, input: StartPayoutsRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.payouts.start",
      { batchId, input },
      async (scope): Promise<StartPayoutsResponse> => {
        const { tx, access } = scope;
        const head = await batchOf(tx, access.tenantId, batchId);
        await this.access.require(scope, "startPayouts", head.projectId);
        await lockBatch(tx, access.tenantId, batchId);
        const batch = await batchOf(tx, access.tenantId, batchId);
        if (!settling(batch.status))
          throw payoutConflict("invalid-transition", "Only an approved batch is paid.");
        const all = await tx.payrollObligation.findMany({
          where: { tenantId: access.tenantId, batchId },
          orderBy: { id: "asc" },
        });
        const wanted = input.obligationIds ? new Set(input.obligationIds) : null;
        if (wanted && [...wanted].some((id) => !all.some((row) => row.id === id)))
          throw notFound("Obligation");
        const chosen = wanted ? all.filter((row) => wanted.has(row.id)) : all;
        const ctx = await loadObligationContext(tx, access.tenantId, chosen);
        const candidates = chosen.map((obligation) => ({
          obligationId: obligation.id,
          outstandingMinor: minor(obligation.amountMinor) - minor(obligation.paidMinor),
          reasons: payoutBlockReasons(
            eligibilityFacts({
              obligation,
              recipient: ctx.recipients.get(obligation.labourerId),
              payouts: ctx.payouts,
              flags: ctx.flags,
              limits: ctx.limits,
              payeeChangeHoldHours: ctx.settings.payeeChangeHoldHours,
              now: ctx.now,
            }),
          ),
        }));
        const payment = await tx.paymentSettings.findUnique({
          where: { tenantId: access.tenantId },
        });
        const latest = await tx.providerQuery.findFirst({
          where: {
            tenantId: access.tenantId,
            kind: "account_balance",
            status: "answered",
            answeredAt: { not: null },
          },
          orderBy: [{ answeredAt: "desc" }, { id: "desc" }],
        });
        const versions = await tariffVersions(tx, access.tenantId);
        const today = nairobiDate(ctx.now);
        const plan = planPayoutStart({
          payoutsEnabled: payment?.payoutsEnabled ?? false,
          now: ctx.now,
          candidates,
          balance: latest?.answeredAt
            ? {
                answeredAt: latest.answeredAt.toISOString(),
                availableMinor: utilityBalanceMinor(
                  (latest.balances as Parameters<typeof utilityBalanceMinor>[0]) ?? null,
                ),
              }
            : null,
          floatCheckMaxAgeMinutes: ctx.settings.floatCheckMaxAgeMinutes,
          inFlightMinor: await inFlightMinor(
            tx,
            access.tenantId,
            latest?.answeredAt ?? null,
            versions,
          ),
          bands: tariffVersionOn(versions, today)?.bands ?? null,
          dailyLimitMinor: payment ? minor(payment.dailyPayoutMaxMinor) : 0,
          usedTodayMinor: await this.requests.payoutsToday(tx, access.tenantId),
          businessHoursStart: ctx.settings.businessHoursStart,
          businessHoursEnd: ctx.settings.businessHoursEnd,
        });
        if (!plan.ok)
          switch (plan.code) {
            case "payouts-paused":
              throw payoutConflict(
                "payouts-paused",
                "M-Pesa payouts are paused for the company. Ask an administrator to resume them.",
              );
            case "nothing-eligible":
              throw payoutConflict(
                "nothing-eligible",
                "No obligation of this batch can be paid by M-Pesa now.",
                { obligationIds: plan.ineligible.map((row) => row.obligationId) },
              );
            case "float-check-required":
              throw payoutConflict(
                "float-check-required",
                "Check the M-Pesa float first: no recent balance answer.",
                {
                  answeredAt: plan.answeredAt,
                  ageMinutes: plan.ageMinutes,
                  maxAgeMinutes: plan.maxAgeMinutes,
                },
              );
            case "tariff-missing":
              throw payoutConflict(
                "tariff-missing",
                "The M-Pesa charges tariff cannot price some of these payouts.",
                { obligationIds: plan.obligationIds },
              );
            case "insufficient-float":
              throw payoutConflict(
                "insufficient-float",
                "The M-Pesa float is not enough for these payouts and their charges.",
                {
                  availableMinor: plan.figures.availableMinor,
                  inFlightMinor: plan.figures.inFlightMinor,
                  amountsMinor: plan.figures.amountsMinor,
                  chargesMinor: plan.figures.chargesMinor,
                  requiredMinor: plan.figures.requiredMinor,
                  shortfallMinor: plan.figures.shortfallMinor,
                  answeredAt: plan.figures.answeredAt,
                },
              );
            case "daily-limit-exceeded":
              throw payoutConflict(
                "daily-limit-exceeded",
                "These payouts would pass the company's daily payout limit.",
                {
                  dailyLimitMinor: plan.dailyLimitMinor,
                  usedTodayMinor: plan.usedTodayMinor,
                  amountsMinor: plan.amountsMinor,
                },
              );
          }

        const ineligible = plan.ineligible.map((row) => ({
          obligationId: row.obligationId,
          reasons: [...row.reasons],
        }));
        if (plan.outcome === "outside_business_hours") {
          const flagged = plan.flagObligationIds.map((obligationId) => ({
            obligationId,
            flagId: uuidv7(),
          }));
          await tx.payrollPayoutFlag.createMany({
            data: flagged.map((row) => ({
              id: row.flagId,
              tenantId: access.tenantId,
              batchId,
              obligationId: row.obligationId,
              code: "outside_business_hours",
              details: {
                businessHoursStart: ctx.settings.businessHoursStart,
                businessHoursEnd: ctx.settings.businessHoursEnd,
              },
              createdBy: access.userId,
            })),
          });
          await this.commands.audit(scope, "payroll.payouts_flagged_outside_hours", batchId, {
            projectId: batch.projectId,
            obligations: flagged.length,
          });
          return startPayoutsResponseSchema.parse({
            outcome: "outside_business_hours",
            payouts: [],
            flagged,
            ineligible,
            totals: { payouts: 0, amountMinor: 0, chargesMinor: 0 },
            float: null,
            batch: await this.batchWire(tx, access.tenantId, batchId),
          });
        }

        const project = await tx.project.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: batch.projectId } },
        });
        const reference = batchReference(project.code, toDay(batch.periodStart));
        const started: StartPayoutsResponse["payouts"] = [];
        for (const planned of plan.payouts) {
          const obligation = chosen.find((row) => row.id === planned.obligationId)!;
          const recipient = ctx.recipients.get(obligation.labourerId);
          const msisdn = recipient
            ? currentPhone(this.labourCrypto, access.tenantId, recipient)
            : null;
          if (!msisdn || recipient?.phoneBidx !== obligation.destinationBidx)
            throw payoutConflict("payout-rule", "A destination changed while starting payouts.");
          const payoutId = uuidv7();
          const { request } = await this.requests.createRequest(
            tx,
            access.tenantId,
            access.userId,
            {
              kind: "b2c",
              purpose: "payroll_obligation",
              purposeRef: payoutId,
              amountMinor: planned.amountMinor,
              msisdn,
              partyB: null,
              accountReference: null,
              command: "SalaryPayment",
              description: `Wages ${reference}`,
              occasion: reference,
              projectId: batch.projectId,
              idempotencyKey: `payroll-payout-${payoutId}`,
              fingerprint: sha256(
                canonicalJson({
                  purpose: "payroll_obligation",
                  payoutId,
                  obligationId: obligation.id,
                  amountMinor: planned.amountMinor,
                }),
              ),
            },
          );
          await tx.payrollPayout.create({
            data: {
              id: payoutId,
              tenantId: access.tenantId,
              projectId: batch.projectId,
              batchId,
              obligationId: obligation.id,
              labourerId: obligation.labourerId,
              method: "mpesa",
              amountMinor: BigInt(planned.amountMinor),
              status: "active",
              paymentRequestId: request.id,
              destinationBidx: obligation.destinationBidx,
              createdBy: access.userId,
              stepUpAt: scope.principal.session.mfaVerifiedAt ?? null,
            },
          });
          started.push({
            id: payoutId,
            obligationId: obligation.id,
            amountMinor: planned.amountMinor,
            chargeMinor: planned.chargeMinor,
            paymentRequestId: request.id,
          });
        }
        await refreshBatchStatus(tx, access.tenantId, batchId);
        await this.commands.audit(scope, "payroll.payout_started", batchId, {
          projectId: batch.projectId,
          payouts: started.length,
          amountMinor: plan.figures.amountsMinor,
          chargesMinor: plan.figures.chargesMinor,
          ineligible: ineligible.length,
        });
        this.relay.kick();
        return startPayoutsResponseSchema.parse({
          outcome: "submitted",
          payouts: started,
          flagged: [],
          ineligible,
          totals: {
            payouts: started.length,
            amountMinor: plan.figures.amountsMinor,
            chargesMinor: plan.figures.chargesMinor,
          },
          float: {
            availableMinor: plan.figures.availableMinor,
            inFlightMinor: plan.figures.inFlightMinor,
            requiredMinor: plan.figures.requiredMinor,
            answeredAt: plan.figures.answeredAt,
          },
          batch: await this.batchWire(tx, access.tenantId, batchId),
        });
      },
      { requireKey: true, mapError: rethrowPayoutDbError },
    );
  }

  // Destination re-approval, flags, notifications -----------------------------------------------

  /**
   * Re-approves an obligation's destination after the worker's number changed (§4): someone with
   * payroll.approve and a fresh step-up, independent of the batch and of the change, names the
   * verification of the new number they saw.
   */
  approveDestination(
    principal: Principal,
    req: Request,
    obligationId: string,
    input: DestinationApprovalRequest,
  ) {
    return this.commands.run(
      principal,
      req,
      "payroll.obligation.destination_approve",
      { obligationId, input },
      async (scope): Promise<ObligationResponse> => {
        const { tx, access } = scope;
        const head = await obligationOf(tx, access.tenantId, obligationId);
        await this.access.require(scope, "approveDestination", head.projectId);
        await lockBatch(tx, access.tenantId, head.batchId);
        const obligation = await obligationOf(tx, access.tenantId, obligationId);
        if (obligation.version !== input.version) throw payoutVersionConflict();
        const batch = await batchOf(tx, access.tenantId, obligation.batchId);
        if (obligation.status === "settled")
          throw payoutConflict("obligation-settled", "This obligation is already paid.");
        if (obligation.channel !== "mpesa")
          throw payoutConflict(
            "invalid-transition",
            "This obligation is paid by cash or bank; record the payment instead.",
          );
        const labourer = await tx.labourer.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: obligation.labourerId } },
        });
        if (!labourer.phoneBidx)
          throw payoutConflict("no-number", "The worker has no M-Pesa number now.");
        if (labourer.phoneBidx === obligation.destinationBidx)
          throw payoutConflict(
            "destination-unchanged",
            "The worker's number has not changed since approval.",
          );
        const verification = await tx.labourerPayoutVerification.findFirst({
          where: {
            tenantId: access.tenantId,
            id: input.verificationId,
            labourerId: labourer.id,
            phoneBidx: labourer.phoneBidx,
          },
        });
        if (!verification)
          throw payoutConflict(
            "destination-unverified",
            "Verify the worker's new number in person first.",
          );
        const live = await tx.payrollPayout.count({
          where: {
            tenantId: access.tenantId,
            obligationId,
            status: { in: ["active", "pending_confirmation"] },
          },
        });
        if (live)
          throw payoutConflict(
            "payout-in-flight",
            "A payment towards this obligation is in progress.",
          );
        if (
          destinationApprovalConflict(access.userId, {
            contributors: batch.contributors,
            phoneChangedBy: labourer.phoneChangedBy,
          })
        )
          throw makerChecker(
            "Someone who prepared the batch or changed the number cannot approve the new number.",
          );
        const updated = await tx.payrollObligation.updateMany({
          where: { tenantId: access.tenantId, id: obligationId, version: obligation.version },
          data: {
            destinationBidx: labourer.phoneBidx,
            verificationId: verification.id,
            destinationApprovedBy: access.userId,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        const decision = await recordDecision(tx, {
          tenantId: access.tenantId,
          projectId: obligation.projectId,
          batchId: obligation.batchId,
          action: "destination_approve",
          actorId: access.userId,
          batchVersion: batch.version,
          digest: batch.digest,
          approvalDigest: batch.approvalDigest,
          netMinor: minor(obligation.amountMinor),
          stepUpAt: scope.principal.session.mfaVerifiedAt ?? null,
          note: input.note?.trim() || null,
          obligationId,
        });
        await this.commands.audit(scope, "payroll.destination_approved", obligationId, {
          batchId: obligation.batchId,
          labourerId: obligation.labourerId,
          verificationId: verification.id,
        });
        const fresh = await obligationOf(tx, access.tenantId, obligationId);
        const names = await displayNames(tx, [decision.actorId]);
        return obligationResponseSchema.parse({
          obligation: await this.obligationRow(scope, fresh),
          decision: toDecision(decision, names),
        });
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  /** Clears an unusual-payout flag (§7): payments.approve, step-up, a reason, independence. */
  clearFlag(principal: Principal, req: Request, flagId: string, input: ClearFlagRequest) {
    return this.commands.run(
      principal,
      req,
      "payroll.flag.clear",
      { flagId, input },
      async (scope): Promise<PayoutFlagResponse> => {
        const { tx, access } = scope;
        const flag = await tx.payrollPayoutFlag.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: flagId } },
        });
        if (!flag) throw notFound("Flag");
        const batch = await batchOf(tx, access.tenantId, flag.batchId);
        await this.access.require(scope, "clearFlag", batch.projectId);
        await lockBatch(tx, access.tenantId, batch.id);
        if (flag.status !== "open")
          throw payoutConflict("flag-cleared", "This flag was already cleared.");
        if (
          flagClearConflict(access.userId, {
            contributors: batch.contributors,
            approverId: batch.approvedBy,
            startedBy: flag.createdBy,
          })
        )
          throw makerChecker(
            "Someone independent of the batch's preparation, approval and payout start clears its flags.",
          );
        const updated = await tx.payrollPayoutFlag.updateMany({
          where: { tenantId: access.tenantId, id: flagId, version: flag.version, status: "open" },
          data: {
            status: "cleared",
            clearedBy: access.userId,
            clearReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        await this.commands.audit(scope, "payroll.flag_cleared", flagId, {
          batchId: flag.batchId,
          obligationId: flag.obligationId,
          code: flag.code,
          reasonGiven: true,
        });
        const fresh = await tx.payrollPayoutFlag.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: flagId } },
        });
        const names = await displayNames(tx, [fresh.createdBy, fresh.clearedBy]);
        return payoutFlagResponseSchema.parse({ flag: toFlag(fresh, names) });
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  /** Re-queues a notification the dispatcher gave up on (only that one; payments untouched). */
  resend(principal: Principal, req: Request, notificationId: string) {
    return this.commands.run(
      principal,
      req,
      "payroll.notification.resend",
      { notificationId },
      async (scope): Promise<PayrollNotificationResponse> => {
        const { tx, access } = scope;
        const row = await tx.payrollNotification.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: notificationId } },
        });
        if (!row) throw notFound("Notification");
        const projectId = row.batchId
          ? (await batchOf(tx, access.tenantId, row.batchId)).projectId
          : undefined;
        await this.access.require(scope, "resendNotification", projectId);
        if (row.status !== "failed")
          throw payoutConflict(
            "notification-not-failed",
            "Only a notification that could not be sent is sent again.",
          );
        const updated = await tx.payrollNotification.updateMany({
          where: { tenantId: access.tenantId, id: notificationId, version: row.version },
          data: {
            status: "queued",
            attempts: 0,
            nextAttemptAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        await this.commands.audit(scope, "payroll.notification_resent", notificationId, {
          kind: row.kind,
          channel: row.channel,
        });
        const fresh = await tx.payrollNotification.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: access.tenantId, id: notificationId } },
        });
        return payrollNotificationResponseSchema.parse({ notification: toNotification(fresh) });
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  private async batchWire(tx: Tx, tenantId: string, batchId: string) {
    const row = await batchOf(tx, tenantId, batchId);
    return toBatch(row, await displayNames(tx, batchNames(row)));
  }
}

const toDay = (value: Date) => value.toISOString().slice(0, 10);

export async function batchOf(tx: Tx, tenantId: string, batchId: string): Promise<BatchRow> {
  const row = await tx.payrollBatch.findUnique({ where: { tenantId_id: { tenantId, id: batchId } } });
  if (!row) throw notFound("Batch");
  return row;
}

export async function obligationOf(
  tx: Tx,
  tenantId: string,
  obligationId: string,
): Promise<PayrollObligation> {
  const row = await tx.payrollObligation.findUnique({
    where: { tenantId_id: { tenantId, id: obligationId } },
  });
  if (!row) throw notFound("Obligation");
  return row;
}

export const isSettling = (status: string) => settling(status);
