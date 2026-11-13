import { randomBytes } from "node:crypto";
import { ForbiddenException, Injectable } from "@nestjs/common";
import { callbackUrlProblems } from "@pm-buddy/domain";
import {
  DEMO_PAYMENT_LIMITS,
  PAYMENT_SECRET_FIELDS,
  type Permission,
  type PaymentSecretField,
} from "@pm-buddy/types";
import type {
  PaymentSettingsResponse,
  UpdatePaymentCredentialsRequest,
  UpdatePaymentSettingsRequest,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { PaymentSettings, Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { PaymentCommands } from "./payment-commands.js";
import { PaymentLedger } from "./payment-ledger.js";
import { PaymentsCrypto } from "./payments-crypto.js";
import { callbackUrlList, settingsToWire } from "./payments-mappers.js";
import { PaymentsRelay } from "./payments-relay.js";
import { PaymentsRuntime } from "./payments-runtime.js";
import {
  holds,
  notFound,
  paymentConflict,
  requireOne,
  requireStepUp,
  sha256,
  versionConflict,
} from "./payments-support.js";
import { CertificateStore } from "./provider/security-credential.js";
import { DarajaProvider } from "./provider/daraja-provider.js";

type Tx = Prisma.TransactionClient;

/** How long a rotated callback token keeps working, for results of calls already in flight. */
const RETIRED_TOKEN_GRACE_MS = 72 * 3_600_000;

const SECRET_COLUMNS: Record<PaymentSecretField, { enc: keyof PaymentSettings; at: keyof PaymentSettings }> = {
  consumerKey: { enc: "consumerKeyEnc", at: "consumerKeySetAt" },
  consumerSecret: { enc: "consumerSecretEnc", at: "consumerSecretSetAt" },
  initiatorName: { enc: "initiatorNameEnc", at: "initiatorNameSetAt" },
  initiatorPassword: { enc: "initiatorPasswordEnc", at: "initiatorPasswordSetAt" },
  passkey: { enc: "passkeyEnc", at: "passkeySetAt" },
};

/** Hex only: Daraja refuses callback URLs containing words such as "exe", "cmd" or "query". */
export const newCallbackToken = () => randomBytes(32).toString("hex");

/**
 * A company's Daraja settings (D4.2): environment, shortcodes, limits, write-only secrets, the
 * payout master switch and the callback token. Every change needs payments.manage_credentials and
 * a fresh step-up (pausing payouts also accepts payments.review, without step-up, so anyone
 * responsible can stop money leaving quickly). Audit events name the fields changed, never values.
 */
@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly commands: PaymentCommands,
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
    private readonly ledger: PaymentLedger,
    private readonly crypto: PaymentsCrypto,
    private readonly runtime: PaymentsRuntime,
    private readonly certificates: CertificateStore,
    private readonly provider: DarajaProvider,
    private readonly relay: PaymentsRelay,
  ) {}

  private async canAny(scope: Scope, ...permissions: Permission[]) {
    for (const permission of permissions) if (await holds(this.policy, scope, permission)) return true;
    return false;
  }

  async view(scope: Scope): Promise<PaymentSettingsResponse> {
    const { tx, access } = scope;
    await requireOne(this.policy, scope, ["payments.view", "payments.manage_credentials"]);
    const canManage = await this.canAny(scope, "payments.manage_credentials");
    const canPause = canManage || (await this.canAny(scope, "payments.review"));
    const row = await tx.paymentSettings.findUnique({ where: { tenantId: access.tenantId } });
    if (!row) return { configured: false, settings: null, canManage, canPause };
    const route = await tx.paymentCallbackRoute.findFirst({ where: { tenantId: access.tenantId, status: "active" } });
    const token = route ? this.crypto.openToken(access.tenantId, route.id, route.tokenEnc) : null;
    const urls = token ? callbackUrlList((segment) => this.runtime.callbackUrl(token, segment)) : [];
    // URLs are shown to people who manage the credentials only: the token is unguessable by design.
    const visible = canManage ? urls : urls.map((entry) => ({ ...entry, url: entry.url.replace(/hooks\/[0-9a-f]{64}/, "hooks/••••") }));
    const warnings = [...new Set(urls.flatMap((entry) => callbackUrlProblems(entry.url.replace(/hooks\/[0-9a-f]{64}/, "hooks/token"))))];
    const names = await displayNames(tx, [row.payoutsChangedBy, row.credentialsUpdatedBy]);
    return {
      configured: true,
      settings: settingsToWire(row, names, visible, warnings, {
        callbackTokenRotatedAt: route?.createdAt ?? null,
        ipAllowlistEnabled: this.runtime.allowList.length > 0,
        certificateConfigured: this.certificates.configured(row.environment as never),
      }),
      canManage,
      canPause,
    };
  }

  get(principal: Principal, req: Request) {
    return this.commands.read(principal, req, (scope) => this.view(scope));
  }

  private async manage(scope: Scope) {
    await this.policy.require(scope, "payments.manage_credentials");
    requireStepUp(this.auth, scope.principal);
  }

  private async load(tx: Tx, tenantId: string) {
    const row = await tx.paymentSettings.findUnique({ where: { tenantId } });
    if (!row) throw notFound("Payment settings");
    return row;
  }

  private async createRoute(tx: Tx, tenantId: string, userId: string) {
    const id = uuidv7();
    const token = newCallbackToken();
    await tx.paymentCallbackRoute.create({
      data: { id, tenantId, tokenDigest: sha256(token), tokenEnc: this.crypto.sealToken(tenantId, id, token), createdBy: userId },
    });
    return id;
  }

  /** First configuration: mock environment, DEMO limits, payouts off, a fresh callback token. */
  initialise(principal: Principal, req: Request) {
    return this.commands.run(principal, req, "payments.settings.initialise", {}, async (scope) => {
      await this.manage(scope);
      const { tx, access } = scope;
      if (await tx.paymentSettings.findUnique({ where: { tenantId: access.tenantId } }))
        throw paymentConflict("version-conflict", "Payments are already configured for this company.");
      await tx.paymentSettings.create({
        data: {
          tenantId: access.tenantId,
          environment: this.runtime.production ? "sandbox" : "mock",
          stkMaxMinor: DEMO_PAYMENT_LIMITS.stkMaxMinor,
          b2cMinMinor: DEMO_PAYMENT_LIMITS.b2cMinMinor,
          b2cMaxMinor: DEMO_PAYMENT_LIMITS.b2cMaxMinor,
          b2bMaxMinor: DEMO_PAYMENT_LIMITS.b2bMaxMinor,
          dailyPayoutMaxMinor: DEMO_PAYMENT_LIMITS.dailyPayoutMaxMinor,
          createdBy: access.userId,
          updatedBy: access.userId,
        },
      });
      await this.createRoute(tx, access.tenantId, access.userId);
      await this.ledger.event(tx, access.tenantId, {
        subjectType: "settings",
        subjectId: access.tenantId,
        event: "settings.initialised",
        actorId: access.userId,
      });
      await this.ledger.audit(tx, "payments.settings_initialised", access.tenantId, { limitsStatus: "demo" });
      return this.view(scope);
    });
  }

  update(principal: Principal, req: Request, input: UpdatePaymentSettingsRequest) {
    return this.commands.run(principal, req, "payments.settings.update", input, async (scope) => {
      await this.manage(scope);
      if (input.environment === "production")
        throw paymentConflict(
          "production-not-enabled",
          "Production M-Pesa is not enabled: it needs the go-live review (COMPLIANCE-REVIEW CR-PMT-04).",
        );
      if (input.environment === "mock" && this.runtime.production)
        throw paymentConflict("environment-unavailable", "The mock environment is not available in production.");
      const { tx, access } = scope;
      const row = await this.load(tx, access.tenantId);
      if (row.version !== input.version) throw versionConflict();
      const shortcodes = input.shortcodes;
      const changed = [
        row.environment !== input.environment && "environment",
        row.stkShortcode !== shortcodes.stkShortcode && "stkShortcode",
        row.stkPartyB !== shortcodes.stkPartyB && "stkPartyB",
        row.stkTransactionType !== shortcodes.stkTransactionType && "stkTransactionType",
        row.c2bShortcode !== shortcodes.c2bShortcode && "c2bShortcode",
        row.b2cShortcode !== shortcodes.b2cShortcode && "b2cShortcode",
        row.b2bShortcode !== shortcodes.b2bShortcode && "b2bShortcode",
        Number(row.stkMaxMinor) !== input.limits.stkMaxMinor && "stkMaxMinor",
        Number(row.b2cMinMinor) !== input.limits.b2cMinMinor && "b2cMinMinor",
        Number(row.b2cMaxMinor) !== input.limits.b2cMaxMinor && "b2cMaxMinor",
        Number(row.b2bMaxMinor) !== input.limits.b2bMaxMinor && "b2bMaxMinor",
        Number(row.dailyPayoutMaxMinor) !== input.limits.dailyPayoutMaxMinor && "dailyPayoutMaxMinor",
      ].filter((field): field is string => Boolean(field));
      await tx.paymentSettings.update({
        where: { tenantId: access.tenantId },
        data: {
          environment: input.environment,
          ...shortcodes,
          stkMaxMinor: input.limits.stkMaxMinor,
          b2cMinMinor: input.limits.b2cMinMinor,
          b2cMaxMinor: input.limits.b2cMaxMinor,
          b2bMaxMinor: input.limits.b2bMaxMinor,
          dailyPayoutMaxMinor: input.limits.dailyPayoutMaxMinor,
          // Limits a person typed in are still unreviewed placeholders until CR-PMT-02 is closed.
          limitsStatus: "demo",
          updatedBy: access.userId,
          version: row.version + 1,
        },
      });
      await this.ledger.event(tx, access.tenantId, {
        subjectType: "settings",
        subjectId: access.tenantId,
        event: "settings.updated",
        actorId: access.userId,
        detail: { fields: changed.join(",") || "none", environment: input.environment },
      });
      await this.ledger.audit(tx, "payments.settings_updated", access.tenantId, {
        fields: changed,
        environment: input.environment,
      });
      return this.view(scope);
    });
  }

  /** Write-only secrets: sealed, never returned; the audit names the fields replaced. */
  updateCredentials(principal: Principal, req: Request, input: UpdatePaymentCredentialsRequest) {
    const fields = PAYMENT_SECRET_FIELDS.filter((field) => input[field] !== undefined);
    // The fingerprint covers which fields changed, not their values.
    return this.commands.run(principal, req, "payments.credentials.update", { version: input.version, fields }, async (scope) => {
      await this.manage(scope);
      const { tx, access } = scope;
      const row = await this.load(tx, access.tenantId);
      if (row.version !== input.version) throw versionConflict();
      const now = new Date();
      const data: Record<string, unknown> = {};
      for (const field of fields) {
        data[SECRET_COLUMNS[field].enc] = this.crypto.sealSecret(access.tenantId, field, input[field]!);
        data[SECRET_COLUMNS[field].at] = now;
      }
      await tx.paymentSettings.update({
        where: { tenantId: access.tenantId },
        data: {
          ...(data as Prisma.PaymentSettingsUpdateInput),
          credentialsVersion: row.credentialsVersion + 1,
          credentialsUpdatedAt: now,
          credentialsUpdatedBy: access.userId,
          updatedBy: access.userId,
          version: row.version + 1,
        },
      });
      await this.ledger.event(tx, access.tenantId, {
        subjectType: "settings",
        subjectId: access.tenantId,
        event: "settings.credentials_changed",
        actorId: access.userId,
        detail: { fields: fields.join(",") },
      });
      await this.ledger.audit(tx, "payments.credentials_changed", access.tenantId, { fields });
      await this.provider.invalidateToken({
        tenantId: access.tenantId,
        environment: row.environment as never,
        credentialsVersion: row.credentialsVersion,
      });
      return this.view(scope);
    });
  }

  /**
   * The payout master switch (brief §15 D): off by default. Off blocks every new outbound provider
   * call (B2C, B2B, reversals) without touching queued attempts; collections continue.
   */
  setPayouts(principal: Principal, req: Request, input: { version: number; enabled: boolean; reason: string }) {
    return this.commands.run(principal, req, "payments.payouts.switch", input, async (scope) => {
      if (input.enabled) await this.manage(scope);
      else await requireOne(this.policy, scope, ["payments.manage_credentials", "payments.review"]);
      const { tx, access } = scope;
      const row = await this.load(tx, access.tenantId);
      if (row.version !== input.version) throw versionConflict();
      await tx.paymentSettings.update({
        where: { tenantId: access.tenantId },
        data: {
          payoutsEnabled: input.enabled,
          payoutsChangedBy: access.userId,
          updatedBy: access.userId,
          version: row.version + 1,
        },
      });
      await this.ledger.event(tx, access.tenantId, {
        subjectType: "settings",
        subjectId: access.tenantId,
        event: input.enabled ? "settings.payouts_enabled" : "settings.payouts_paused",
        actorId: access.userId,
      });
      await this.ledger.audit(
        tx,
        input.enabled ? "payments.payouts_enabled" : "payments.payouts_paused",
        access.tenantId,
        { environment: row.environment },
      );
      if (input.enabled) {
        // Submissions that waited for the switch become due now (nothing else about them changes).
        await tx.paymentOutbox.updateMany({
          where: {
            tenantId: access.tenantId,
            topic: "attempt.submit",
            processedAt: null,
            deadAt: null,
            lastError: "payouts-disabled",
          },
          data: { availableAt: new Date(), dispatchedAt: null },
        });
        this.relay.kick();
      }
      return this.view(scope);
    });
  }

  /** New callback token; the old one keeps accepting results for 72 hours (calls in flight). */
  rotateToken(principal: Principal, req: Request, input: { version: number; reason: string }) {
    return this.commands.run(principal, req, "payments.callback_token.rotate", input, async (scope) => {
      await this.manage(scope);
      const { tx, access } = scope;
      const row = await this.load(tx, access.tenantId);
      if (row.version !== input.version) throw versionConflict();
      const active = await tx.paymentCallbackRoute.findFirst({ where: { tenantId: access.tenantId, status: "active" } });
      if (active)
        await tx.paymentCallbackRoute.update({
          where: { tenantId_id: { tenantId: access.tenantId, id: active.id } },
          data: { status: "retired", retiredBy: access.userId, acceptUntil: new Date(Date.now() + RETIRED_TOKEN_GRACE_MS) },
        });
      const routeId = await this.createRoute(tx, access.tenantId, access.userId);
      await tx.paymentSettings.update({
        where: { tenantId: access.tenantId },
        data: { updatedBy: access.userId, version: row.version + 1 },
      });
      await this.ledger.event(tx, access.tenantId, {
        subjectType: "settings",
        subjectId: access.tenantId,
        event: "settings.callback_token_rotated",
        actorId: access.userId,
      });
      await this.ledger.audit(tx, "payments.callback_token_rotated", routeId, {
        retiredRouteId: active?.id ?? null,
      });
      return this.view(scope);
    });
  }

  /** Registers the C2B confirmation and validation URLs (a provider call made by the worker). */
  registerC2b(principal: Principal, req: Request) {
    return this.commands.run(principal, req, "payments.c2b.register", {}, async (scope) => {
      await this.manage(scope);
      const { tx, access } = scope;
      const row = await this.load(tx, access.tenantId);
      if (!row.c2bShortcode) throw paymentConflict("payments-not-configured", "Set the C2B shortcode first.");
      const query = await tx.providerQuery.create({
        data: { tenantId: access.tenantId, kind: "c2b_register", status: "sent", requestedBy: access.userId },
      });
      await this.ledger.enqueue(tx, access.tenantId, "c2b.register", query.id);
      await this.ledger.audit(tx, "payments.c2b_registration_requested", query.id, {});
      this.relay.kick();
      return this.view(scope);
    });
  }

  /** Throws 403 unless the caller may run a float check. */
  async assertBalanceAccess(scope: Scope) {
    if (!(await this.canAny(scope, "payments.review", "payments.manage_credentials", "payments.initiate_test")))
      throw new ForbiddenException("Permission required: payments.review");
  }
}
