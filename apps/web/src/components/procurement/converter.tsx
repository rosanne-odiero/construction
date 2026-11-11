"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRightLeft } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import type { StandardUnitCode } from "@pm-buddy/types";
import {
  conversionResultResponseSchema,
  type ConversionResultResponse,
  type UnitWire,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDecimalString } from "@/lib/format";
import { FoundationApiError } from "@/lib/foundation-api";
import { liveRequest } from "@/lib/live-api";
import { formatFactor, unitLabel } from "@/lib/procurement";
import { selectClass } from "./material-form";

const REFUSALS = [
  "no-conversion",
  "unit-unknown",
  "negative-quantity",
  "invalid-quantity",
  "quantity-too-large",
  "path-too-long",
] as const;
type Refusal = (typeof REFUSALS)[number];

/** The unit calculator: the API converts exactly with the material's and supplier's factors. */
export function Converter({
  units,
  materials,
  suppliers,
  initialMaterialId,
}: {
  units: readonly UnitWire[];
  materials: readonly { id: string; code: string; name: string; baseUnit: string }[];
  suppliers: readonly { id: string; code: string; name: string }[];
  initialMaterialId?: string;
}) {
  const t = useTranslations("catalogue.converter");
  const tUnits = useTranslations("catalogue.units");
  const problem = useProblemMessage();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const initialMaterial = materials.find((material) => material.id === initialMaterialId);
  const [form, setForm] = useState({
    materialId: initialMaterial?.id ?? "",
    supplierId: "",
    quantity: "1",
    from: initialMaterial ? "nr" : "t",
    to: initialMaterial?.baseUnit ?? "kg",
    on: nairobiDate(),
  });
  const [result, setResult] = useState<ConversionResultResponse["result"] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = units.filter((unit) => unit.status === "active");

  async function convert() {
    setBusy(true);
    setFailure(null);
    setResult(null);
    const query = new URLSearchParams({
      from: form.from,
      to: form.to,
      quantity: form.quantity.trim(),
      on: form.on,
    });
    if (form.materialId) query.set("materialId", form.materialId);
    if (form.supplierId) query.set("supplierId", form.supplierId);
    try {
      const response = await liveRequest(
        `/conversions/calculate?${query.toString()}`,
        conversionResultResponseSchema,
      );
      setResult(response.result);
    } catch (error) {
      if (
        error instanceof FoundationApiError &&
        error.status === 422 &&
        (REFUSALS as readonly string[]).includes(error.code)
      )
        setFailure(t(`refusals.${error.code as Refusal}`));
      else setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const unitSelect = (key: "from" | "to") => (
    <select
      id={`convert-${key}`}
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
    <div className="grid gap-6 lg:grid-cols-2">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void convert();
        }}
      >
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="convert-material">{t("material")}</FieldLabel>
          <select
            id="convert-material"
            value={form.materialId}
            className={selectClass}
            onChange={(event) => setForm({ ...form, materialId: event.target.value })}
          >
            <option value="">{t("noMaterial")}</option>
            {materials.map((material) => (
              <option key={material.id} value={material.id}>
                {material.code} · {material.name}
              </option>
            ))}
          </select>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="convert-supplier">{t("supplier")}</FieldLabel>
          <select
            id="convert-supplier"
            value={form.supplierId}
            className={selectClass}
            onChange={(event) => setForm({ ...form, supplierId: event.target.value })}
          >
            <option value="">{t("noSupplier")}</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.code} · {supplier.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="convert-quantity">{t("quantity")}</FieldLabel>
          <Input
            id="convert-quantity"
            inputMode="decimal"
            value={form.quantity}
            maxLength={30}
            onChange={(event) => setForm({ ...form, quantity: event.target.value })}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="convert-on">{t("on")}</FieldLabel>
          <Input
            id="convert-on"
            type="date"
            value={form.on}
            onChange={(event) => setForm({ ...form, on: event.target.value })}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="convert-from">{t("from")}</FieldLabel>
          {unitSelect("from")}
        </Field>
        <Field>
          <FieldLabel htmlFor="convert-to">{t("to")}</FieldLabel>
          {unitSelect("to")}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>
            <ArrowRightLeft aria-hidden /> {t("submit")}
          </Button>
        </div>
      </form>
      <section aria-labelledby="convert-result" className="space-y-3 rounded-xl border p-4">
        <h2 id="convert-result" className="font-semibold">
          {t("resultTitle")}
        </h2>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {result ? (
          <div className="space-y-3" role="status">
            <p className="text-xl font-semibold tabular-nums" data-testid="conversion-result">
              {t("result", {
                quantity: formatDecimalString(result.input),
                from: label(result.from),
                result: formatDecimalString(result.quantity),
                to: label(result.to),
              })}
            </p>
            <StatusBadge tone={result.exact ? "success" : "info"}>
              {result.exact ? t("exact") : t("rounded")}
            </StatusBadge>
            <p className="text-sm text-muted-foreground">
              {t("factor", {
                from: label(result.from),
                factor: formatFactor(result.factor),
                to: label(result.to),
              })}
            </p>
            {result.steps.length ? (
              <div>
                <h3 className="text-sm font-medium">{t("steps")}</h3>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
                  {result.steps.map((step, index) => (
                    <li key={`${step.from}-${step.to}-${index}`}>
                      {t("step", {
                        from: label(step.from),
                        factor: formatFactor(step.factor),
                        to: label(step.to),
                      })}{" "}
                      <span className="text-muted-foreground">({t(`sources.${step.source}`)})</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
