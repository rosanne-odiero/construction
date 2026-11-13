import {
  CONVERSION_ROUNDING,
  MATCH_HEADER_REASONS,
  MATCH_LINE_REASONS,
  MATCH_REASONS_NOT_EXCEPTABLE,
  type EtimsNumberFormat,
  type MatchHeaderReason,
  type MatchLineReason,
  type MatchOutcome,
  type MatchReason,
  type MatchWarning,
} from "@pm-buddy/types";
import { Ratio } from "../materials/ratio.js";
import { documentTotals, perBaseMinor } from "./amounts.js";

/**
 * The three-way match (D5.2, brief §5.3 and §15 G): an LPO (what was ordered, at what price) ↔
 * its Goods Received Notes (what was accepted on site) ↔ a supplier invoice (what is billed), per
 * LPO line, in the material's base unit and net of VAT. Pure and deterministic; the API stores
 * its output as the match evidence and the database repeats the quantity, price, total and eTIMS
 * rules (`app.invoice_match_violations`) before any invoice can be approved or paid.
 *
 * Rules for every LPO line the invoice bills (q = quantity tolerance %, p = price tolerance %):
 * - nothing accepted yet → `not-received`;
 * - already billed by the LPO's other approved invoices + billed now > accepted × (1 + q/100) →
 *   `qty-exceeds-received` (no billing for goods not received, no double billing);
 * - the same cumulative quantity > ordered × (1 + q/100) → `qty-exceeds-ordered`;
 * - invoice net price per base unit > LPO net price per base unit × (1 + p/100) →
 *   `price-above-order` (a lower price is only a warning);
 * - an invoice line for a line that is not on the LPO → `line-not-on-order`.
 * Invoice-level rules: no lines → `invoice-empty`; stated total ≠ stated subtotal + stated VAT →
 * `total-arithmetic`; stated subtotal or VAT further than the rounding allowance (one minor unit
 * per invoice line) from the recomputed figures → `subtotal-mismatch` / `vat-mismatch`; earlier
 * approved invoices + this subtotal > LPO subtotal × (1 + q/100) × (1 + p/100) + allowance →
 * `total-exceeds-order`; no eTIMS number while `procurement.block_payment_without_etims` is on →
 * `etims-missing` (otherwise a warning). Tolerances are inclusive: exactly at the limit passes.
 */

export interface MatchOrderLine {
  lpoLineId: string;
  lineNo: number;
  /** Ordered quantity in the material's base unit (the stored six-decimal value). */
  orderedBaseQuantity: string;
  /** The LPO line's exact net price per base unit (minor units). */
  netPerBase: Ratio;
}

export interface MatchInvoiceLine {
  lpoLineId: string;
  /** Billed quantity in the material's base unit (the stored six-decimal value). */
  baseQuantity: string;
  netPerBase: Ratio;
  /** The line's net amount, already rounded half-up once (`lineNetAmountMinor`). */
  netAmountMinor: number;
  vatable: boolean;
}

export interface ThreeWayMatchInput {
  quantityTolerancePercent: string;
  priceTolerancePercent: string;
  blockWithoutEtims: boolean;
  etims: { number: string | null; format: EtimsNumberFormat | null };
  vatRatePercent: string;
  order: { lines: readonly MatchOrderLine[]; subtotalMinor: number };
  /** Accepted base quantity per LPO line, summed over the LPO's recorded (not voided) GRNs. */
  received: ReadonlyMap<string, string>;
  /** Base quantity per LPO line already billed by the LPO's other approved invoices. */
  previouslyInvoiced: ReadonlyMap<string, string>;
  previouslyInvoicedSubtotalMinor: number;
  invoice: {
    lines: readonly MatchInvoiceLine[];
    subtotalMinor: number;
    vatMinor: number;
    totalMinor: number;
  };
}

export interface MatchLineResult {
  lpoLineId: string;
  lineNo: number;
  orderedQuantity: string;
  receivedQuantity: string;
  previouslyInvoicedQuantity: string;
  invoicedQuantity: string;
  /** Previously invoiced + invoiced now. */
  cumulativeQuantity: string;
  /** The most that may be billed in total: min(accepted, ordered) × (1 + q/100). */
  allowedQuantity: string;
  orderNetUnitPriceMinor: string;
  invoiceNetUnitPriceMinor: string | null;
  allowedNetUnitPriceMinor: string;
  reasons: MatchLineReason[];
  warnings: MatchWarning[];
}

export interface ThreeWayMatchResult {
  outcome: MatchOutcome;
  /** Every distinct failure reason, invoice-level first, in catalogue order. */
  reasons: MatchReason[];
  headerReasons: MatchHeaderReason[];
  warnings: MatchWarning[];
  lines: MatchLineResult[];
  totals: {
    statedSubtotalMinor: number;
    computedSubtotalMinor: number;
    statedVatMinor: number;
    computedVatMinor: number;
    statedTotalMinor: number;
    computedTotalMinor: number;
    roundingAllowanceMinor: number;
    orderSubtotalMinor: number;
    previouslyInvoicedSubtotalMinor: number;
    /** Rounded down to the cent for display; the rule compares exactly. */
    allowedSubtotalMinor: number;
  };
  /** Whether an independent approved exception may override the failure (never eTIMS). */
  exceptable: boolean;
}

const ZERO = Ratio.of(0);
const HUNDRED = Ratio.of(100);
const qty = (value: Ratio) => value.toDecimal(CONVERSION_ROUNDING.decimals).value;
const factor = (percent: string) => Ratio.ONE.plus(Ratio.fromDecimal(percent).dividedBy(HUNDRED));

const ordered = <T extends string>(catalogue: readonly T[], found: Iterable<T>): T[] => {
  const set = new Set(found);
  return catalogue.filter((entry) => set.has(entry));
};

export function threeWayMatch(input: ThreeWayMatchInput): ThreeWayMatchResult {
  const q = factor(input.quantityTolerancePercent);
  const p = factor(input.priceTolerancePercent);
  const headerReasons = new Set<MatchHeaderReason>();
  const lineReasons = new Set<MatchLineReason>();
  const warnings = new Set<MatchWarning>();

  const billed = new Map<string, { quantity: Ratio; prices: Ratio[] }>();
  for (const line of input.invoice.lines) {
    const entry = billed.get(line.lpoLineId) ?? { quantity: ZERO, prices: [] };
    entry.quantity = entry.quantity.plus(Ratio.fromDecimal(line.baseQuantity));
    entry.prices.push(line.netPerBase);
    billed.set(line.lpoLineId, entry);
  }

  const lines: MatchLineResult[] = [];
  const known = new Set<string>();
  for (const order of input.order.lines) {
    known.add(order.lpoLineId);
    const orderedQty = Ratio.fromDecimal(order.orderedBaseQuantity);
    const received = Ratio.fromDecimal(input.received.get(order.lpoLineId) ?? "0");
    const previous = Ratio.fromDecimal(input.previouslyInvoiced.get(order.lpoLineId) ?? "0");
    const now = billed.get(order.lpoLineId);
    const invoiced = now?.quantity ?? ZERO;
    const cumulative = previous.plus(invoiced);
    const byReceipt = received.times(q);
    const byOrder = orderedQty.times(q);
    const allowedPrice = order.netPerBase.times(p);
    const reasons: MatchLineReason[] = [];
    const lineWarnings: MatchWarning[] = [];
    let highest: Ratio | null = null;
    if (now && !invoiced.isZero()) {
      if (received.isZero()) reasons.push("not-received");
      else if (cumulative.compare(byReceipt) > 0) reasons.push("qty-exceeds-received");
      if (cumulative.compare(byOrder) > 0) reasons.push("qty-exceeds-ordered");
      for (const price of now.prices) if (!highest || price.compare(highest) > 0) highest = price;
      if (highest && highest.compare(allowedPrice) > 0) reasons.push("price-above-order");
      if (now.prices.some((price) => price.compare(order.netPerBase) < 0))
        lineWarnings.push("price-below-order");
    }
    for (const reason of reasons) lineReasons.add(reason);
    for (const warning of lineWarnings) warnings.add(warning);
    lines.push({
      lpoLineId: order.lpoLineId,
      lineNo: order.lineNo,
      orderedQuantity: qty(orderedQty),
      receivedQuantity: qty(received),
      previouslyInvoicedQuantity: qty(previous),
      invoicedQuantity: qty(invoiced),
      cumulativeQuantity: qty(cumulative),
      allowedQuantity: qty(byReceipt.compare(byOrder) < 0 ? byReceipt : byOrder),
      orderNetUnitPriceMinor: perBaseMinor(order.netPerBase),
      invoiceNetUnitPriceMinor: highest ? perBaseMinor(highest) : null,
      allowedNetUnitPriceMinor: perBaseMinor(allowedPrice),
      reasons,
      warnings: lineWarnings,
    });
  }
  for (const [lpoLineId, entry] of billed) {
    if (known.has(lpoLineId)) continue;
    lineReasons.add("line-not-on-order");
    lines.push({
      lpoLineId,
      lineNo: 0,
      orderedQuantity: "0",
      receivedQuantity: "0",
      previouslyInvoicedQuantity: "0",
      invoicedQuantity: qty(entry.quantity),
      cumulativeQuantity: qty(entry.quantity),
      allowedQuantity: "0",
      orderNetUnitPriceMinor: "0",
      invoiceNetUnitPriceMinor: perBaseMinor(entry.prices[0] ?? ZERO),
      allowedNetUnitPriceMinor: "0",
      reasons: ["line-not-on-order"],
      warnings: [],
    });
  }

  const invoice = input.invoice;
  const computed = documentTotals(
    invoice.lines.map((line) => ({ netAmountMinor: line.netAmountMinor, vatable: line.vatable })),
    input.vatRatePercent,
  );
  const allowance = Math.max(1, invoice.lines.length);
  if (invoice.lines.length === 0) headerReasons.add("invoice-empty");
  if (invoice.totalMinor !== invoice.subtotalMinor + invoice.vatMinor)
    headerReasons.add("total-arithmetic");
  if (Math.abs(invoice.subtotalMinor - computed.subtotalMinor) > allowance)
    headerReasons.add("subtotal-mismatch");
  if (Math.abs(invoice.vatMinor - computed.vatMinor) > allowance) headerReasons.add("vat-mismatch");
  const allowedSubtotal = Ratio.of(input.order.subtotalMinor)
    .times(q)
    .times(p)
    .plus(Ratio.of(allowance));
  const cumulativeSubtotal = Ratio.of(
    input.previouslyInvoicedSubtotalMinor + computed.subtotalMinor,
  );
  if (cumulativeSubtotal.compare(allowedSubtotal) > 0) headerReasons.add("total-exceeds-order");
  const etims = input.etims.number?.trim() ? input.etims : null;
  if (!etims) {
    if (input.blockWithoutEtims) headerReasons.add("etims-missing");
    else warnings.add("etims-missing");
  } else if (etims.format === "unrecognised") warnings.add("etims-format-unrecognised");

  const header = ordered(MATCH_HEADER_REASONS, headerReasons);
  const reasons: MatchReason[] = [...header, ...ordered(MATCH_LINE_REASONS, lineReasons)];
  return {
    outcome: reasons.length ? "mismatch" : "matched",
    reasons,
    headerReasons: header,
    warnings: [...new Set(warnings)],
    lines,
    totals: {
      statedSubtotalMinor: invoice.subtotalMinor,
      computedSubtotalMinor: computed.subtotalMinor,
      statedVatMinor: invoice.vatMinor,
      computedVatMinor: computed.vatMinor,
      statedTotalMinor: invoice.totalMinor,
      computedTotalMinor: computed.totalMinor,
      roundingAllowanceMinor: allowance,
      orderSubtotalMinor: input.order.subtotalMinor,
      previouslyInvoicedSubtotalMinor: input.previouslyInvoicedSubtotalMinor,
      allowedSubtotalMinor: Number(allowedSubtotal.numerator / allowedSubtotal.denominator),
    },
    exceptable:
      reasons.length > 0 &&
      !reasons.some((reason) =>
        (MATCH_REASONS_NOT_EXCEPTABLE as readonly MatchReason[]).includes(reason),
      ),
  };
}
