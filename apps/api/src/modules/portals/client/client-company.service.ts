import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { canonicalFxRate, fxRateUsable, nairobiDate } from "@pm-buddy/domain";
import {
  CLIENT_PORTAL_LIMITS,
  FX_CURRENCIES,
  FX_RATE_PERMISSIONS,
  PAYMENT_INSTRUCTIONS_PERMISSIONS,
  type Permission,
} from "@pm-buddy/types";
import {
  fxRatesResponseSchema,
  paymentInstructionsResponseSchema,
  type CreateFxRateRequest,
  type UpdatePaymentInstructionsRequest,
} from "@pm-buddy/validation";
import { latestInstructions } from "../../finance/client-ledger.js";
import { AccessPolicy, type Scope } from "../../identity/access-policy.js";
import type { Principal } from "../../identity/auth.service.js";
import { TenantScope } from "../../identity/tenant-scope.service.js";
import { peopleOf, personOf } from "../../procurement/procurement-mappers.js";
import { clientPortalProblem } from "./client-portal-access.js";
import { instructionsWire } from "./client-portal.service.js";
import { fxRateWire, latestRates } from "./client-display.js";

/** Who reads the company's Paybill instructions and FX rates (staff who set or use them). */
const COMPANY_READERS = [
  "config.manage",
  "finance.view",
  "finance.manage",
] as const satisfies readonly Permission[];

/**
 * Company settings of the client portal (D7.1, CONFIGURATION "Client portal"): the C2B Paybill
 * instructions clients follow (config.manage with step-up; versioned, append-only, audited) and
 * indicative FX rates for the display currency (company-wide finance.manage or config.manage;
 * dated entries with a source note; never fetched from an external service).
 */
@Injectable()
export class ClientCompanyService {
  constructor(
    private readonly scope: TenantScope,
    private readonly policy: AccessPolicy,
  ) {}

  instructions(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.reader(scope);
      return this.instructionsView(scope);
    });
  }

  updateInstructions(principal: Principal, input: UpdatePaymentInstructionsRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        // Paybill details redirect clients' money: a fresh second factor, and every change is a
        // new audited version (THREAT_MODEL A-113).
        await this.policy.require(scope, "config.manage", { stepUp: true });
        const latest = await latestInstructions(tx, access.tenantId);
        if ((latest?.version ?? 0) !== input.version)
          throw clientPortalProblem(
            409,
            "version-conflict",
            "These instructions were changed by someone else. Reload and try again.",
          );
        const version = input.version + 1;
        await tx.clientPaymentInstructions.create({
          data: {
            tenantId: access.tenantId,
            version,
            paybillNumber: input.paybillNumber ?? null,
            tillNumber: input.tillNumber ?? null,
            accountName: input.accountName,
            accountFormat: input.accountFormat,
            bankInstructions: input.bankInstructions?.trim() ? input.bankInstructions.trim() : null,
            createdBy: access.userId,
          },
        });
        await this.scope.audit(tx, "client_portal.payment_instructions_changed", access.tenantId, {
          version,
          paybillChanged: (latest?.paybillNumber ?? null) !== (input.paybillNumber ?? null),
          tillChanged: (latest?.tillNumber ?? null) !== (input.tillNumber ?? null),
          accountFormat: input.accountFormat,
        });
        return this.instructionsView(scope);
      },
      true,
    );
  }

  rates(principal: Principal, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      await this.reader(scope);
      return this.ratesView(scope);
    });
  }

  createRate(principal: Principal, input: CreateFxRateRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const { tx, access } = scope;
        if (!this.canEnterRates(scope))
          throw new ForbiddenException(
            "Company-wide finance.manage or config.manage is required to enter FX rates",
          );
        if (input.rateDate > nairobiDate())
          throw clientPortalProblem(422, "fx-rate-invalid", "A rate is dated today or earlier");
        const created = await tx.fxRate.create({
          data: {
            tenantId: access.tenantId,
            currency: input.currency,
            kesPerUnit: canonicalFxRate(input.kesPerUnit),
            rateDate: new Date(`${input.rateDate}T00:00:00.000Z`),
            source: input.source,
            createdBy: access.userId,
          },
        });
        await this.scope.audit(tx, "client_portal.fx_rate_entered", created.id, {
          currency: input.currency,
          rateDate: input.rateDate,
        });
        return this.ratesView(scope);
      },
      true,
    );
  }

  // Helpers -------------------------------------------------------------------------------------

  private async reader(scope: Scope) {
    const { permissions } = scope.access;
    if (!COMPANY_READERS.some((permission) => permissions.has(permission)))
      throw new ForbiddenException(
        `One of these permissions is required: ${COMPANY_READERS.join(", ")}`,
      );
  }

  /** finance.manage is project-scoped, so rates need it company-wide (or config.manage). */
  private canEnterRates(scope: Scope): boolean {
    const { permissions, tenantWide } = scope.access;
    return FX_RATE_PERMISSIONS.some(
      (permission) => permissions.has(permission) && (permission === "config.manage" || tenantWide),
    );
  }

  private async instructionsView(scope: Scope) {
    const { tx, access } = scope;
    const row = await latestInstructions(tx, access.tenantId);
    const people = await peopleOf(tx, [row?.createdBy]);
    return paymentInstructionsResponseSchema.parse({
      instructions: instructionsWire(row),
      updatedBy: row ? personOf(people, row.createdBy) : null,
      permissions: {
        canEdit: PAYMENT_INSTRUCTIONS_PERMISSIONS.some((permission) =>
          access.permissions.has(permission),
        ),
      },
    });
  }

  private async ratesView(scope: Scope) {
    const { tx, access } = scope;
    const today = nairobiDate();
    const rows = await tx.fxRate.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ rateDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: CLIENT_PORTAL_LIMITS.fxRatesListed,
    });
    const latest = await fxRateWire(tx, await latestRates(tx, access.tenantId), today);
    return fxRatesResponseSchema.parse({
      rates: await fxRateWire(tx, rows, today),
      current: FX_CURRENCIES.map((currency) => {
        const rate = latest.find((row) => row.currency === currency) ?? null;
        return { currency, rate: rate && fxRateUsable(rate.rateDate, today) ? rate : null };
      }),
      permissions: { canEnter: this.canEnterRates(scope) },
    });
  }
}
