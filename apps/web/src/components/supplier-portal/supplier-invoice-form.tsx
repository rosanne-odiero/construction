"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LoaderCircle, Send } from "lucide-react";
import { classifyEtimsInvoiceNumber } from "@pm-buddy/domain";
import { VAT_TREATMENTS, type StandardUnitCode, type VatTreatment } from "@pm-buddy/types";
import {
  portalDocumentResponseSchema,
  portalInvoiceDetailResponseSchema,
  type PortalLpoDetailResponse,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatKES } from "@/lib/format";
import { liveRequest, liveUpload } from "@/lib/live-api";
import {
  defaultInvoicePrice,
  formatQuantity,
  inputToMinor,
  invoiceTotals,
  minorToInput,
  newClientId,
  scaleQuantity,
  unitsPerBase,
} from "@/lib/p2p";
import { unitLabel } from "@/lib/procurement";
import { newTimeOrderedId } from "@/lib/supplier-portal";

type LineInput = {
  include: boolean;
  quantity: string;
  unit: string;
  price: string;
  vat: VatTreatment;
};

/**
 * The supplier's invoice against one approved LPO (D7.2), one column on a phone: the invoice
 * number and date, the KRA eTIMS number (required; format checked as staff do), the lines from
 * what was delivered and not yet invoiced, the totals as printed and the invoice document. The
 * invoice ID and the Idempotency-Key are made once per form, so a retry after a lost connection
 * returns the invoice already submitted instead of creating a second one.
 */
export function SupplierInvoiceForm({
  lpo,
  today,
  company,
}: {
  lpo: PortalLpoDetailResponse;
  today: string;
  company: string;
}) {
  const t = useTranslations("supplierPortal.form");
  const tVat = useTranslations("catalogue.detail.vat");
  const tUnits = useTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit));
  const problem = useP2pProblem();
  const router = useRouter();
  const rate = lpo.lpo.vatRatePercent;
  const [identity] = useState(() => ({
    id: newTimeOrderedId(),
    key: `portal-invoice-${newClientId()}`,
  }));
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [etims, setEtims] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Record<string, LineInput>>(() =>
    Object.fromEntries(
      lpo.lines.map((line) => {
        const open = line.invoiceableBaseQuantity;
        const quantity = /[1-9]/.test(open)
          ? scaleQuantity(open, line.quantity, line.baseQuantity)
          : "";
        return [
          line.id,
          {
            include: quantity !== "",
            quantity,
            unit: line.unit,
            price: minorToInput(defaultInvoicePrice(line, rate)),
            vat: line.vatTreatment,
          },
        ];
      }),
    ),
  );
  const [stated, setStated] = useState<{ subtotal: string; vat: string; total: string } | null>(
    null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

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
    invoiceDate <= today &&
    included.length > 0 &&
    computed !== null &&
    arithmetic &&
    (statedMinor.total ?? 0) > 0 &&
    etimsCheck !== null &&
    file !== null;
  const nothingOpen = lpo.lines.every((line) => !/[1-9]/.test(line.invoiceableBaseQuantity));

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest(
        "/portal/supplier/invoices",
        portalInvoiceDetailResponseSchema,
        {
          method: "POST",
          headers: { "Idempotency-Key": identity.key },
          body: {
            id: identity.id,
            lpoId: lpo.lpo.id,
            invoiceNumber: invoiceNumber.trim(),
            invoiceDate,
            etimsInvoiceNumber: etims.trim(),
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
          },
        },
      );
      const href = `/supplier/invoices/${result.invoice.id}`;
      if (file && !result.replayed) {
        try {
          await liveUpload(
            `/portal/supplier/invoices/${result.invoice.id}/document`,
            file,
            portalDocumentResponseSchema,
          );
        } catch {
          router.push(`${href}?upload=failed`);
          return;
        }
      }
      router.push(result.replayed ? `${href}?replayed=1` : href);
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
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (valid) void submit();
      }}
    >
      {nothingOpen ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/15 p-3 text-sm">
          {t("nothingToInvoice")}
        </p>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="portal-invoice-number">{t("invoiceNumber")}</FieldLabel>
            <Input
              id="portal-invoice-number"
              maxLength={60}
              autoComplete="off"
              value={invoiceNumber}
              aria-invalid={touched && !invoiceNumber.trim() ? true : undefined}
              onChange={(event) => setInvoiceNumber(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="portal-invoice-date">{t("invoiceDate")}</FieldLabel>
            <Input
              id="portal-invoice-date"
              type="date"
              max={today}
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="portal-invoice-etims">{t("etims")}</FieldLabel>
            <Input
              id="portal-invoice-etims"
              className="font-mono uppercase"
              autoCapitalize="characters"
              maxLength={40}
              value={etims}
              aria-describedby="portal-invoice-etims-hint portal-invoice-etims-check"
              aria-invalid={touched && etimsCheck === null ? true : undefined}
              onChange={(event) => setEtims(event.target.value)}
            />
            <FieldDescription id="portal-invoice-etims-hint">{t("etimsHint")}</FieldDescription>
            <p
              id="portal-invoice-etims-check"
              role="status"
              data-testid="etims-check"
              className={
                etimsCheck === null && (etims.trim() || touched)
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {!etims.trim()
                ? t("etimsRequired")
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
            <h2>{t("linesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {lpo.lines.map((line, index) => {
            const input = lines[line.id]!;
            const id = `portal-line-${index + 1}`;
            const options = [...new Set([line.unit, line.material.baseUnit])];
            return (
              <fieldset key={line.id} className="min-w-0 space-y-2 rounded-lg border p-3">
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
                  {t("invoiceable", {
                    quantity: `${formatQuantity(line.invoiceableBaseQuantity)} ${label(line.material.baseUnit)}`,
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
            <h2>{t("totalsTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {(["subtotal", "vat", "total"] as const).map((key) => (
              <Field key={key}>
                <FieldLabel htmlFor={`portal-invoice-${key}`}>
                  {key === "subtotal"
                    ? t("subtotal")
                    : key === "vat"
                      ? t("vatAmount")
                      : t("totalAmount")}
                </FieldLabel>
                <Input
                  id={`portal-invoice-${key}`}
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
              data-testid="portal-computed"
            >
              {t("computed", {
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
          <FieldLabel htmlFor="portal-invoice-file">{t("file")}</FieldLabel>
          <input
            id="portal-invoice-file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="max-w-full text-sm file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
            aria-describedby="portal-invoice-file-hint"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <FieldDescription id="portal-invoice-file-hint">
            {touched && !file ? t("fileRequired") : t("fileHint")}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="portal-invoice-notes">{t("notes", { company })}</FieldLabel>
          <Textarea
            id="portal-invoice-notes"
            rows={2}
            maxLength={1000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : touched && !valid ? (
        <p role="alert" className="text-sm text-destructive">
          {t("fixErrors")}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        {busy ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
