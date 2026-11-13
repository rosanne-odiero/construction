"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { nairobiDate, splitVat } from "@pm-buddy/domain";
import { VAT_TREATMENTS, type StandardUnitCode, type VatTreatment } from "@pm-buddy/types";
import { priceResponseSchema, type Price, type UnitWire } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { decimalKesToMinor, formatCalendarDate, formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { unitLabel } from "@/lib/procurement";
import { selectClass } from "./material-form";

const KES = /^\d{1,10}(\.\d{1,2})?$/;
const kes = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/**
 * Records a supplier price for a material, or corrects one (a new entry with a reason). The VAT
 * preview uses the same packages/domain splitVat as the API; the rate shown is the configured one.
 */
export function PriceDialogButton({
  materialId,
  baseUnit,
  units,
  suppliers,
  vatRatePercent,
  correcting,
}: {
  materialId: string;
  baseUnit: string;
  units: readonly UnitWire[];
  suppliers: readonly { id: string; code: string; name: string }[];
  vatRatePercent: string;
  correcting?: Price;
}) {
  const t = useTranslations("catalogue.priceForm");
  const tDetail = useTranslations("catalogue.detail");
  const tVat = useTranslations("catalogue.detail.vat");
  const tUnits = useTranslations("catalogue.units");
  const problem = useProblemMessage();
  const router = useRouter();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const active = units.filter((unit) => unit.status === "active" || unit.code === baseUnit);
  const initial = () => ({
    supplierId: correcting?.supplier.id ?? suppliers[0]?.id ?? "",
    unit: correcting?.unit ?? baseUnit,
    price: correcting ? kes(correcting.unitPriceMinor) : "",
    vatTreatment: (correcting?.vatTreatment ?? "inclusive") as VatTreatment,
    effectiveOn: correcting?.effectiveOn ?? nairobiDate(),
    sourceReference: correcting?.sourceReference ?? "",
    note: "",
    reason: "",
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const minor = KES.test(form.price) ? decimalKesToMinor(form.price) : null;
  const valid =
    minor !== null &&
    minor > 0 &&
    form.supplierId !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.effectiveOn) &&
    (!correcting || form.reason.trim().length >= 3);
  const split = minor && minor > 0 ? splitVat(minor, form.vatTreatment, vatRatePercent) : null;
  const id = correcting ? `price-correct-${correcting.id}` : "price-new";

  async function submit() {
    if (minor === null) return;
    setBusy(true);
    setFailure(null);
    const body = {
      supplierId: form.supplierId,
      unit: form.unit,
      unitPriceMinor: minor,
      vatTreatment: form.vatTreatment,
      effectiveOn: form.effectiveOn,
      sourceReference: form.sourceReference.trim(),
      note: form.note.trim(),
    };
    try {
      await liveRequest(
        correcting
          ? `/materials/${materialId}/prices/${correcting.id}/corrections`
          : `/materials/${materialId}/prices`,
        priceResponseSchema,
        { method: "POST", body: correcting ? { ...body, reason: form.reason.trim() } : body },
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {correcting ? (
        <Button
          size="sm"
          variant="outline"
          aria-label={tDetail("correctLabel", { date: formatCalendarDate(correcting.effectiveOn) })}
          onClick={() => {
            setForm(initial());
            setFailure(null);
            setOpen(true);
          }}
        >
          {tDetail("correct")}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={suppliers.length === 0}
          title={suppliers.length === 0 ? t("noSuppliers") : undefined}
          onClick={() => {
            setForm(initial());
            setFailure(null);
            setOpen(true);
          }}
        >
          <Plus aria-hidden /> {t("create")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{correcting ? t("correctTitle") : t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id={id}
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) void submit();
            }}
          >
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-supplier`}>{t("supplier")}</FieldLabel>
              <select
                id={`${id}-supplier`}
                value={form.supplierId}
                className={selectClass}
                onChange={(event) => setForm({ ...form, supplierId: event.target.value })}
              >
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.code} · {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-price`}>{t("price")}</FieldLabel>
              <Input
                id={`${id}-price`}
                inputMode="decimal"
                value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value.trim() })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-unit`}>{t("unit")}</FieldLabel>
              <select
                id={`${id}-unit`}
                value={form.unit}
                className={selectClass}
                onChange={(event) => setForm({ ...form, unit: event.target.value })}
              >
                {active.map((unit) => (
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
                value={form.vatTreatment}
                className={selectClass}
                onChange={(event) =>
                  setForm({ ...form, vatTreatment: event.target.value as VatTreatment })
                }
              >
                {VAT_TREATMENTS.map((treatment) => (
                  <option key={treatment} value={treatment}>
                    {tVat(treatment)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-date`}>{t("effectiveOn")}</FieldLabel>
              <Input
                id={`${id}-date`}
                type="date"
                value={form.effectiveOn}
                onChange={(event) => setForm({ ...form, effectiveOn: event.target.value })}
                required
              />
            </Field>
            <p className="text-sm text-muted-foreground sm:col-span-2" role="status">
              {split
                ? split.ratePercent === null
                  ? t("previewNoVat", { amount: formatKES(split.netMinor) })
                  : t("preview", {
                      net: formatKES(split.netMinor),
                      gross: formatKES(split.grossMinor),
                      rate: split.ratePercent,
                    })
                : ""}
            </p>
            <Field>
              <FieldLabel htmlFor={`${id}-reference`}>{t("reference")}</FieldLabel>
              <Input
                id={`${id}-reference`}
                value={form.sourceReference}
                maxLength={100}
                onChange={(event) => setForm({ ...form, sourceReference: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-note`}>{t("note")}</FieldLabel>
              <Input
                id={`${id}-note`}
                value={form.note}
                maxLength={500}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
              />
            </Field>
            {correcting ? (
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`${id}-reason`}>{t("reason")}</FieldLabel>
                <Input
                  id={`${id}-reason`}
                  value={form.reason}
                  maxLength={500}
                  onChange={(event) => setForm({ ...form, reason: event.target.value })}
                  required
                />
              </Field>
            ) : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={id} disabled={busy || !valid}>
              {correcting ? t("correctSubmit") : t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
