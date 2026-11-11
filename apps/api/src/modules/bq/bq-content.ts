import type { VersionContent } from "@pm-buddy/domain";
import type { BqAmountSource, BqBillKind, BqItemKind, BqUnit } from "@pm-buddy/types";
import type { Prisma } from "../../generated/prisma/client.js";
import { safeMinor } from "./bq-mappers.js";

type Tx = Prisma.TransactionClient;

/** The content of one version as the domain sees it (lineage-addressed, in bill order). */
export async function loadContent(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<VersionContent> {
  const where = { tenantId, versionId };
  const [bills, sections, items] = await Promise.all([
    tx.bqBill.findMany({ where, orderBy: { sortOrder: "asc" } }),
    tx.bqSection.findMany({ where, orderBy: { sortOrder: "asc" } }),
    tx.bqItem.findMany({ where, orderBy: [{ sortOrder: "asc" }] }),
  ]);
  const billLineage = new Map(bills.map((bill) => [bill.id, bill.lineageId]));
  const billOrder = new Map(bills.map((bill) => [bill.id, bill.sortOrder]));
  const sectionLineage = new Map(sections.map((section) => [section.id, section.lineageId]));
  return {
    bills: bills.map((bill) => ({
      lineageId: bill.lineageId,
      number: bill.number,
      title: bill.title,
      kind: bill.kind as BqBillKind,
      sortOrder: bill.sortOrder,
      sheetTotalMinor: bill.sheetTotalMinor === null ? null : safeMinor(bill.sheetTotalMinor),
      sourceSheet: bill.sourceSheet,
    })),
    sections: sections.map((section) => ({
      lineageId: section.lineageId,
      billLineageId: billLineage.get(section.billId)!,
      code: section.code,
      title: section.title,
      notes: section.notes,
      sortOrder: section.sortOrder,
    })),
    items: [...items]
      .sort(
        (left, right) =>
          (billOrder.get(left.billId) ?? 0) - (billOrder.get(right.billId) ?? 0) ||
          left.sortOrder - right.sortOrder,
      )
      .map((item) => ({
        lineageId: item.lineageId,
        billLineageId: billLineage.get(item.billId)!,
        sectionLineageId: item.sectionId === null ? null : sectionLineage.get(item.sectionId)!,
        ref: item.ref,
        description: item.description,
        unit: item.unit as BqUnit | null,
        unitRaw: item.unitRaw,
        quantity: item.quantity === null ? null : item.quantity.toFixed(),
        rate: item.rate === null ? null : item.rate.toFixed(),
        amountMinor: safeMinor(item.amountMinor),
        sheetAmountMinor: item.sheetAmountMinor === null ? null : safeMinor(item.sheetAmountMinor),
        amountSource: item.amountSource as BqAmountSource,
        overrideReason: item.overrideReason,
        kind: item.kind as BqItemKind,
        notes: item.notes,
        sourceSheet: item.sourceSheet,
        sourceRow: item.sourceRow,
        hasFormula: item.hasFormula,
        sortOrder: item.sortOrder,
      })),
  };
}
