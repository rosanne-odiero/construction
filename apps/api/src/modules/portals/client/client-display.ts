import { canonicalFxRate, fxRateUsable, nairobiDate } from "@pm-buddy/domain";
import {
  FX_CURRENCIES,
  type DisplayCurrency,
  type FxCurrency,
  type ProjectStatus,
} from "@pm-buddy/types";
import type { ClientDisplay, FxRate } from "@pm-buddy/validation";
import type { Prisma } from "../../../generated/prisma/client.js";
import { peopleOf, personOf, toCalendarDate } from "../../procurement/procurement-mappers.js";

type Tx = Prisma.TransactionClient;
type FxRow = Prisma.FxRateGetPayload<object>;

/** Rates as the API returns them (with whether each may be shown today). */
export async function fxRateWire(tx: Tx, rows: readonly FxRow[], today = nairobiDate()) {
  const people = await peopleOf(
    tx,
    rows.map((row) => row.createdBy),
  );
  return rows.map((row): FxRate => ({
    id: row.id,
    currency: row.currency as FxCurrency,
    kesPerUnit: canonicalFxRate(row.kesPerUnit.toFixed(4)),
    rateDate: toCalendarDate(row.rateDate),
    source: row.source,
    enteredBy: personOf(people, row.createdBy),
    enteredAt: row.createdAt.toISOString(),
    usable: fxRateUsable(toCalendarDate(row.rateDate), today),
  }));
}

/**
 * The newest rate per currency: the latest rate date, and for the same date the latest entry (a
 * correction is a newer entry, rule D-136).
 */
export async function latestRates(tx: Tx, tenantId: string): Promise<FxRow[]> {
  const rows = await Promise.all(
    FX_CURRENCIES.map((currency) =>
      tx.fxRate.findFirst({
        where: { tenantId, currency },
        orderBy: [{ rateDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      }),
    ),
  );
  return rows.filter((row): row is FxRow => row !== null);
}

/** The caller's stored display currency (KES when none is saved). */
export async function storedCurrency(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<DisplayCurrency> {
  const row = await tx.clientPreference.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });
  return (row?.displayCurrency as DisplayCurrency | undefined) ?? "KES";
}

/**
 * How amounts are shown to this caller: their preference (or `override` for one page) and, for a
 * foreign currency, the newest rate when it may be shown today (else null: "not available").
 * Conversions are display only; every amount stays in KES (brief §15 C).
 */
export async function displayFor(
  tx: Tx,
  tenantId: string,
  userId: string,
  override?: DisplayCurrency,
): Promise<ClientDisplay> {
  const currency = override ?? (await storedCurrency(tx, tenantId, userId));
  if (currency === "KES") return { currency, rate: null };
  const row = await tx.fxRate.findFirst({
    where: { tenantId, currency },
    orderBy: [{ rateDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  if (!row || !fxRateUsable(toCalendarDate(row.rateDate), nairobiDate()))
    return { currency, rate: null };
  return {
    currency,
    rate: {
      currency: row.currency as FxCurrency,
      kesPerUnit: canonicalFxRate(row.kesPerUnit.toFixed(4)),
      rateDate: toCalendarDate(row.rateDate),
      source: row.source,
    },
  };
}

/** A project as client portal responses name it. */
export const clientProjectRef = (row: {
  id: string;
  code: string;
  name: string;
  status: string;
}) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  status: row.status as ProjectStatus,
});
