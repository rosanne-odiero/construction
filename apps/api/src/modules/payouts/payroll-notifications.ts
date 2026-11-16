import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  approvalNoticeParams,
  formatHalfDays,
  gsm7Septets,
  notificationRetryAt,
  numberChangeNoticeParams,
  payslipSmsParams,
} from "@pm-buddy/domain";
import { formatServerMessage } from "@pm-buddy/i18n";
import {
  SMS_LIMITS,
  type NotificationErrorCode,
  type RateBasis,
} from "@pm-buddy/types";
import { AppConfig } from "../../config/app-config.js";
import type { PayrollNotification, Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { LabourCrypto } from "../labour/labour-support.js";
import { NotificationProvider } from "../notifications/notification.provider.js";
import { PAYMENTS_SYSTEM_ACTOR } from "../payments/payments-support.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { batchReference, minor } from "./payouts-support.js";

type Tx = Prisma.TransactionClient;

/** pg advisory lock key for the payroll notification dispatcher ("pmb-pnot"). */
const LOCK_KEY = 0x706d622d706e6f74n;
const BATCH = 100;
const INTERVAL_MS = 30_000;
/** A claimed notification is not picked up again for this long (a crash mid-send). */
const LEASE_MS = 10 * 60_000;

type Rendered = { channel: "sms" | "email"; recipient: string; subject: string; text: string };
type Claim =
  | { kind: "send"; id: string; version: number; attempts: number; message: Rendered }
  | { kind: "unrenderable"; id: string; version: number; code: NotificationErrorCode };

export type DispatchResult = { claimed: number; sent: number; retrying: number; failed: number };

/**
 * The payroll notification outbox dispatcher (D4.3 §9): every 30 seconds, when payment workers
 * are enabled, the instance holding a Postgres advisory lock lists due notifications
 * (app.due_payroll_notifications) and handles each in its company's context: it claims the row
 * (FOR UPDATE SKIP LOCKED, attempts + 1, a ten-minute lease), renders the text from the immutable
 * records in the recipient's language (packages/i18n `payoutSms`, at most three GSM-7 segments for
 * SMS), commits the claim, sends through the NotificationProvider and records the result: sent,
 * or retried after 1, 5, 30, 120 and 360 minutes, then failed. A notification never changes any
 * payment state. Tests call `dispatchDue(now)` with workers disabled.
 */
@Injectable()
export class PayrollNotificationsDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollNotificationsDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly provider: NotificationProvider,
    private readonly labourCrypto: LabourCrypto,
    private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.get("PAYMENTS_WORKERS_ENABLED")) return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.dispatchDue();
      if (result?.claimed)
        this.logger.log(
          `Payroll notifications: ${result.sent} sent, ${result.retrying} to retry, ${result.failed} failed`,
        );
    } catch (error) {
      this.logger.warn(`Payroll notification cycle failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
  }

  /** One cycle at `now`; null when another instance holds the lock. */
  async dispatchDue(now = new Date()): Promise<DispatchResult | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}::bigint) AS locked`;
        if (!lock?.locked) return null;
        const due = await tx.$queryRaw<{ tenant_id: string; id: string }[]>`
          SELECT tenant_id::text AS tenant_id, id::text AS id
            FROM app.due_payroll_notifications(${BATCH}::integer, ${now.toISOString()}::timestamptz)`;
        const result: DispatchResult = { claimed: 0, sent: 0, retrying: 0, failed: 0 };
        for (const row of due) {
          try {
            const outcome = await this.dispatchOne(row.tenant_id, row.id, now);
            if (!outcome) continue;
            result.claimed += 1;
            result[outcome] += 1;
          } catch (error) {
            this.logger.warn(
              `Payroll notification ${row.id} could not be handled: ${(error as Error).name}`,
            );
          }
        }
        return result;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  private context(tenantId: string) {
    return { userId: PAYMENTS_SYSTEM_ACTOR, tenantId, requestId: "payroll-notifications" };
  }

  /** Claims, renders, sends and records one notification; null when it is not due any more. */
  private async dispatchOne(
    tenantId: string,
    id: string,
    now: Date,
  ): Promise<"sent" | "retrying" | "failed" | null> {
    const claim = await this.db.run(this.context(tenantId), async (tx): Promise<Claim | null> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM payroll_notifications
         WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND status = 'queued'
           AND next_attempt_at <= ${now.toISOString()}::timestamptz
           FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return null;
      const row = await tx.payrollNotification.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id } },
      });
      const attempts = row.attempts + 1;
      await tx.payrollNotification.update({
        where: { tenantId_id: { tenantId, id } },
        data: {
          attempts,
          nextAttemptAt: new Date(now.getTime() + LEASE_MS),
          version: { increment: 1 },
        },
      });
      const rendered = await this.render(tx, row);
      return "code" in rendered
        ? { kind: "unrenderable", id, version: row.version + 1, code: rendered.code }
        : { kind: "send", id, version: row.version + 1, attempts, message: rendered };
    });
    if (!claim) return null;
    if (claim.kind === "unrenderable") {
      this.logger.warn(`ALERT payroll notification ${id} cannot be rendered: ${claim.code}`);
      return this.record(tenantId, id, claim.version, { failed: claim.code, retryAt: null });
    }
    try {
      await this.provider.send(claim.message);
    } catch (error) {
      const code = errorCode(error);
      const retryAt = notificationRetryAt(claim.attempts, now);
      if (!retryAt) this.logger.warn(`ALERT payroll notification ${id} gave up: ${code}`);
      return this.record(tenantId, id, claim.version, { failed: code, retryAt });
    }
    return this.record(tenantId, id, claim.version, { failed: null, retryAt: null });
  }

  private async record(
    tenantId: string,
    id: string,
    version: number,
    result: { failed: NotificationErrorCode | null; retryAt: Date | null },
  ): Promise<"sent" | "retrying" | "failed"> {
    const outcome = !result.failed ? "sent" : result.retryAt ? "retrying" : "failed";
    await this.db.run(this.context(tenantId), (tx) =>
      tx.payrollNotification.updateMany({
        where: { tenantId, id, version, status: "queued" },
        data:
          outcome === "sent"
            ? {
                status: "sent",
                sentAt: new Date(),
                nextAttemptAt: null,
                lastErrorCode: null,
                version: { increment: 1 },
              }
            : outcome === "retrying"
              ? {
                  nextAttemptAt: result.retryAt,
                  lastErrorCode: result.failed,
                  version: { increment: 1 },
                }
              : {
                  status: "failed",
                  nextAttemptAt: null,
                  lastErrorCode: result.failed,
                  version: { increment: 1 },
                },
      }),
    );
    return outcome;
  }

  // Rendering ------------------------------------------------------------------------------------

  private async render(
    tx: Tx,
    row: PayrollNotification,
  ): Promise<Rendered | { code: NotificationErrorCode }> {
    let recipient: string;
    try {
      recipient = this.labourCrypto.cipher.decrypt(
        {
          tenantId: row.tenantId,
          table: "payroll_notifications",
          column: "recipient_enc",
          rowId: row.id,
        },
        row.recipientEnc,
      );
    } catch {
      return { code: "render_failed" };
    }
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: row.tenantId },
      select: { name: true },
    });
    let message: { subject: string; text: string } | null;
    try {
      message =
        row.kind === "payslip"
          ? await this.payslip(tx, row, tenant.name)
          : row.kind === "number_change"
            ? this.numberChange(row, tenant.name)
            : await this.approvalNotice(tx, row, tenant.name);
    } catch {
      message = null;
    }
    if (!message) return { code: "render_failed" };
    if (row.channel === "sms") {
      const septets = gsm7Septets(message.text);
      if (septets === null || septets > SMS_LIMITS.maxSeptets) return { code: "too_long" };
    }
    return { channel: row.channel as "sms" | "email", recipient, ...message };
  }

  private async payslip(tx: Tx, row: PayrollNotification, company: string) {
    const obligation = await tx.payrollObligation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: row.tenantId, id: row.obligationId! } },
    });
    const line = await tx.payrollLine.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: row.tenantId, id: obligation.lineId } },
    });
    const batch = await tx.payrollBatch.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: row.tenantId, id: obligation.batchId } },
    });
    const attendance = await tx.payrollEarning.findMany({
      where: { tenantId: row.tenantId, lineId: line.id, kind: "attendance" },
      select: { rateMinor: true },
    });
    const rates = new Set(attendance.map((earning) => earning.rateMinor?.toString() ?? "none"));
    const rate =
      attendance.length && rates.size === 1 && attendance[0]!.rateMinor !== null
        ? minor(attendance[0]!.rateMinor)
        : null;
    const carried = await tx.payrollCarryForward.findFirst({
      where: { tenantId: row.tenantId, lineId: line.id },
    });
    const payouts = await tx.payrollPayout.findMany({
      where: { tenantId: row.tenantId, obligationId: obligation.id, status: "confirmed" },
    });
    const periodStart = toCalendarDate(batch.periodStart);
    const periodEnd = toCalendarDate(batch.periodEnd);
    const params = payslipSmsParams({
      companyName: company,
      periodStart,
      periodEnd,
      days: line.halfDays > 0 ? formatHalfDays(line.halfDays) : String(line.daysWorked),
      rateBasis: rate === null ? null : (line.rateBasis as RateBasis),
      rateMinor: rate,
      grossMinor: minor(line.grossMinor),
      totalDeductionsMinor:
        minor(line.statutoryWithheldMinor) +
        minor(line.advanceRecoveryMinor) +
        minor(line.otherDeductionsMinor),
      netMinor: minor(line.netMinor),
      broughtForwardMinor: minor(line.broughtForwardMinor),
      paidMinor: minor(obligation.amountMinor),
      carryForwardMinor: carried ? minor(carried.amountMinor) : 0,
      payments: payouts.map((payout) => ({
        method: payout.method as "mpesa" | "cash" | "bank",
        reference: payout.receipt ?? payout.reference,
        amountMinor: minor(payout.amountMinor),
        confirmedAt: (payout.confirmedAt ?? payout.updatedAt).toISOString(),
      })),
    });
    if (!params.ok) return null;
    const language = row.language;
    return {
      subject: formatServerMessage(language, "payoutSms.payslip.subject", {
        periodStart: params.params.periodStart,
        periodEnd: params.params.periodEnd,
      }),
      text: formatServerMessage(language, "payoutSms.payslip.text", params.params),
    };
  }

  private numberChange(row: PayrollNotification, company: string) {
    const params = row.eventAt
      ? numberChangeNoticeParams({ companyName: company, changedAt: row.eventAt })
      : null;
    if (!params) return null;
    return {
      subject: formatServerMessage(row.language, "payoutSms.numberChange.subject"),
      text: formatServerMessage(
        row.language,
        row.target === "old_number"
          ? "payoutSms.numberChange.oldNumber"
          : "payoutSms.numberChange.newNumber",
        params,
      ),
    };
  }

  private async approvalNotice(tx: Tx, row: PayrollNotification, company: string) {
    const batch = await tx.payrollBatch.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: row.tenantId, id: row.batchId! } },
    });
    const project = await tx.project.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: row.tenantId, id: batch.projectId } },
      select: { code: true, name: true },
    });
    const approver = batch.approvedBy
      ? await tx.user.findUnique({ where: { id: batch.approvedBy }, select: { displayName: true } })
      : null;
    if (!batch.approvedAt || !approver) return null;
    const reference = batchReference(project.code, toCalendarDate(batch.periodStart));
    const params = approvalNoticeParams({
      companyName: company,
      batchReference: reference,
      projectName: project.name,
      periodStart: toCalendarDate(batch.periodStart),
      periodEnd: toCalendarDate(batch.periodEnd),
      netMinor: minor(batch.netMinor),
      approverName: approver.displayName,
      approvedAt: batch.approvedAt,
      underWaiver: batch.approvedUnderWaiver,
    });
    if (!params) return null;
    return {
      subject: formatServerMessage(row.language, "payoutSms.approvalNotice.subject", params),
      text: formatServerMessage(row.language, "payoutSms.approvalNotice.text", params),
    };
  }
}

/** A safe, stable code for a failed send (never the provider's text). */
function errorCode(error: unknown): NotificationErrorCode {
  if (error instanceof ServiceUnavailableException) return "provider_unavailable";
  const name = (error as Error | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "provider_rejected";
}
