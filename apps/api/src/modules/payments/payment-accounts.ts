import { Injectable } from "@nestjs/common";
import { callbackPathSegment, type PaymentEnvironment, type StkTransactionType } from "@pm-buddy/types";
import type { PaymentSettings, Prisma } from "../../generated/prisma/client.js";
import { PaymentsCrypto } from "./payments-crypto.js";
import { PaymentsRuntime } from "./payments-runtime.js";
import type { ProviderAccount } from "./provider/payment-provider.js";

type Tx = Prisma.TransactionClient;

/**
 * Builds a company's provider account inside its transaction: secrets decrypted in memory only,
 * callback URLs from the route the attempt was created with (or the active one).
 */
@Injectable()
export class PaymentAccounts {
  constructor(
    private readonly crypto: PaymentsCrypto,
    private readonly runtime: PaymentsRuntime,
  ) {}

  async token(tx: Tx, tenantId: string, routeId?: string | null): Promise<{ routeId: string; token: string } | null> {
    const route = routeId
      ? await tx.paymentCallbackRoute.findUnique({ where: { tenantId_id: { tenantId, id: routeId } } })
      : await tx.paymentCallbackRoute.findFirst({ where: { tenantId, status: "active" } });
    if (!route) return null;
    return { routeId: route.id, token: this.crypto.openToken(tenantId, route.id, route.tokenEnc) };
  }

  account(settings: PaymentSettings, token: string): ProviderAccount {
    const open = (field: Parameters<PaymentsCrypto["openSecret"]>[1], value: Uint8Array | null) =>
      value ? this.crypto.openSecret(settings.tenantId, field, value) : null;
    return {
      tenantId: settings.tenantId,
      environment: settings.environment as PaymentEnvironment,
      credentialsVersion: settings.credentialsVersion,
      credentials: {
        consumerKey: open("consumerKey", settings.consumerKeyEnc),
        consumerSecret: open("consumerSecret", settings.consumerSecretEnc),
        initiatorName: open("initiatorName", settings.initiatorNameEnc),
        initiatorPassword: open("initiatorPassword", settings.initiatorPasswordEnc),
        passkey: open("passkey", settings.passkeyEnc),
      },
      shortcodes: {
        stk: settings.stkShortcode,
        stkPartyB: settings.stkPartyB,
        c2b: settings.c2bShortcode,
        b2c: settings.b2cShortcode,
        b2b: settings.b2bShortcode,
      },
      stkTransactionType: settings.stkTransactionType as StkTransactionType,
      callbackUrl: (kind) => this.runtime.callbackUrl(token, callbackPathSegment(kind)),
    };
  }

  async load(tx: Tx, tenantId: string, routeId?: string | null) {
    const settings = await tx.paymentSettings.findUnique({ where: { tenantId } });
    if (!settings) return null;
    const route = await this.token(tx, tenantId, routeId);
    if (!route) return null;
    return { settings, routeId: route.routeId, account: this.account(settings, route.token) };
  }
}
