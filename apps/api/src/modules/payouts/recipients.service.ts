import { ForbiddenException, Injectable } from "@nestjs/common";
import { maskPhone, recipientBlockReasons, verificationConflict } from "@pm-buddy/domain";
import type { Permission, RecipientVerificationState } from "@pm-buddy/types";
import {
  labourerPayoutStatusResponseSchema,
  type ChangeHoldOverrideRequest,
  type CreatePayoutHoldRequest,
  type CreatePayoutVerificationRequest,
  type LabourerPayoutStatusResponse,
  type ReleasePayoutHoldRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { LabourAccess, LabourCrypto } from "../labour/labour-support.js";
import { PayrollCommands } from "../payroll/payroll-support.js";
import { carryForwardViews } from "./obligation-views.js";
import { currentPhone, loadRecipients, type RecipientState } from "./payout-facts.js";
import { loadPayoutSettings } from "./payout-settings.service.js";
import { toChangeHold, toHold, toVerification } from "./payouts-mappers.js";
import {
  isOwner,
  makerChecker,
  minor,
  notFound,
  payoutConflict,
  PayoutAccess,
  payoutVersionConflict,
  rethrowPayoutDbError,
} from "./payouts-support.js";

type Tx = Prisma.TransactionClient;

/** Who may see and act on the payout side of a worker record. */
type RecipientAccess = { labour: ReadonlySet<Permission>; company: ReadonlySet<Permission> };

/**
 * The payout side of a worker record (D4.3 §5, owner decision 5, OR-05, A-04): in-person
 * verification of the worker's current M-Pesa number by someone other than whoever entered it,
 * manual holds and their release, the owner's override of the hold after a number change, and the
 * worker's payout status (what blocks M-Pesa payouts to them, what is still owed).
 */
@Injectable()
export class RecipientsService {
  constructor(
    private readonly commands: PayrollCommands,
    private readonly access: PayoutAccess,
    private readonly labour: LabourAccess,
    private readonly labourCrypto: LabourCrypto,
  ) {}

  status(principal: Principal, req: Request, labourerId: string) {
    return this.commands.read(principal, req, async (scope) => {
      const who = await this.visible(scope, labourerId);
      return this.view(scope, labourerId, who);
    });
  }

  verify(
    principal: Principal,
    req: Request,
    labourerId: string,
    input: CreatePayoutVerificationRequest,
  ) {
    return this.commands.run(
      principal,
      req,
      "labour.payout_verification.create",
      { labourerId, input },
      async (scope): Promise<LabourerPayoutStatusResponse> => {
        const { tx, access } = scope;
        const who = await this.visible(scope, labourerId);
        // labour.manage on one of the worker's projects (PAYOUT_ACTION_RULES.verifyRecipient).
        if (!who.labour.has("labour.manage"))
          throw new ForbiddenException("Permission required: labour.manage");
        this.access.stepUp(scope);
        const labourer = await this.labourer(tx, access.tenantId, labourerId);
        if (labourer.version !== input.version) throw payoutVersionConflict();
        if (!labourer.phoneBidx || !labourer.phoneEnc)
          throw payoutConflict("no-number", "The worker has no M-Pesa number to verify.");
        if (
          verificationConflict(access.userId, {
            phoneChangedBy: labourer.phoneChangedBy,
            registeredBy: labourer.createdBy,
            numberFromRegistration: labourer.phoneChangedAt === null,
          })
        )
          throw makerChecker(
            "Someone other than whoever entered this number checks the worker's ID in person.",
          );
        const phone = this.labourCrypto.open(
          access.tenantId,
          labourerId,
          "phone_enc",
          labourer.phoneEnc,
        );
        const id = uuidv7();
        await tx.labourerPayoutVerification.create({
          data: {
            id,
            tenantId: access.tenantId,
            labourerId,
            phoneBidx: labourer.phoneBidx,
            phoneMasked: maskPhone(phone),
            method: input.method,
            note: input.note?.trim() || null,
            verifiedBy: access.userId,
          },
        });
        await this.commands.audit(scope, "labour.payout_number_verified", labourerId, {
          verificationId: id,
          method: input.method,
        });
        return this.view(scope, labourerId, who);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  placeHold(principal: Principal, req: Request, labourerId: string, input: CreatePayoutHoldRequest) {
    return this.commands.run(
      principal,
      req,
      "labour.payout_hold.create",
      { labourerId, input },
      async (scope): Promise<LabourerPayoutStatusResponse> => {
        const { tx, access } = scope;
        await this.access.require(scope, "placeHold");
        const who = await this.visible(scope, labourerId);
        const labourer = await this.labourer(tx, access.tenantId, labourerId);
        const phone = labourer.phoneEnc
          ? this.labourCrypto.open(access.tenantId, labourerId, "phone_enc", labourer.phoneEnc)
          : null;
        const id = uuidv7();
        await tx.labourerPayoutHold.create({
          data: {
            id,
            tenantId: access.tenantId,
            labourerId,
            kind: "manual",
            phoneBidx: labourer.phoneBidx,
            phoneMasked: phone ? maskPhone(phone) : null,
            reason: input.reason,
            createdBy: access.userId,
          },
        });
        await this.commands.audit(scope, "labour.payout_hold_placed", labourerId, {
          holdId: id,
          reasonGiven: true,
        });
        return this.view(scope, labourerId, who);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  releaseHold(principal: Principal, req: Request, holdId: string, input: ReleasePayoutHoldRequest) {
    return this.commands.run(
      principal,
      req,
      "labour.payout_hold.release",
      { holdId, input },
      async (scope): Promise<LabourerPayoutStatusResponse> => {
        const { tx, access } = scope;
        await this.access.require(scope, "releaseHold");
        const hold = await tx.labourerPayoutHold.findUnique({
          where: { tenantId_id: { tenantId: access.tenantId, id: holdId } },
        });
        if (!hold) throw notFound("Hold");
        const who = await this.visible(scope, hold.labourerId);
        if (hold.releasedAt)
          throw payoutConflict("hold-released", "This hold was already released.");
        const updated = await tx.labourerPayoutHold.updateMany({
          where: {
            tenantId: access.tenantId,
            id: holdId,
            version: hold.version,
            releasedBy: null,
          },
          data: {
            releasedBy: access.userId,
            releaseReason: input.reason,
            version: { increment: 1 },
          },
        });
        if (!updated.count) throw payoutVersionConflict();
        await this.commands.audit(scope, "labour.payout_hold_released", hold.labourerId, {
          holdId,
          kind: hold.kind,
          reasonGiven: true,
        });
        return this.view(scope, hold.labourerId, who);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  overrideChangeHold(
    principal: Principal,
    req: Request,
    labourerId: string,
    input: ChangeHoldOverrideRequest,
  ) {
    return this.commands.run(
      principal,
      req,
      "labour.change_hold.override",
      { labourerId, input },
      async (scope): Promise<LabourerPayoutStatusResponse> => {
        const { tx, access } = scope;
        await this.access.require(scope, "overrideChangeHold");
        const who = await this.visible(scope, labourerId);
        const labourer = await this.labourer(tx, access.tenantId, labourerId);
        if (labourer.version !== input.version) throw payoutVersionConflict();
        const settings = await loadPayoutSettings(tx, access.tenantId);
        const recipient = (await loadRecipients(tx, access.tenantId, [labourerId])).get(labourerId);
        const hold = recipient
          ? toChangeHold(recipient, settings.payeeChangeHoldHours, new Date(), new Map())
          : null;
        if (!hold?.active || !labourer.phoneChangedAt)
          throw payoutConflict(
            "change-hold-inactive",
            "There is no active hold after a number change to override.",
          );
        const id = uuidv7();
        await tx.labourerChangeHoldOverride.create({
          data: {
            id,
            tenantId: access.tenantId,
            labourerId,
            phoneChangedAt: labourer.phoneChangedAt,
            reason: input.reason,
            createdBy: access.userId,
          },
        });
        await this.commands.audit(scope, "labour.change_hold_overridden", labourerId, {
          overrideId: id,
          reasonGiven: true,
        });
        return this.view(scope, labourerId, who);
      },
      { mapError: rethrowPayoutDbError },
    );
  }

  // Helpers --------------------------------------------------------------------------------------

  private async labourer(tx: Tx, tenantId: string, labourerId: string) {
    const row = await tx.labourer.findUnique({ where: { tenantId_id: { tenantId, id: labourerId } } });
    if (!row) throw notFound("Labourer");
    return row;
  }

  /**
   * The caller's labour permissions on the worker (their projects) and company-level payment
   * permissions; a worker the caller may not see the payout side of is "not found".
   */
  private async visible(scope: Scope, labourerId: string): Promise<RecipientAccess> {
    const { tx, access } = scope;
    await this.labourer(tx, access.tenantId, labourerId);
    const engagements = await tx.labourEngagement.findMany({
      where: { tenantId: access.tenantId, labourerId },
      select: { projectId: true },
    });
    const labour = await this.labour.effectiveOn(scope, [
      ...new Set(engagements.map((row) => row.projectId)),
    ]);
    const company = await this.access.held(scope, [
      "payments.view",
      "payments.approve",
      "payroll.approve",
    ]);
    if (
      !labour.has("labour.view") &&
      !labour.has("labour.manage") &&
      !company.has("payments.view") &&
      !company.has("payroll.approve")
    )
      throw notFound("Labourer");
    return { labour, company };
  }

  private async view(
    scope: Scope,
    labourerId: string,
    who: RecipientAccess,
  ): Promise<LabourerPayoutStatusResponse> {
    const { tx, access } = scope;
    const labourer = await this.labourer(tx, access.tenantId, labourerId);
    const recipient = (await loadRecipients(tx, access.tenantId, [labourerId])).get(
      labourerId,
    ) as RecipientState;
    const settings = await loadPayoutSettings(tx, access.tenantId);
    const now = new Date();
    const names = await displayNames(tx, [
      recipient.phoneChangedBy,
      recipient.override?.createdBy ?? null,
      ...recipient.verifications.map((row) => row.verifiedBy),
      ...recipient.holds.flatMap((row) => [row.createdBy, row.releasedBy]),
    ]);
    const phone = currentPhone(this.labourCrypto, access.tenantId, recipient);
    const verificationState: RecipientVerificationState = !recipient.phoneBidx
      ? "no_number"
      : recipient.currentVerification
        ? "verified"
        : "unverified";
    const blockReasons = recipientBlockReasons({
      currentPhoneBidx: recipient.phoneBidx,
      currentNumberVerified: Boolean(recipient.currentVerification),
      activeHolds: recipient.activeHolds.length,
      phoneChangedAt: recipient.phoneChangedAt?.toISOString() ?? null,
      changeHoldOverridden: Boolean(recipient.override),
      payeeChangeHoldHours: settings.payeeChangeHoldHours,
      now,
    });
    const open = await tx.payrollObligation.findMany({
      where: { tenantId: access.tenantId, labourerId, status: "open" },
      select: { amountMinor: true, paidMinor: true },
    });
    const carries = await tx.payrollCarryForward.findMany({
      where: { tenantId: access.tenantId, labourerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const carryViews = (await carryForwardViews(tx, access.tenantId, carries)).filter(
      (row) => row.status === "open",
    );
    const changeHold = toChangeHold(recipient, settings.payeeChangeHoldHours, now, names);
    const manage = who.labour.has("labour.manage");
    const approve = who.company.has("payments.approve");
    return labourerPayoutStatusResponseSchema.parse({
      labourer: {
        id: labourer.id,
        workerNo: labourer.workerNo,
        fullName: labourer.fullName,
        preferredLanguage: labourer.preferredLanguage,
        phoneMasked: phone ? maskPhone(phone) : null,
        version: labourer.version,
      },
      verificationState,
      verifications: recipient.verifications.map((row) =>
        toVerification(row, recipient.phoneBidx, names),
      ),
      changeHold,
      holds: recipient.holds.map((row) => toHold(row, names)),
      blockReasons,
      openObligations: open.length,
      outstandingMinor: open.reduce(
        (sum, row) => sum + minor(row.amountMinor) - minor(row.paidMinor),
        0,
      ),
      openCarryForwardMinor: carryViews.reduce((sum, row) => sum + row.amountMinor, 0),
      carryForwards: carryViews,
      permissions: {
        canVerify:
          manage &&
          Boolean(recipient.phoneBidx) &&
          !recipient.currentVerification &&
          !verificationConflict(access.userId, {
            phoneChangedBy: recipient.phoneChangedBy,
            registeredBy: recipient.createdBy,
            numberFromRegistration: recipient.phoneChangedAt === null,
          }),
        canPlaceHold: approve,
        canReleaseHolds: approve,
        canOverrideChangeHold: approve && isOwner(scope) && Boolean(changeHold?.active),
        canSetLanguage: manage,
      },
    });
  }
}
