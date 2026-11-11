import { Injectable } from "@nestjs/common";
import { uuidv7 } from "../../common/uuid.js";
import type { BuiltBill, VersionContent, VersionTotals } from "@pm-buddy/domain";
import type { Prisma } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
const CHUNK = 1_000;

export type WrittenCounts = { bills: number; sections: number; items: number };

/**
 * Writes a built BQ's bills, sections and items into a draft version, inside the caller's
 * transaction (so a failure anywhere rolls the whole commit back).
 */
@Injectable()
export class BqVersionWriter {
  async writeContent(
    tx: Tx,
    target: { tenantId: string; versionId: string },
    bills: readonly BuiltBill[],
  ): Promise<WrittenCounts> {
    const { tenantId, versionId } = target;
    const billRows: Prisma.BqBillCreateManyInput[] = [];
    const sectionRows: Prisma.BqSectionCreateManyInput[] = [];
    const itemRows: Prisma.BqItemCreateManyInput[] = [];
    bills.forEach((bill, billOrder) => {
      const billId = uuidv7();
      billRows.push({
        id: billId,
        tenantId,
        versionId,
        number: bill.number,
        title: bill.title,
        kind: bill.kind,
        sortOrder: billOrder,
        totalMinor: BigInt(bill.totalMinor),
        sheetTotalMinor: bill.sheetTotalMinor === null ? null : BigInt(bill.sheetTotalMinor),
        sourceSheet: bill.sheetName,
        lineageId: uuidv7(),
      });
      let itemOrder = 0;
      bill.sections.forEach((section, sectionOrder) => {
        const sectionId = uuidv7();
        sectionRows.push({
          id: sectionId,
          tenantId,
          versionId,
          billId,
          code: section.code,
          title: section.title,
          notes: section.notes,
          sortOrder: sectionOrder,
          totalMinor: BigInt(section.totalMinor),
          lineageId: uuidv7(),
        });
        for (const item of section.items) {
          itemRows.push({
            id: uuidv7(),
            tenantId,
            versionId,
            billId,
            sectionId,
            lineageId: uuidv7(),
            ref: item.ref,
            description: item.description,
            unit: item.unit,
            unitRaw: item.unitRaw,
            quantity: item.quantity,
            rate: item.rate,
            amountMinor: BigInt(item.amountMinor),
            sheetAmountMinor: item.sheetAmountMinor === null ? null : BigInt(item.sheetAmountMinor),
            amountSource: item.amountSource,
            overrideReason: item.overrideReason,
            kind: item.kind,
            notes: item.notes,
            sourceSheet: bill.sheetName,
            sourceRow: item.sheetRow,
            hasFormula: item.hasFormula,
            sortOrder: itemOrder,
          });
          itemOrder += 1;
        }
      });
    });
    if (billRows.length) await tx.bqBill.createMany({ data: billRows });
    for (let start = 0; start < sectionRows.length; start += CHUNK)
      await tx.bqSection.createMany({ data: sectionRows.slice(start, start + CHUNK) });
    for (let start = 0; start < itemRows.length; start += CHUNK)
      await this.writeItems(tx, itemRows.slice(start, start + CHUNK));
    return { bills: billRows.length, sections: sectionRows.length, items: itemRows.length };
  }

  /**
   * Writes a version's content derived from another version (an approved variation): bills,
   * sections and items keep their lineage and get new row IDs; totals come from the domain's
   * versionTotals (the database re-adds them at commit).
   */
  async copyContent(
    tx: Tx,
    target: { tenantId: string; versionId: string },
    content: VersionContent,
    totals: VersionTotals,
  ): Promise<WrittenCounts> {
    const { tenantId, versionId } = target;
    const billIds = new Map(content.bills.map((bill) => [bill.lineageId, uuidv7()]));
    const sectionIds = new Map(content.sections.map((section) => [section.lineageId, uuidv7()]));
    const billRows: Prisma.BqBillCreateManyInput[] = content.bills.map((bill) => ({
      id: billIds.get(bill.lineageId)!,
      tenantId,
      versionId,
      lineageId: bill.lineageId,
      number: bill.number,
      title: bill.title,
      kind: bill.kind,
      sortOrder: bill.sortOrder,
      totalMinor: BigInt(totals.bills[bill.lineageId] ?? 0),
      sheetTotalMinor: bill.sheetTotalMinor === null ? null : BigInt(bill.sheetTotalMinor),
      sourceSheet: bill.sourceSheet,
    }));
    const sectionRows: Prisma.BqSectionCreateManyInput[] = content.sections.map((section) => ({
      id: sectionIds.get(section.lineageId)!,
      tenantId,
      versionId,
      billId: billIds.get(section.billLineageId)!,
      lineageId: section.lineageId,
      code: section.code,
      title: section.title,
      notes: section.notes,
      sortOrder: section.sortOrder,
      totalMinor: BigInt(totals.sections[section.lineageId] ?? 0),
    }));
    const itemRows: Prisma.BqItemCreateManyInput[] = content.items.map((item) => ({
      id: uuidv7(),
      tenantId,
      versionId,
      billId: billIds.get(item.billLineageId)!,
      sectionId: item.sectionLineageId === null ? null : sectionIds.get(item.sectionLineageId)!,
      lineageId: item.lineageId,
      ref: item.ref,
      description: item.description,
      unit: item.unit,
      unitRaw: item.unitRaw,
      quantity: item.quantity,
      rate: item.rate,
      amountMinor: BigInt(item.amountMinor),
      sheetAmountMinor: item.sheetAmountMinor === null ? null : BigInt(item.sheetAmountMinor),
      amountSource: item.amountSource,
      overrideReason: item.overrideReason,
      kind: item.kind,
      notes: item.notes,
      sourceSheet: item.sourceSheet,
      sourceRow: item.sourceRow,
      hasFormula: item.hasFormula,
      sortOrder: item.sortOrder,
    }));
    if (billRows.length) await tx.bqBill.createMany({ data: billRows });
    for (let start = 0; start < sectionRows.length; start += CHUNK)
      await tx.bqSection.createMany({ data: sectionRows.slice(start, start + CHUNK) });
    for (let start = 0; start < itemRows.length; start += CHUNK)
      await this.writeItems(tx, itemRows.slice(start, start + CHUNK));
    return { bills: billRows.length, sections: sectionRows.length, items: itemRows.length };
  }

  /** One chunk of items (a seam the e2e suite uses to force a failure mid-commit). */
  async writeItems(tx: Tx, rows: Prisma.BqItemCreateManyInput[]): Promise<void> {
    await tx.bqItem.createMany({ data: rows });
  }
}
