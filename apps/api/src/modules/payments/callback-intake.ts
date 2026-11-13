import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { parseCallback, redactCallbackBody } from "@pm-buddy/domain";
import { CALLBACK_ACK, callbackKindFromSegment, type CallbackKind } from "@pm-buddy/types";
import { isUniqueViolation } from "../../common/database-errors.js";
import { describeError } from "../../common/errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { PaymentLedger } from "./payment-ledger.js";
import { PaymentsCrypto } from "./payments-crypto.js";
import { PaymentsRelay } from "./payments-relay.js";
import { allowedSource, PaymentsRuntime } from "./payments-runtime.js";
import { PAYMENTS_SYSTEM_ACTOR, sha256 } from "./payments-support.js";

const TOKEN = /^[0-9a-f]{64}$/;

export type CallbackAck = { ResultCode: number | string; ResultDesc: string };

/**
 * Durable callback intake (brief §5.7, §15 D). The path token is resolved to its company without a
 * company context (definer function on the token digest); the raw body is sealed into the inbox,
 * with a redacted copy for display and an outbox row for processing, in one transaction; only then
 * does Daraja get a success acknowledgement. If persistence fails the answer is 503, so the
 * provider (or an operator) can deliver it again. A delivery identical to one already persisted is
 * counted and acknowledged without new work. Daraja callbacks carry no signature: an unguessable
 * path and the optional IP allow-list are defence in depth, never proof of payment.
 */
@Injectable()
export class CallbackIntake {
  private readonly logger = new Logger(CallbackIntake.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: TenantDatabase,
    private readonly ledger: PaymentLedger,
    private readonly crypto: PaymentsCrypto,
    private readonly runtime: PaymentsRuntime,
    private readonly relay: PaymentsRelay,
  ) {}

  async receive(
    token: string,
    segment: string,
    raw: Buffer,
    sourceIp: string | undefined,
  ): Promise<CallbackAck> {
    const kind = callbackKindFromSegment(segment);
    if (!kind || !TOKEN.test(token)) throw new NotFoundException("Not found");
    if (!allowedSource(this.runtime.allowList, sourceIp))
      throw new ForbiddenException("Callback source not allowed");
    let route: { tenant_id: string; route_id: string } | undefined;
    try {
      [route] = await this.prisma.$queryRaw<{ tenant_id: string; route_id: string }[]>`
        SELECT tenant_id::text AS tenant_id, route_id::text AS route_id FROM app.payment_callback_route(${sha256(token)})`;
    } catch (error) {
      this.logger.error(`Callback intake unavailable: ${describeError(error)}`);
      throw new ServiceUnavailableException("Callback intake unavailable");
    }
    if (!route) throw new NotFoundException("Not found");
    let ack: CallbackAck;
    try {
      ack = await this.persist(route.tenant_id, route.route_id, kind, raw, sourceIp);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        this.logger.error(`Callback could not be persisted (${kind}): ${describeError(error)}`);
        throw new ServiceUnavailableException("Callback could not be persisted; deliver it again");
      }
      // Two identical deliveries raced: the other one is persisted, so this one is a duplicate.
      ack = await this.persist(route.tenant_id, route.route_id, kind, raw, sourceIp).catch(() => {
        throw new ServiceUnavailableException("Callback could not be persisted; deliver it again");
      });
    }
    this.relay.kick();
    return ack;
  }

  private persist(
    tenantId: string,
    routeId: string,
    kind: CallbackKind,
    raw: Buffer,
    sourceIp: string | undefined,
  ): Promise<CallbackAck> {
    const bodySha256 = sha256(raw);
    const fingerprint = sha256(`${kind}:${bodySha256}`);
    return this.db.run(
      {
        userId: PAYMENTS_SYSTEM_ACTOR,
        tenantId,
        requestId: `payments-callback-${bodySha256.slice(0, 12)}`,
      },
      async (tx) => {
        const duplicate = await tx.paymentCallbackInbox.findUnique({
          where: { tenantId_fingerprint: { tenantId, fingerprint } },
        });
        if (duplicate) {
          await tx.paymentCallbackInbox.update({
            where: { tenantId_id: { tenantId, id: duplicate.id } },
            data: {
              duplicates: { increment: 1 },
              lastDuplicateAt: new Date(),
              version: duplicate.version + 1,
            },
          });
          await this.ledger.event(tx, tenantId, {
            subjectType: "callback",
            subjectId: duplicate.id,
            event: "callback.duplicate",
            actorId: null,
            detail: { kind, duplicates: duplicate.duplicates + 1 },
          });
          return this.acknowledge(tx, tenantId, kind, null);
        }
        const text = raw.toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        const redacted = json === null ? { unparseable: true } : redactCallbackBody(json);
        const id = uuidv7();
        await tx.paymentCallbackInbox.create({
          data: {
            id,
            tenantId,
            routeId,
            kind,
            sourceIp: sourceIp?.slice(0, 45) ?? null,
            bodySha256,
            bodyBytes: raw.length,
            bodyEnc: this.crypto.sealBody(tenantId, id, text),
            redactedBody: (redacted && typeof redacted === "object" && !Array.isArray(redacted)
              ? redacted
              : { items: redacted }) as Prisma.InputJsonValue,
            fingerprint,
          },
        });
        await this.ledger.enqueue(tx, tenantId, "callback.process", id);
        await this.ledger.event(tx, tenantId, {
          subjectType: "callback",
          subjectId: id,
          event: "callback.received",
          toStatus: "received",
          actorId: null,
          detail: { kind, bytes: raw.length },
        });
        await this.ledger.audit(tx, "payments.callback_received", id, { kind });
        return this.acknowledge(tx, tenantId, kind, json);
      },
    );
  }

  /**
   * The acknowledgement Daraja expects. C2B validation accepts payments only to the company's own
   * C2B shortcode (C2B00015 otherwise); validation is optional and enabled by Safaricom per
   * shortcode. Every other callback gets ResultCode 0 once persisted.
   */
  private async acknowledge(
    tx: Prisma.TransactionClient,
    tenantId: string,
    kind: CallbackKind,
    json: unknown,
  ): Promise<CallbackAck> {
    if (kind !== "c2b_validation" || json === null) return { ...CALLBACK_ACK };
    const parsed = parseCallback(kind, json);
    const settings = await tx.paymentSettings.findUnique({ where: { tenantId } });
    if (!parsed.ok || !settings?.c2bShortcode || parsed.value.shortcode !== settings.c2bShortcode)
      return { ResultCode: "C2B00015", ResultDesc: "Rejected" };
    return { ResultCode: "0", ResultDesc: "Accepted" };
  }
}
