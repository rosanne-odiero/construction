import { Decimal } from "decimal.js";
import type {
  BqAmountSource,
  BqBillKind,
  BqItemKind,
  BqUnit,
  VariationAddKind,
  VariationLineAction,
  VariationLineIssue,
} from "@pm-buddy/types";
import { lineAmountFromRate } from "../money.js";
import { vatMinor } from "./build.js";

/**
 * Variation Orders applied to a BQ version (D2.3, brief §5.2/§15 C). Pure functions over a plain
 * copy of a version's content, so the API, the mock API and the tests share one implementation.
 *
 * Money rules are D2.2's: a computed line is quantity × rate rounded half-up to the cent once per
 * line; a bill total is the sum of its rounded lines; VAT is computed once on the subtotal,
 * half-up to the cent, at the rate snapshotted on the base version; grand = subtotal + VAT.
 */

export interface VersionBill {
  lineageId: string;
  number: string;
  title: string;
  kind: BqBillKind;
  sortOrder: number;
  sheetTotalMinor: number | null;
  sourceSheet: string;
}

export interface VersionSection {
  lineageId: string;
  billLineageId: string;
  code: string | null;
  title: string | null;
  notes: string | null;
  sortOrder: number;
}

export interface VersionItem {
  lineageId: string;
  billLineageId: string;
  sectionLineageId: string | null;
  ref: string | null;
  description: string;
  unit: BqUnit | null;
  unitRaw: string | null;
  quantity: string | null;
  rate: string | null;
  amountMinor: number;
  sheetAmountMinor: number | null;
  amountSource: BqAmountSource;
  overrideReason: string | null;
  kind: BqItemKind;
  notes: string | null;
  sourceSheet: string | null;
  sourceRow: number | null;
  hasFormula: boolean;
  sortOrder: number;
}

export interface VersionContent {
  bills: VersionBill[];
  sections: VersionSection[];
  items: VersionItem[];
}

export interface VersionTotals {
  subtotalMinor: number;
  vatMinor: number;
  grandTotalMinor: number;
  billCount: number;
  itemCount: number;
  /** Bill and section totals by lineage. */
  bills: Record<string, number>;
  sections: Record<string, number>;
}

/** A variation line as entered (decimal strings for quantities and rates, minor units for money). */
export interface VariationLineInput {
  action: VariationLineAction;
  /** adjust/omit: the item changed (stable across versions). */
  itemLineageId: string | null;
  /** add: the bill the new item goes into. */
  billLineageId: string | null;
  /** add: an existing section of that bill… */
  sectionLineageId: string | null;
  /** …or a new section (lines naming the same bill, code and title share it). */
  newSection: { code: string | null; title: string } | null;
  /** add: the new item's lineage, fixed when the line is created. */
  newLineageId: string | null;
  ref: string | null;
  description: string | null;
  unit: BqUnit | null;
  unitRaw: string | null;
  kind: VariationAddKind | null;
  /** adjust: the new quantity (null keeps the base); add: the quantity. */
  quantity: string | null;
  /** adjust: the new rate (null keeps the base); add: the rate. */
  rate: string | null;
  /** An amount-only line (lump sum or daywork allowance): no rate. */
  amountMinor: number | null;
  note: string | null;
}

export type VariationLineError = VariationLineIssue;

/** What a line does to its item, with the money effect against the base version. */
export interface PricedLine {
  baseAmountMinor: number;
  newAmountMinor: number;
  deltaMinor: number;
  quantity: string | null;
  rate: string | null;
  amountSource: BqAmountSource;
  /** The line leaves the item exactly as it is in the base version. */
  noChange: boolean;
}

export type PriceResult =
  { ok: true; priced: PricedLine } | { ok: false; error: VariationLineError };

const sameDecimal = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : new Decimal(left).equals(new Decimal(right));

const canonicalDecimal = (value: string | null): string | null =>
  value === null ? null : new Decimal(value).toFixed();

/** Prices one line against the base version's items and bills (no cross-line checks). */
export function priceVariationLine(line: VariationLineInput, base: VersionContent): PriceResult {
  if (line.action === "add") {
    if (!line.billLineageId || !base.bills.some((bill) => bill.lineageId === line.billLineageId))
      return { ok: false, error: "bill-not-found" };
    if (line.sectionLineageId) {
      const section = base.sections.find((entry) => entry.lineageId === line.sectionLineageId);
      if (!section) return { ok: false, error: "section-not-found" };
      if (section.billLineageId !== line.billLineageId)
        return { ok: false, error: "section-not-in-bill" };
    } else if (!line.newSection?.title.trim()) return { ok: false, error: "section-required" };
    if (!line.description?.trim()) return { ok: false, error: "description-required" };
    if (!line.kind) return { ok: false, error: "kind-required" };
    if (line.amountMinor !== null) {
      if (line.rate !== null) return { ok: false, error: "amount-or-rate" };
      return {
        ok: true,
        priced: {
          baseAmountMinor: 0,
          newAmountMinor: line.amountMinor,
          deltaMinor: line.amountMinor,
          quantity: canonicalDecimal(line.quantity),
          rate: null,
          amountSource: "fixed",
          noChange: false,
        },
      };
    }
    if (line.quantity === null || line.rate === null)
      return { ok: false, error: "quantity-and-rate-required" };
    if (!line.unit) return { ok: false, error: "unit-required" };
    const amount = lineAmountFromRate(line.quantity, line.rate);
    return {
      ok: true,
      priced: {
        baseAmountMinor: 0,
        newAmountMinor: amount,
        deltaMinor: amount,
        quantity: canonicalDecimal(line.quantity),
        rate: canonicalDecimal(line.rate),
        amountSource: "computed",
        noChange: false,
      },
    };
  }

  const item = base.items.find((entry) => entry.lineageId === line.itemLineageId);
  if (!item) return { ok: false, error: "item-not-found" };
  if (line.action === "omit") {
    // Omitting an item that is already omitted changes nothing (possible after a rebase).
    return {
      ok: true,
      priced: {
        baseAmountMinor: item.amountMinor,
        newAmountMinor: 0,
        deltaMinor: 0 - item.amountMinor,
        quantity: item.quantity === null ? null : "0",
        rate: item.rate,
        amountSource: "omitted",
        noChange: item.amountSource === "omitted",
      },
    };
  }

  // adjust
  let priced: Omit<PricedLine, "baseAmountMinor" | "deltaMinor" | "noChange">;
  if (line.amountMinor !== null) {
    if (line.rate !== null) return { ok: false, error: "amount-or-rate" };
    priced = {
      newAmountMinor: line.amountMinor,
      quantity: canonicalDecimal(line.quantity ?? item.quantity),
      rate: null,
      amountSource: "fixed",
    };
  } else {
    if (line.quantity === null && line.rate === null) return { ok: false, error: "line-no-change" };
    const quantity = line.quantity ?? item.quantity;
    const rate = line.rate ?? item.rate;
    if (quantity === null || rate === null)
      return { ok: false, error: "quantity-and-rate-required" };
    priced = {
      newAmountMinor: lineAmountFromRate(quantity, rate),
      quantity: canonicalDecimal(quantity),
      rate: canonicalDecimal(rate),
      amountSource: "computed",
    };
  }
  const noChange =
    priced.amountSource === item.amountSource &&
    priced.newAmountMinor === item.amountMinor &&
    sameDecimal(priced.quantity, item.quantity) &&
    sameDecimal(priced.rate, item.rate);
  return {
    ok: true,
    priced: {
      ...priced,
      baseAmountMinor: item.amountMinor,
      deltaMinor: priced.newAmountMinor - item.amountMinor,
      noChange,
    },
  };
}

export type LinesCheck =
  { ok: true; priced: PricedLine[] } | { ok: false; index: number; error: VariationLineError };

/**
 * Prices every line and checks the set: an item may be the target of at most one adjust/omit
 * line, and every add line needs its own new lineage. `allowNoChange` is used after a rebase,
 * where a line may have become a no-op and is shown for review instead of refused.
 */
export function priceVariationLines(
  lines: readonly VariationLineInput[],
  base: VersionContent,
  options: { allowNoChange?: boolean } = {},
): LinesCheck {
  const targets = new Set<string>();
  const priced: PricedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const key = line.action === "add" ? `new:${line.newLineageId}` : `item:${line.itemLineageId}`;
    if (targets.has(key)) return { ok: false, index, error: "duplicate-target" };
    targets.add(key);
    const result = priceVariationLine(line, base);
    if (!result.ok) return { ok: false, index, error: result.error };
    if (result.priced.noChange && !options.allowNoChange)
      return { ok: false, index, error: "line-no-change" };
    priced.push(result.priced);
  }
  return { ok: true, priced };
}

export interface VariationTotals {
  /** Sum of the increases (≥ 0). */
  additionsMinor: number;
  /** Sum of the decreases as a positive number (≥ 0). */
  omissionsMinor: number;
  /** additions − omissions (excluding VAT). */
  netMinor: number;
}

/**
 * The totals a variation would give its base version: applying the lines changes the subtotal by
 * exactly the net (the sum of the line deltas), and VAT is recomputed once on the new subtotal at
 * the base version's rate. `grandTotalEffectMinor` is the change in the grand total.
 */
export function projectedTotals(
  base: { subtotalMinor: number; grandTotalMinor: number },
  netMinor: number,
  vatRatePercent: string,
): {
  subtotalMinor: number;
  vatMinor: number;
  grandTotalMinor: number;
  grandTotalEffectMinor: number;
} {
  const subtotalMinor = base.subtotalMinor + netMinor;
  if (!Number.isSafeInteger(subtotalMinor)) throw new RangeError("Subtotal out of range");
  const vat = vatMinor(subtotalMinor, vatRatePercent);
  return {
    subtotalMinor,
    vatMinor: vat,
    grandTotalMinor: subtotalMinor + vat,
    grandTotalEffectMinor: subtotalMinor + vat - base.grandTotalMinor,
  };
}

export function variationTotals(
  priced: readonly Pick<PricedLine, "deltaMinor">[],
): VariationTotals {
  let additions = new Decimal(0);
  let omissions = new Decimal(0);
  for (const line of priced) {
    if (line.deltaMinor > 0) additions = additions.plus(line.deltaMinor);
    else omissions = omissions.plus(-line.deltaMinor);
  }
  const safe = (value: Decimal) => {
    const result = value.toNumber();
    if (!Number.isSafeInteger(result)) throw new RangeError("Variation total out of range");
    return result;
  };
  return {
    additionsMinor: safe(additions),
    omissionsMinor: safe(omissions),
    netMinor: safe(additions.minus(omissions)),
  };
}

/** Bill, section, subtotal, VAT and grand totals of a version's content (D2.2 rules). */
export function versionTotals(content: VersionContent, vatRatePercent: string): VersionTotals {
  const bills: Record<string, Decimal> = {};
  const sections: Record<string, Decimal> = {};
  for (const bill of content.bills) bills[bill.lineageId] = new Decimal(0);
  for (const section of content.sections) sections[section.lineageId] = new Decimal(0);
  for (const item of content.items) {
    bills[item.billLineageId] = (bills[item.billLineageId] ?? new Decimal(0)).plus(
      item.amountMinor,
    );
    if (item.sectionLineageId)
      sections[item.sectionLineageId] = (sections[item.sectionLineageId] ?? new Decimal(0)).plus(
        item.amountMinor,
      );
  }
  const toNumbers = (record: Record<string, Decimal>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => {
        const result = value.toNumber();
        if (!Number.isSafeInteger(result)) throw new RangeError("Total out of range");
        return [key, result];
      }),
    );
  const billTotals = toNumbers(bills);
  const subtotal = Object.values(billTotals).reduce(
    (sum, value) => sum.plus(value),
    new Decimal(0),
  );
  const subtotalMinor = subtotal.toNumber();
  if (!Number.isSafeInteger(subtotalMinor)) throw new RangeError("Subtotal out of range");
  const vat = vatMinor(subtotalMinor, vatRatePercent);
  return {
    subtotalMinor,
    vatMinor: vat,
    grandTotalMinor: subtotalMinor + vat,
    billCount: content.bills.length,
    itemCount: content.items.length,
    bills: billTotals,
    sections: toNumbers(sections),
  };
}

const sectionKey = (billLineageId: string, section: { code: string | null; title: string }) =>
  JSON.stringify([billLineageId, section.code?.trim() ?? "", section.title.trim().toLowerCase()]);

export interface AppliedVariation {
  content: VersionContent;
  totals: VersionTotals;
  counts: { adjusted: number; omitted: number; added: number; newSections: number };
}

/**
 * Applies priced lines to a copy of the base version: changed and omitted items keep their
 * lineage (an omitted item stays with quantity 0 and amount 0), new items join their section
 * after its last item, new sections join the end of their bill, and every item's position in its
 * bill is renumbered. `newId` supplies lineage IDs for new sections. The base is not modified.
 */
export function applyVariation(
  base: VersionContent,
  lines: readonly VariationLineInput[],
  priced: readonly PricedLine[],
  vatRatePercent: string,
  newId: () => string,
): AppliedVariation {
  const bills = base.bills.map((bill) => ({ ...bill }));
  const sections = base.sections.map((section) => ({ ...section }));
  const items = base.items.map((item) => ({ ...item }));
  const byLineage = new Map(items.map((item) => [item.lineageId, item]));
  const newSections = new Map<string, VersionSection>();
  const counts = { adjusted: 0, omitted: 0, added: 0, newSections: 0 };
  // Items keep their bill position; new ones are placed after their section's items below.
  const order = new Map<string, number>(items.map((item) => [item.lineageId, item.sortOrder]));

  lines.forEach((line, index) => {
    const result = priced[index]!;
    if (line.action !== "add") {
      const item = byLineage.get(line.itemLineageId!)!;
      item.quantity = result.quantity;
      item.rate = result.rate;
      item.amountMinor = result.newAmountMinor;
      item.amountSource = result.amountSource;
      if (result.amountSource !== "sheet_override") item.overrideReason = null;
      if (line.action === "omit") counts.omitted += 1;
      else counts.adjusted += 1;
      return;
    }
    let sectionLineageId = line.sectionLineageId;
    if (!sectionLineageId) {
      const key = sectionKey(line.billLineageId!, line.newSection!);
      let section = newSections.get(key);
      if (!section) {
        const inBill = sections.filter((entry) => entry.billLineageId === line.billLineageId);
        section = {
          lineageId: newId(),
          billLineageId: line.billLineageId!,
          code: line.newSection!.code?.trim() || null,
          title: line.newSection!.title.trim(),
          notes: null,
          sortOrder: inBill.length ? Math.max(...inBill.map((entry) => entry.sortOrder)) + 1 : 0,
        };
        newSections.set(key, section);
        sections.push(section);
        counts.newSections += 1;
      }
      sectionLineageId = section.lineageId;
    }
    const bill = bills.find((entry) => entry.lineageId === line.billLineageId)!;
    const added: VersionItem = {
      lineageId: line.newLineageId!,
      billLineageId: bill.lineageId,
      sectionLineageId,
      ref: line.ref?.trim() || null,
      description: line.description!.trim(),
      unit: line.unit,
      unitRaw: line.unitRaw,
      quantity: result.quantity,
      rate: result.rate,
      amountMinor: result.newAmountMinor,
      sheetAmountMinor: null,
      amountSource: result.amountSource,
      overrideReason: null,
      kind: line.kind!,
      notes: line.note?.trim() || null,
      sourceSheet: null,
      sourceRow: null,
      hasFormula: false,
      sortOrder: 0,
    };
    items.push(added);
    counts.added += 1;
  });

  // Renumber each bill's items: by section order, then the original position, new items last.
  const sectionOrder = new Map(sections.map((section) => [section.lineageId, section.sortOrder]));
  const positioned = items.map((item, index) => ({
    item,
    section: item.sectionLineageId === null ? -1 : (sectionOrder.get(item.sectionLineageId) ?? 0),
    position: order.get(item.lineageId) ?? Number.MAX_SAFE_INTEGER,
    index,
  }));
  positioned.sort(
    (left, right) =>
      left.section - right.section || left.position - right.position || left.index - right.index,
  );
  const counters = new Map<string, number>();
  const ordered = positioned.map(({ item }) => {
    const next = counters.get(item.billLineageId) ?? 0;
    counters.set(item.billLineageId, next + 1);
    return { ...item, sortOrder: next };
  });
  const content = { bills, sections, items: ordered };
  return { content, totals: versionTotals(content, vatRatePercent), counts };
}

/**
 * The canonical text of a submitted proposal. Submission stores its SHA-256 digest; approval
 * recomputes it from the stored lines and base version and refuses a mismatch (variation-stale),
 * so an approval always binds to exactly what was submitted (brief §15 C).
 */
export function variationSnapshotText(input: {
  variationId: string;
  instructionId: string;
  baseVersionId: string;
  baseGrandTotalMinor: number;
  vatRatePercent: string;
  lines: readonly (VariationLineInput & Pick<PricedLine, "baseAmountMinor" | "newAmountMinor">)[];
  totals: VariationTotals;
}): string {
  return JSON.stringify([
    "pm-buddy.variation.v1",
    input.variationId,
    input.instructionId,
    input.baseVersionId,
    input.baseGrandTotalMinor,
    new Decimal(input.vatRatePercent).toFixed(),
    input.lines.map((line) => [
      line.action,
      line.itemLineageId,
      line.billLineageId,
      line.sectionLineageId,
      line.newSection ? [line.newSection.code, line.newSection.title] : null,
      line.newLineageId,
      line.ref,
      line.description,
      line.unit,
      line.unitRaw,
      line.kind,
      canonicalDecimal(line.quantity),
      canonicalDecimal(line.rate),
      line.amountMinor,
      line.note,
      line.baseAmountMinor,
      line.newAmountMinor,
    ]),
    [input.totals.additionsMinor, input.totals.omissionsMinor, input.totals.netMinor],
  ]);
}
