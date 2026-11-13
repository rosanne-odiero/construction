"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { classifyEtimsInvoiceNumber, Ratio } from "@pm-buddy/domain";
import { VAT_TREATMENTS, type StandardUnitCode, type VatTreatment } from "@pm-buddy/types";
import {
  invoiceDetailResponseSchema,
  procurementDocumentResponseSchema,
  type LpoDetailResponse,
  type UnitWire,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatKES } from "@/lib/format";
import { liveRequest, liveUpload } from "@/lib/live-api";
import {
  formatQuantity,
  inputToMinor,
  invoiceTotals,
  minorToInput,
  remainingQuantity,
  scaleQuantity,
} from "@/lib/p2p";
import { unitLabel } from "@/lib/procurement";
import { useP2pProblem } from "./use-p2p-problem";

type LpoLine = LpoDetailResponse["lines"][number];
type LineInput = {
  include: boolean;
  quantity: string;
  unit: string;
  price: string;
  vat: VatTreatment;
};
export type InvoiceInitial = {
  id: string;
  version: number;
  invoiceNumber: string;
  invoiceDate: string;
  etims: string | null;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  notes: string | null;
  lines: {
    lpoLineId: string;
    quantity: string;
    unit: string;
    unitPriceMinor: number;
    vatTreatment: VatTreatment;
  }[];
};

/** Price units in one base unit for the units this form offers (the line's unit or the base). */
function unitsPerBase(line: LpoLine, unit: string): Ratio {
  if (unit === line.material.baseUnit) return Ratio.ONE;
  return Ratio.fromDecimal(line.quantity).dividedBy(Ratio.fromDecimal(line.baseQuantity));
}

/** The LPO's price per the line's unit as written on an invoice (VAT treatment kept). */
function defaultPrice(line: LpoLine, vatRate: string): number {
  if (line.priceUnit === line.unit) return line.unitPriceMinor;
  const perLineUnit = Ratio.fromDecimal(line.netUnitPriceBaseMinor)
    .times(Ratio.fromDecimal(line.baseQuantity))
    .dividedBy(Ratio.fromDecimal(line.quantity));
  const gross =
    line.vatTreatment === "inclusive"
      ? perLineUnit.times(Ratio.of(100).plus(Ratio.fromDecimal(vatRate))).dividedBy(Ratio.of(100))
      : perLineUnit;
  return Number(gross.toDecimal(0).value);
}

/**
 * Records (or edits) a supplier invoice against an approved LPO (D5.2): the supplier's invoice
 * number and date, the KRA eTIMS number with a format check and a visible "missing" flag, the
 * billed lines and the totals as printed. PM-Buddy's own computation is shown alongside; the
 * three-way match compares them when the invoice is submitted.
 */
export function InvoiceForm({
  lpo,
  units,
  today,
  initial,
}: {
  lpo: LpoDetailResponse;
  units: UnitWire[];
  today: string;
  initial?: InvoiceInitial;
}) {
  const t = useTranslations("p2p.invoices.form");
  const tCommon = useTranslations("p2p.common");
  const tVat = useTranslations("catalogue.detail.vat");
  const tUnits = useTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const problem = useP2pProblem();
  const router = useRouter();
  const rate = lpo.lpo.vatRatePercent;
  const [invoiceNumber, setInvoiceNumber] = useState(initial?.invoiceNumber ?? "");
  const [invoiceDate, setInvoiceDate] = useState(initial?.invoiceDate ?? today);
  const [etims, setEtims] = useState(initial?.etims ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<Record<string, LineInput>>(() =>
    Object.fromEntries(
      lpo.lines.map((line) => {
        const saved = initial?.lines.find((entry) => entry.lpoLineId === line.id);
        if (saved)
          return [
            line.id,
            {
              include: true,
              quantity: saved.quantity,
              unit: saved.unit,
              price: minorToInput(saved.unitPriceMinor),
              vat: saved.vatTreatment,
            },
          ];
        const open = remainingQuantity(line.receivedBaseQuantity, line.invoicedBaseQuantity);
        const quantity = /[1-9]/.test(open)
          ? scaleQuantity(open, line.quantity, line.baseQuantity)
          : "";
        return [
          line.id,
          {
            include: !initial && quantity !== "",
            quantity,
            unit: line.unit,
            price: minorToInput(defaultPrice(line, rate)),
            vat: line.vatTreatment,
          },
        ];
      }),
    ),
  );
  const [stated, setStated] = useState<{ subtotal: string; vat: string; total: string } | null>(
    initial
      ? {
          subtotal: minorToInput(initial.subtotalMinor),
          vat: minorToInput(initial.vatMinor),
          total: minorToInput(initial.totalMinor),
        }
      : null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const included = lpo.lines.filter((line) => lines[line.id]?.include);
  const computed = invoiceTotals(
    included.map((line) => {
      const input = lines[line.id]!;
      return { ...input, perBase: unitsPerBase(line, input.unit) };
    }),
    rate,
  );
  const shown = stated ?? {
    subtotal: computed ? minorToInput(computed.subtotalMinor) : "",
    vat: computed ? minorToInput(computed.vatMinor) : "",
    total: computed ? minorToInput(computed.totalMinor) : "",
  };
  const statedMinor = {
    subtotal: inputToMinor(shown.subtotal),
    vat: inputToMinor(shown.vat),
    total: inputToMinor(shown.total),
  };
  const arithmetic =
    statedMinor.subtotal !== null &&
    statedMinor.vat !== null &&
    statedMinor.total !== null &&
    statedMinor.subtotal + statedMinor.vat === statedMinor.total;
  const etimsCheck = etims.trim() ? classifyEtimsInvoiceNumber(etims) : null;
  const valid =
    invoiceNumber.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) &&
    included.length > 0 &&
    computed !== null &&
    arithmetic &&
    (statedMinor.total ?? 0) > 0 &&
    (!etims.trim() || etimsCheck !== null);

  async function save() {
    setBusy(true);
    setFailure(null);
    const body = {
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate,
      etimsInvoiceNumber: etims.trim() || null,
      subtotalMinor: statedMinor.subtotal,
      vatMinor: statedMinor.vat,
      totalMinor: statedMinor.total,
      notes: notes.trim() || null,
      lines: included.map((line) => {
        const input = lines[line.id]!;
        return {
          lpoLineId: line.id,
          quantity: input.quantity.trim(),
          unit: input.unit,
          unitPriceMinor: inputToMinor(input.price),
          vatTreatment: input.vat,
        };
      }),
    };
    try {
      const result = initial
        ? await liveRequest(`/procurement/invoices/${initial.id}`, invoiceDetailResponseSchema, {
            method: "PATCH",
            body: { ...body, version: initial.version },
          })
        : await liveRequest("/procurement/invoices", invoiceDetailResponseSchema, {
            method: "POST",
            body: { ...body, lpoId: lpo.lpo.id },
          });
      if (file) {
        try {
          await liveUpload(
            `/procurement/invoices/${result.invoice.id}/document`,
            file,
            procurementDocumentResponseSchema,
          );
        } catch {
          // The invoice is saved: the detail page says the document is missing and offers it again.
          router.push(`/procurement/invoices/${result.invoice.id}?upload=failed`);
          return;
        }
      }
      router.push(`/procurement/invoices/${result.invoice.id}`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  const setLine = (id: string, patch: Partial<LineInput>) =>
    setLines((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save();
      }}
    >
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="invoice-number">{t("invoiceNumber")}</FieldLabel>
            <Input
              id="invoice-number"
              maxLength={60}
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="invoice-date">{t("invoiceDate")}</FieldLabel>
            <Input
              id="invoice-date"
              type="date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="invoice-etims">{t("etims")}</FieldLabel>
            <Input
              id="invoice-etims"
              className="font-mono uppercase"
              autoCapitalize="characters"
              maxLength={40}
              value={etims}
              aria-describedby="invoice-etims-hint invoice-etims-check"
              onChange={(event) => setEtims(event.target.value)}
            />
            <FieldDescription id="invoice-etims-hint">{t("etimsHint")}</FieldDescription>
            <p
              id="invoice-etims-check"
              role="status"
              data-testid="etims-check"
              className={
                !etims.trim()
                  ? "rounded-md border border-warning/40 bg-warning/15 px-2 py-1 text-sm text-warning-foreground dark:text-warning"
                  : etimsCheck === null
                    ? "text-sm text-destructive"
                    : "text-sm"
              }
            >
              {!etims.trim()
                ? t("etimsMissing")
                : etimsCheck === null
                  ? t("etimsInvalid")
                  : etimsCheck.format === "etims"
                    ? t("etimsOk")
                    : t("etimsUnrecognised")}
            </p>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("lines")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {lpo.lines.map((line, index) => {
            const input = lines[line.id]!;
            const id = `invoice-line-${index + 1}`;
            const options = [...new Set([line.unit, line.material.baseUnit])];
            return (
              <fieldset key={line.id} className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">{line.material.name}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={input.include}
                    onChange={(event) => setLine(line.id, { include: event.target.checked })}
                  />
                  {t("include", { material: line.material.name })}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t("ordered", {
                    quantity: `${formatQuantity(line.quantity)} ${label(line.unit)}`,
                    price: tCommon("perUnit", {
                      price: formatKES(line.unitPriceMinor),
                      unit: label(line.priceUnit),
                    }),
                  })}{" "}
                  ·{" "}
                  {t("receivedSoFar", {
                    quantity: `${formatQuantity(line.receivedBaseQuantity)} ${label(line.material.baseUnit)}`,
                  })}
                </p>
                {input.include ? (
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Field>
                      <FieldLabel htmlFor={`${id}-quantity`}>{t("quantity")}</FieldLabel>
                      <Input
                        id={`${id}-quantity`}
                        inputMode="decimal"
                        value={input.quantity}
                        onChange={(event) => setLine(line.id, { quantity: event.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-unit`}>{t("unit")}</FieldLabel>
                      <select
                        id={`${id}-unit`}
                        className={selectClass}
                        value={input.unit}
                        onChange={(event) => setLine(line.id, { unit: event.target.value })}
                      >
                        {options.map((unit) => (
                          <option key={unit} value={unit}>
                            {label(unit)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-price`}>{t("unitPrice")}</FieldLabel>
                      <Input
                        id={`${id}-price`}
                        inputMode="decimal"
                        value={input.price}
                        onChange={(event) => setLine(line.id, { price: event.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-vat`}>{t("vat")}</FieldLabel>
                      <select
                        id={`${id}-vat`}
                        className={selectClass}
                        value={input.vat}
                        onChange={(event) =>
                          setLine(line.id, { vat: event.target.value as VatTreatment })
                        }
                      >
                        {VAT_TREATMENTS.map((treatment) => (
                          <option key={treatment} value={treatment}>
                            {tVat(treatment)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                ) : null}
              </fieldset>
            );
          })}
          {!included.length ? (
            <p className="text-sm text-muted-foreground">{t("chooseLine")}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("stated")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {(["subtotal", "vat", "total"] as const).map((key) => (
              <Field key={key}>
                <FieldLabel htmlFor={`invoice-${key}`}>
                  {key === "subtotal"
                    ? t("subtotal")
                    : key === "vat"
                      ? t("vatAmount")
                      : t("totalAmount")}
                </FieldLabel>
                <Input
                  id={`invoice-${key}`}
                  inputMode="decimal"
                  value={shown[key]}
                  onChange={(event) => setStated({ ...shown, [key]: event.target.value })}
                />
              </Field>
            ))}
          </div>
          {computed ? (
            <p
              className="text-sm text-muted-foreground"
              role="status"
              data-testid="invoice-computed"
            >
              {t("computedTotals", {
                subtotal: formatKES(computed.subtotalMinor),
                vat: formatKES(computed.vatMinor),
                total: formatKES(computed.totalMinor),
              })}
            </p>
          ) : null}
          {!arithmetic ? <p className="text-sm text-destructive">{t("totalCheck")}</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="invoice-notes">{tCommon("notesOptional")}</FieldLabel>
          <Textarea
            id="invoice-notes"
            rows={2}
            maxLength={1000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="invoice-file">{t("file")}</FieldLabel>
          <input
            id="invoice-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="max-w-full text-sm"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <FieldDescription>{tCommon("attachHint")}</FieldDescription>
        </Field>
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !valid}>
        {initial ? t("update") : t("create")}
      </Button>
    </form>
  );
}
