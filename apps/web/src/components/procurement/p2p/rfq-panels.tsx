"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Award, Plus } from "lucide-react";
import { VAT_TREATMENTS, type StandardUnitCode, type VatTreatment } from "@pm-buddy/types";
import {
  lpoDetailResponseSchema,
  procurementDocumentResponseSchema,
  rfqDetailResponseSchema,
  type RfqLine,
  type UnitWire,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest, liveUpload } from "@/lib/live-api";
import { formatQuantity, inputToMinor } from "@/lib/p2p";
import type { SiteOption } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { useP2pProblem } from "./use-p2p-problem";

type QuoteLine = { noBid: boolean; priceUnit: string; price: string; vat: VatTreatment };
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/**
 * Records one supplier's quotation for every RFQ line (a price per unit with a VAT treatment,
 * or no bid), then attaches its document when one was chosen.
 */
export function QuotationDialog({
  rfqId,
  lines,
  suppliers,
  units,
  today,
}: {
  rfqId: string;
  lines: RfqLine[];
  suppliers: { id: string; code: string; name: string }[];
  units: UnitWire[];
  today: string;
}) {
  const t = useTranslations("p2p.rfqs.quotationForm");
  const tCommon = useTranslations("p2p.common");
  const tVat = useTranslations("catalogue.detail.vat");
  const tUnits = useTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const problem = useP2pProblem();
  const router = useRouter();
  const blank = () =>
    Object.fromEntries(
      lines.map((line) => [
        line.requisitionLineId,
        { noBid: false, priceUnit: line.unit, price: "", vat: "exclusive" as VatTreatment },
      ]),
    ) as Record<string, QuoteLine>;
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [reference, setReference] = useState("");
  const [quotedOn, setQuotedOn] = useState(today);
  const [validUntil, setValidUntil] = useState(addDays(today, 30));
  const [deliveryDays, setDeliveryDays] = useState("2");
  const [quote, setQuote] = useState<Record<string, QuoteLine>>(blank);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (id: string, patch: Partial<QuoteLine>) =>
    setQuote((current) => ({ ...current, [id]: { ...current[id]!, ...patch } }));
  const valid =
    Boolean(supplierId) &&
    /^\d{1,3}$/.test(deliveryDays) &&
    validUntil >= quotedOn &&
    lines.every((line) => {
      const entry = quote[line.requisitionLineId]!;
      return entry.noBid || (entry.priceUnit && (inputToMinor(entry.price) ?? 0) > 0);
    });

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      const detail = await liveRequest(
        `/procurement/rfqs/${rfqId}/quotations`,
        rfqDetailResponseSchema,
        {
          method: "POST",
          body: {
            supplierId,
            reference: reference.trim() || null,
            quotedOn,
            validUntil,
            deliveryDays: Number(deliveryDays),
            lines: lines.map((line) => {
              const entry = quote[line.requisitionLineId]!;
              return entry.noBid
                ? { requisitionLineId: line.requisitionLineId, noBid: true }
                : {
                    requisitionLineId: line.requisitionLineId,
                    priceUnit: entry.priceUnit,
                    unitPriceMinor: inputToMinor(entry.price),
                    vatTreatment: entry.vat,
                  };
            }),
          },
        },
      );
      const recorded = detail.quotations.find(
        (entry) => entry.supplier.id === supplierId && entry.status === "received",
      );
      if (file && recorded) {
        try {
          await liveUpload(
            `/procurement/rfqs/${rfqId}/quotations/${recorded.id}/document`,
            file,
            procurementDocumentResponseSchema,
          );
        } catch (error) {
          setFailure(t("uploadFailed", { message: problem(error) }));
          router.refresh();
          setBusy(false);
          return;
        }
      }
      setOpen(false);
      setQuote(blank());
      setSupplierId("");
      setReference("");
      setFile(null);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        <Plus aria-hidden /> {t("button")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {suppliers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("allQuoted")}</p>
          ) : (
            <form
              id="quotation-form"
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (valid) void save();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="quote-supplier">{t("supplier")}</FieldLabel>
                  <select
                    id="quote-supplier"
                    className={selectClass}
                    value={supplierId}
                    onChange={(event) => setSupplierId(event.target.value)}
                  >
                    <option value="">{t("chooseSupplier")}</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.code} · {supplier.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="quote-reference">{t("reference")}</FieldLabel>
                  <Input
                    id="quote-reference"
                    maxLength={60}
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quote-quoted-on">{t("quotedOn")}</FieldLabel>
                  <Input
                    id="quote-quoted-on"
                    type="date"
                    value={quotedOn}
                    onChange={(event) => setQuotedOn(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quote-valid-until">{t("validUntil")}</FieldLabel>
                  <Input
                    id="quote-valid-until"
                    type="date"
                    value={validUntil}
                    onChange={(event) => setValidUntil(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="quote-delivery-days">{t("deliveryDays")}</FieldLabel>
                  <Input
                    id="quote-delivery-days"
                    inputMode="numeric"
                    value={deliveryDays}
                    onChange={(event) => setDeliveryDays(event.target.value.replace(/\D/g, ""))}
                  />
                </Field>
              </div>
              {lines.map((line, index) => {
                const entry = quote[line.requisitionLineId]!;
                const id = `quote-line-${index}`;
                return (
                  <fieldset
                    key={line.requisitionLineId}
                    className="space-y-2 rounded-lg border p-3"
                  >
                    <legend className="px-1 text-sm font-medium">
                      {line.material.name} · {formatQuantity(line.quantity)} {label(line.unit)}
                    </legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={entry.noBid}
                        onChange={(event) =>
                          set(line.requisitionLineId, { noBid: event.target.checked })
                        }
                      />
                      {t("noBid")}
                    </label>
                    {entry.noBid ? null : (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <Field>
                          <FieldLabel htmlFor={`${id}-price`}>{t("unitPrice")}</FieldLabel>
                          <Input
                            id={`${id}-price`}
                            inputMode="decimal"
                            value={entry.price}
                            onChange={(event) =>
                              set(line.requisitionLineId, { price: event.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`${id}-unit`}>{t("priceUnit")}</FieldLabel>
                          <select
                            id={`${id}-unit`}
                            className={selectClass}
                            value={entry.priceUnit}
                            onChange={(event) =>
                              set(line.requisitionLineId, { priceUnit: event.target.value })
                            }
                          >
                            {units.map((unit) => (
                              <option key={unit.code} value={unit.code}>
                                {label(unit.code)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`${id}-vat`}>{t("vat")}</FieldLabel>
                          <select
                            id={`${id}-vat`}
                            className={selectClass}
                            value={entry.vat}
                            onChange={(event) =>
                              set(line.requisitionLineId, {
                                vat: event.target.value as VatTreatment,
                              })
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
                    )}
                  </fieldset>
                );
              })}
              <Field>
                <FieldLabel htmlFor="quote-file">{t("file")}</FieldLabel>
                <input
                  id="quote-file"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  className="max-w-full text-sm"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <FieldDescription>{tCommon("attachHint")}</FieldDescription>
              </Field>
              {failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              ) : null}
            </form>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            {suppliers.length ? (
              <Button type="submit" form="quotation-form" disabled={busy || !valid}>
                {t("save")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Awards a complete, valid quotation: a draft LPO (or a replacement after a cancellation). */
export function AwardDialog({
  rfqId,
  number,
  version,
  candidates,
  sites,
}: {
  rfqId: string;
  number: string;
  version: number;
  candidates: { id: string; label: string }[];
  sites: SiteOption[];
}) {
  const t = useTranslations("p2p.rfqs.award");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [quotationId, setQuotationId] = useState(candidates[0]?.id ?? "");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [terms, setTerms] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function award() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest(
        `/procurement/rfqs/${rfqId}/award`,
        lpoDetailResponseSchema,
        {
          method: "POST",
          body: {
            version,
            quotationId,
            deliverySiteId: siteId || null,
            deliveryDate: deliveryDate || null,
            terms: terms.trim() || null,
          },
        },
      );
      router.push(`/procurement/lpos/${result.lpo.id}`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        <Award aria-hidden /> {t("button")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle", { number })}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="award-quotation">{t("quotation")}</FieldLabel>
            <select
              id="award-quotation"
              className={selectClass}
              value={quotationId}
              onChange={(event) => setQuotationId(event.target.value)}
            >
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="award-site">{t("deliverySite")}</FieldLabel>
              <select
                id="award-site"
                className={selectClass}
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
              >
                <option value="">—</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="award-date">{t("deliveryDate")}</FieldLabel>
              <Input
                id="award-date"
                type="date"
                value={deliveryDate}
                onChange={(event) => setDeliveryDate(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="award-terms">{t("terms")}</FieldLabel>
            <Textarea
              id="award-terms"
              rows={2}
              maxLength={2000}
              value={terms}
              onChange={(event) => setTerms(event.target.value)}
            />
          </Field>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            <Button type="button" disabled={busy || !quotationId} onClick={() => void award()}>
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
