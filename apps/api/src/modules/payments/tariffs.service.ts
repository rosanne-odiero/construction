import { ConflictException, Injectable } from "@nestjs/common";
import { addCalendarDays, nairobiDate, tariffCharge, tariffVersionOn } from "@pm-buddy/domain";
import { DEMO_B2C_TARIFF, type TariffBand } from "@pm-buddy/types";
import {
  tariffsResponseSchema,
  type PutTariffRequest,
  type TariffsResponse,
  type TariffVersion,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { uuidv7 } from "../../common/uuid.js";
import type { PaymentTariffVersion, Prisma } from "../../generated/prisma/client.js";
import { AccessPolicy, type Scope } from "../identity/access-policy.js";
import { AuthService, type Principal } from "../identity/auth.service.js";
import { displayNames } from "../labour/labour-mappers.js";
import { toCalendarDate } from "../projects/project-mappers.js";
import { PaymentCommands } from "./payment-commands.js";
import { PaymentLedger } from "./payment-ledger.js";
import { holds, requireOne, requireStepUp } from "./payments-support.js";

type Tx = Prisma.TransactionClient;

/** A tariff version as the payout code uses it (bands parsed, dates as YYYY-MM-DD). */
export type TariffVersionFacts = {
  id: string;
  effectiveFrom: string;
  bands: TariffBand[];
};

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

const bandsOf = (value: Prisma.JsonValue): TariffBand[] =>
  Array.isArray(value)
    ? value.flatMap((band) =>
        typeof band === "object" && band !== null && !Array.isArray(band)
          ? [
              {
                upToMinor: Number((band as Record<string, unknown>)["upToMinor"]),
                chargeMinor: Number((band as Record<string, unknown>)["chargeMinor"]),
              },
            ]
          : [],
      )
    : [];

/**
 * The company's DEMO B2C tariff (packages/types DEMO_B2C_TARIFF, CR-PMT-02), added once with no
 * author when the company has no tariff yet (payments are first configured; the D4.3 migration
 * seeded every company that existed then).
 */
export async function ensureDemoTariff(tx: Tx, tenantId: string): Promise<void> {
  const existing = await tx.paymentTariffVersion.count({ where: { tenantId, kind: "b2c" } });
  if (existing) return;
  await tx.paymentTariffVersion.create({
    data: {
      id: uuidv7(),
      tenantId,
      kind: DEMO_B2C_TARIFF.kind,
      effectiveFrom: date(DEMO_B2C_TARIFF.effectiveFrom),
      status: DEMO_B2C_TARIFF.status,
      bands: DEMO_B2C_TARIFF.bands as unknown as Prisma.InputJsonValue,
      source: DEMO_B2C_TARIFF.source,
      createdBy: null,
    },
  });
}

/** Every B2C tariff version of the company, oldest first. */
export async function tariffVersions(tx: Tx, tenantId: string): Promise<TariffVersionFacts[]> {
  const rows = await tx.paymentTariffVersion.findMany({
    where: { tenantId, kind: "b2c" },
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    bands: bandsOf(row.bands),
  }));
}

/**
 * The estimated charge for paying `amountMinor` on `on` (owner decision 6): the band charge of the
 * version in force that day, or null when no version is in force or it cannot price the amount.
 */
export function chargeOn(
  versions: readonly TariffVersionFacts[],
  on: string,
  amountMinor: number,
): { versionId: string; chargeMinor: number } | null {
  const version = tariffVersionOn(versions, on);
  if (!version) return null;
  const charge = tariffCharge(version.bands, amountMinor);
  return charge === null ? null : { versionId: version.id, chargeMinor: charge };
}

/**
 * The M-Pesa charges tariff (D4.3 §12): effective-dated versions per company, read with
 * payments.view or config.manage and added (never edited) with config.manage and a fresh step-up.
 */
@Injectable()
export class PaymentTariffsService {
  constructor(
    private readonly commands: PaymentCommands,
    private readonly policy: AccessPolicy,
    private readonly auth: AuthService,
    private readonly ledger: PaymentLedger,
  ) {}

  list(principal: Principal, req: Request): Promise<TariffsResponse> {
    return this.commands.read(principal, req, async (scope) => {
      await requireOne(this.policy, scope, ["payments.view", "config.manage"]);
      return this.view(scope);
    });
  }

  put(principal: Principal, req: Request, input: PutTariffRequest) {
    return this.commands.run(principal, req, "payments.tariff.put", input, async (scope) => {
      await this.policy.require(scope, "config.manage");
      requireStepUp(this.auth, scope.principal);
      const { tx, access } = scope;
      const kind = input.kind ?? "b2c";
      const clash = await tx.paymentTariffVersion.findUnique({
        where: {
          tenantId_kind_effectiveFrom: {
            tenantId: access.tenantId,
            kind,
            effectiveFrom: date(input.effectiveFrom),
          },
        },
      });
      if (clash)
        throw new ConflictException({
          code: "tariff-invalid",
          message: "A tariff version already starts on that date; add one with another date.",
        });
      const id = uuidv7();
      await tx.paymentTariffVersion.create({
        data: {
          id,
          tenantId: access.tenantId,
          kind,
          effectiveFrom: date(input.effectiveFrom),
          status: input.status,
          bands: input.bands as unknown as Prisma.InputJsonValue,
          source: input.source,
          createdBy: access.userId,
        },
      });
      await this.ledger.audit(tx, "payments.tariff_added", id, {
        kind,
        effectiveFrom: input.effectiveFrom,
        status: input.status,
        bands: input.bands.length,
      });
      return this.view(scope);
    });
  }

  private async view(scope: Scope): Promise<TariffsResponse> {
    const { tx, access } = scope;
    const rows = await tx.paymentTariffVersion.findMany({
      where: { tenantId: access.tenantId },
      orderBy: [{ kind: "asc" }, { effectiveFrom: "asc" }],
    });
    const today = nairobiDate();
    const names = await displayNames(
      tx,
      rows.map((row) => row.createdBy),
    );
    const inForce = tariffVersionOn(
      rows.map((row) => ({ id: row.id, effectiveFrom: toCalendarDate(row.effectiveFrom) })),
      today,
    );
    const wire = (row: PaymentTariffVersion, index: number): TariffVersion => {
      const next = rows.slice(index + 1).find((other) => other.kind === row.kind);
      return {
        id: row.id,
        kind: row.kind as TariffVersion["kind"],
        effectiveFrom: toCalendarDate(row.effectiveFrom),
        effectiveTo: next ? addCalendarDays(toCalendarDate(next.effectiveFrom), -1) : null,
        inForce: inForce?.id === row.id,
        status: row.status as TariffVersion["status"],
        bands: bandsOf(row.bands),
        source: row.source,
        createdBy: row.createdBy
          ? { id: row.createdBy, displayName: names.get(row.createdBy) ?? "—" }
          : null,
        createdAt: row.createdAt.toISOString(),
      };
    };
    const versions = rows.map(wire);
    return tariffsResponseSchema.parse({
      today,
      versions: [...versions].reverse(),
      inForce: versions.find((version) => version.inForce) ?? null,
      canManage: await holds(this.policy, scope, "config.manage"),
    });
  }
}
