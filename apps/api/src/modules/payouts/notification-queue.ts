import type { Locale, PayrollNotificationChannel, PayrollNotificationKind } from "@pm-buddy/types";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { FieldCipher } from "../labour/field-cipher.js";
import { maskRecipient } from "./payouts-support.js";

/**
 * Queues a payroll notification (D4.3 §9, the durable outbox) in the caller's transaction: the
 * recipient sealed with the field cipher (bound to the row), a keyed blind index of it for the
 * "once per kind, subject and recipient" rule, and a masked copy for display. Nothing is sent
 * here and no text is stored: the dispatcher renders it at send time. A repeat is a no-op.
 */
export async function enqueueNotification(
  tx: Prisma.TransactionClient,
  cipher: FieldCipher,
  input: {
    tenantId: string;
    kind: PayrollNotificationKind;
    subjectKey: string;
    channel: PayrollNotificationChannel;
    recipient: string;
    language: Locale;
    batchId?: string | null;
    obligationId?: string | null;
    labourerId?: string | null;
    userId?: string | null;
    target?: "old_number" | "new_number" | null;
    eventAt?: Date | null;
  },
): Promise<void> {
  const id = uuidv7();
  await tx.payrollNotification.createMany({
    data: [
      {
        id,
        tenantId: input.tenantId,
        kind: input.kind,
        subjectKey: input.subjectKey,
        batchId: input.batchId ?? null,
        obligationId: input.obligationId ?? null,
        labourerId: input.labourerId ?? null,
        userId: input.userId ?? null,
        target: input.target ?? null,
        eventAt: input.eventAt ?? null,
        channel: input.channel,
        recipientEnc: cipher.encrypt(
          {
            tenantId: input.tenantId,
            table: "payroll_notifications",
            column: "recipient_enc",
            rowId: id,
          },
          input.recipient,
        ),
        recipientKey: cipher.blindIndex(
          input.tenantId,
          "notification",
          `${input.channel}:${input.recipient}`,
        ),
        recipientMasked: maskRecipient(input.recipient),
        language: input.language,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * A worker's number changed (A-04): a notice to the old number (if any) and to the new one (if
 * any), in the worker's language, naming the company and the date only — never amounts.
 */
export async function enqueueNumberChangeNotices(
  tx: Prisma.TransactionClient,
  cipher: FieldCipher,
  input: {
    tenantId: string;
    labourerId: string;
    changedAt: Date;
    oldPhone: string | null;
    newPhone: string | null;
    language: Locale;
  },
): Promise<number> {
  const subjectKey = `labourer:${input.labourerId}:${input.changedAt.toISOString()}`;
  let queued = 0;
  for (const [target, phone] of [
    ["old_number", input.oldPhone],
    ["new_number", input.newPhone],
  ] as const) {
    if (!phone) continue;
    await enqueueNotification(tx, cipher, {
      tenantId: input.tenantId,
      kind: "number_change",
      subjectKey,
      channel: "sms",
      recipient: phone,
      language: input.language,
      labourerId: input.labourerId,
      target,
      eventAt: input.changedAt,
    });
    queued += 1;
  }
  return queued;
}
