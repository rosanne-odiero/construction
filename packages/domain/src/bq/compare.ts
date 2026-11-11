import { Decimal } from "decimal.js";
import type { BqAmountSource, BqUnit } from "@pm-buddy/types";
import { versionTotals, type VersionContent, type VersionItem } from "./variation.js";

/** One side of an item in a comparison. */
export interface ComparedValues {
  quantity: string | null;
  rate: string | null;
  amountMinor: number;
  amountSource: BqAmountSource;
}

export interface ItemDifference {
  lineageId: string;
  billNumber: string;
  ref: string | null;
  description: string;
  unit: BqUnit | null;
  unitRaw: string | null;
  from: ComparedValues | null;
  to: ComparedValues | null;
  /** Which values differ (changed items only). */
  fields: ("quantity" | "rate" | "amount" | "amountSource")[];
  differenceMinor: number;
}

export interface BillDifference {
  lineageId: string;
  number: string;
  title: string;
  fromMinor: number | null;
  toMinor: number | null;
  differenceMinor: number;
}

export interface VersionComparison {
  added: ItemDifference[];
  removed: ItemDifference[];
  changed: ItemDifference[];
  bills: BillDifference[];
  totals: {
    from: { subtotalMinor: number; vatMinor: number; grandTotalMinor: number };
    to: { subtotalMinor: number; vatMinor: number; grandTotalMinor: number };
    difference: { subtotalMinor: number; vatMinor: number; grandTotalMinor: number };
  };
}

const values = (item: VersionItem): ComparedValues => ({
  quantity: item.quantity,
  rate: item.rate,
  amountMinor: item.amountMinor,
  amountSource: item.amountSource,
});

const decimalDiffers = (left: string | null, right: string | null) =>
  left === null || right === null ? left !== right : !new Decimal(left).equals(new Decimal(right));

/**
 * Compares two versions of one BQ item by item (matched by lineage, which is stable across
 * versions) and bill by bill (matched by bill lineage): items added, removed and changed
 * (quantity, rate, amount or how the amount is obtained), bill subtotals and the overall
 * difference. Totals use each version's own VAT rate.
 */
export function compareVersions(
  from: { content: VersionContent; vatRatePercent: string },
  to: { content: VersionContent; vatRatePercent: string },
): VersionComparison {
  const fromTotals = versionTotals(from.content, from.vatRatePercent);
  const toTotals = versionTotals(to.content, to.vatRatePercent);
  const billNumber = new Map(
    [...from.content.bills, ...to.content.bills].map((bill) => [bill.lineageId, bill.number]),
  );
  const fromItems = new Map(from.content.items.map((item) => [item.lineageId, item]));
  const toItems = new Map(to.content.items.map((item) => [item.lineageId, item]));
  const billOrder = new Map<string, number>();
  for (const bill of [...to.content.bills, ...from.content.bills])
    if (!billOrder.has(bill.lineageId)) billOrder.set(bill.lineageId, bill.sortOrder);
  const inBillOrder = (items: readonly VersionItem[]) =>
    [...items].sort(
      (left, right) =>
        (billOrder.get(left.billLineageId) ?? 0) - (billOrder.get(right.billLineageId) ?? 0) ||
        left.sortOrder - right.sortOrder,
    );
  const describe = (item: VersionItem) => ({
    lineageId: item.lineageId,
    billNumber: billNumber.get(item.billLineageId) ?? "",
    ref: item.ref,
    description: item.description,
    unit: item.unit,
    unitRaw: item.unitRaw,
  });

  const added: ItemDifference[] = [];
  const removed: ItemDifference[] = [];
  const changed: ItemDifference[] = [];
  for (const item of inBillOrder(to.content.items)) {
    const before = fromItems.get(item.lineageId);
    if (!before) {
      added.push({
        ...describe(item),
        from: null,
        to: values(item),
        fields: [],
        differenceMinor: item.amountMinor,
      });
      continue;
    }
    const fields: ItemDifference["fields"] = [];
    if (decimalDiffers(before.quantity, item.quantity)) fields.push("quantity");
    if (decimalDiffers(before.rate, item.rate)) fields.push("rate");
    if (before.amountMinor !== item.amountMinor) fields.push("amount");
    if (before.amountSource !== item.amountSource) fields.push("amountSource");
    if (fields.length)
      changed.push({
        ...describe(item),
        from: values(before),
        to: values(item),
        fields,
        differenceMinor: item.amountMinor - before.amountMinor,
      });
  }
  for (const item of inBillOrder(from.content.items))
    if (!toItems.has(item.lineageId))
      removed.push({
        ...describe(item),
        from: values(item),
        to: null,
        fields: [],
        differenceMinor: 0 - item.amountMinor,
      });

  const seen = new Set<string>();
  const bills: BillDifference[] = [];
  for (const bill of [...to.content.bills, ...from.content.bills]) {
    if (seen.has(bill.lineageId)) continue;
    seen.add(bill.lineageId);
    const fromMinor = fromTotals.bills[bill.lineageId] ?? null;
    const toMinor = toTotals.bills[bill.lineageId] ?? null;
    bills.push({
      lineageId: bill.lineageId,
      number: bill.number,
      title: bill.title,
      fromMinor,
      toMinor,
      differenceMinor: (toMinor ?? 0) - (fromMinor ?? 0),
    });
  }
  const pick = (totals: typeof fromTotals) => ({
    subtotalMinor: totals.subtotalMinor,
    vatMinor: totals.vatMinor,
    grandTotalMinor: totals.grandTotalMinor,
  });
  return {
    added,
    removed,
    changed,
    bills,
    totals: {
      from: pick(fromTotals),
      to: pick(toTotals),
      difference: {
        subtotalMinor: toTotals.subtotalMinor - fromTotals.subtotalMinor,
        vatMinor: toTotals.vatMinor - fromTotals.vatMinor,
        grandTotalMinor: toTotals.grandTotalMinor - fromTotals.grandTotalMinor,
      },
    },
  };
}
