"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import {
  checkConversionRule,
  defineCustomUnit,
  nairobiDate,
  type UnitDefinition,
} from "@pm-buddy/domain";
import type { StandardUnitCode, UnitDimension } from "@pm-buddy/types";
import { conversionResponseSchema, type UnitWire } from "@pm-buddy/validation";
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
import { liveRequest } from "@/lib/live-api";
import { formatFactor, unitLabel } from "@/lib/procurement";
import { selectClass } from "./material-form";

const QUANTITY = /^\d{1,12}(\.\d{1,6})?$/;

/** Company units as conversion-engine definitions (for the client-side preview). */
export function definitionsOf(units: readonly UnitWire[]): UnitDefinition[] {
  return units.flatMap((unit) => {
    if (unit.standard) return [];
    const result = defineCustomUnit({
      code: unit.code,
      dimension: unit.dimension as UnitDimension,
      equalsQuantity: unit.equalsQuantity,
      equalsUnit: unit.equalsUnit,
    });
    return result.ok ? [result.unit] : [];
  });
}

/** Adds an explicit, effective-dated factor for a material (optionally for one supplier). */
export function ConversionDialogButton({
  materialId,
  units,
  suppliers,
}: {
  materialId: string;
  units: readonly UnitWire[];
  suppliers: readonly { id: string; code: string; name: string }[];
}) {
  const t = useTranslations("catalogue.conversionForm");
  const tUnits = useTranslations("catalogue.units");
  const problem = useProblemMessage();
  const router = useRouter();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const active = units.filter((unit) => unit.status === "active");
  const empty = () => ({
    supplierId: "",
    fromQuantity: "1",
    fromUnit: "trip",
    toQuantity: "",
    toUnit: "t",
    effectiveFrom: nairobiDate(),
    note: "",
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const quantitiesValid =
    QUANTITY.test(form.fromQuantity) &&
    QUANTITY.test(form.toQuantity) &&
    /[1-9]/.test(form.fromQuantity) &&
    /[1-9]/.test(form.toQuantity);
  const check = quantitiesValid
    ? checkConversionRule(form, definitionsOf(units))
    : { ok: false as const, issue: "invalid-quantity" as const };
  const valid = check.ok && /^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom);

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/materials/${materialId}/conversions`, conversionResponseSchema, {
        method: "POST",
        body: {
          supplierId: form.supplierId || null,
          fromUnit: form.fromUnit,
          fromQuantity: form.fromQuantity,
          toUnit: form.toUnit,
          toQuantity: form.toQuantity,
          effectiveFrom: form.effectiveFrom,
          note: form.note.trim(),
        },
      });
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const unitSelect = (key: "fromUnit" | "toUnit", id: string) => (
    <select
      id={id}
      value={form[key]}
      className={selectClass}
      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
    >
      {active.map((unit) => (
        <option key={unit.code} value={unit.code}>
          {label(unit.code)}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setForm(empty());
          setFailure(null);
          setOpen(true);
        }}
      >
        <Plus aria-hidden /> {t("create")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id="conversion-new"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) void submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor="conversion-from-quantity">{t("fromQuantity")}</FieldLabel>
              <Input
                id="conversion-from-quantity"
                inputMode="decimal"
                value={form.fromQuantity}
                onChange={(event) => setForm({ ...form, fromQuantity: event.target.value.trim() })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="conversion-from-unit">{t("fromUnit")}</FieldLabel>
              {unitSelect("fromUnit", "conversion-from-unit")}
            </Field>
            <Field>
              <FieldLabel htmlFor="conversion-to-quantity">{t("toQuantity")}</FieldLabel>
              <Input
                id="conversion-to-quantity"
                inputMode="decimal"
                value={form.toQuantity}
                onChange={(event) => setForm({ ...form, toQuantity: event.target.value.trim() })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="conversion-to-unit">{t("toUnit")}</FieldLabel>
              {unitSelect("toUnit", "conversion-to-unit")}
            </Field>
            <p className="text-sm sm:col-span-2" role="status">
              {check.ok
                ? t("preview", {
                    from: label(form.fromUnit),
                    factor: formatFactor(check.ratio.toDecimal(12).value),
                    to: label(form.toUnit),
                  })
                : check.issue === "standard-conversion-exists"
                  ? t("sameDimension")
                  : ""}
            </p>
            <Field>
              <FieldLabel htmlFor="conversion-supplier">{t("supplier")}</FieldLabel>
              <select
                id="conversion-supplier"
                value={form.supplierId}
                className={selectClass}
                onChange={(event) => setForm({ ...form, supplierId: event.target.value })}
              >
                <option value="">{t("allSuppliers")}</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.code} · {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="conversion-from-date">{t("effectiveFrom")}</FieldLabel>
              <Input
                id="conversion-from-date"
                type="date"
                value={form.effectiveFrom}
                onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
                required
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="conversion-note">{t("note")}</FieldLabel>
              <Input
                id="conversion-note"
                value={form.note}
                maxLength={300}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
              />
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="conversion-new" disabled={busy || !valid}>
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Ends a factor from a date (it stays in the history). */
export function EndConversionButton({
  materialId,
  conversionId,
  factorLabel,
}: {
  materialId: string;
  conversionId: string;
  factorLabel: string;
}) {
  const t = useTranslations("catalogue.conversionForm");
  const tDetail = useTranslations("catalogue.detail");
  const problem = useProblemMessage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState(nairobiDate());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(
        `/materials/${materialId}/conversions/${conversionId}/end`,
        conversionResponseSchema,
        { method: "POST", body: { effectiveTo } },
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const id = `end-${conversionId}`;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        aria-label={tDetail("endLabel", { factor: factorLabel })}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        {tDetail("end")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("endTitle")}</DialogTitle>
            <DialogDescription>
              {factorLabel}. {t("endDescription")}
            </DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id={id}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-date`}>{t("effectiveTo")}</FieldLabel>
              <Input
                id={`${id}-date`}
                type="date"
                value={effectiveTo}
                onChange={(event) => setEffectiveTo(event.target.value)}
                required
              />
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={id} disabled={busy}>
              {t("endSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
