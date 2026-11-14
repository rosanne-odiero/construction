"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { SPENDING_LIMITS } from "@pm-buddy/types";
import { spendingSettingsResponseSchema, type SpendingSettings } from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { minorToInput, parseKesInput, parseWholeNumber } from "@/lib/spending";

/**
 * Company spending settings: the budget alert threshold, the unusual-spend and duplicate rules,
 * the forecast horizon and the entered opening cash position (finance managers only).
 */
export function SettingsForm({
  settings,
  canEdit,
}: {
  settings: SpendingSettings;
  canEdit: boolean;
}) {
  const t = useTranslations("spending.settings.form");
  const problem = useP2pProblem();
  const router = useRouter();
  const [form, setForm] = useState({
    budgetAlertPercent: String(settings.budgetAlertPercent),
    unusualSpendMultiplier: settings.unusualSpendMultiplier,
    unusualSpendMinSamples: String(settings.unusualSpendMinSamples),
    duplicateWindowDays: String(settings.duplicateWindowDays),
    forecastWeeks: String(settings.forecastWeeks),
    openingCash: settings.openingCashMinor === null ? "" : minorToInput(settings.openingCashMinor),
    openingCashOn: settings.openingCashOn ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const L = SPENDING_LIMITS;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const percent = parseWholeNumber(
      form.budgetAlertPercent,
      L.budgetAlertPercent.min,
      L.budgetAlertPercent.max,
    );
    const samples = parseWholeNumber(
      form.unusualSpendMinSamples,
      L.unusualSpendMinSamples.min,
      L.unusualSpendMinSamples.max,
    );
    const windowDays = parseWholeNumber(
      form.duplicateWindowDays,
      L.duplicateWindowDays.min,
      L.duplicateWindowDays.max,
    );
    const weeks = parseWholeNumber(form.forecastWeeks, L.forecastWeeks.min, L.forecastWeeks.max);
    const multiplier = form.unusualSpendMultiplier.trim();
    const opening = form.openingCash.trim() ? parseKesInput(form.openingCash, true) : null;
    if (percent === null || samples === null || windowDays === null || weeks === null)
      return setMessage({ text: t("rangeInvalid"), error: true });
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(multiplier))
      return setMessage({ text: t("multiplierInvalid"), error: true });
    if (form.openingCash.trim() && opening === null)
      return setMessage({ text: t("openingInvalid"), error: true });
    if ((opening === null) !== !form.openingCashOn)
      return setMessage({ text: t("openingIncomplete"), error: true });
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest("/spending/settings", spendingSettingsResponseSchema, {
        method: "PUT",
        body: {
          version: settings.version,
          budgetAlertPercent: percent,
          unusualSpendMultiplier: multiplier,
          unusualSpendMinSamples: samples,
          duplicateWindowDays: windowDays,
          forecastWeeks: weeks,
          openingCashMinor: opening,
          openingCashOn: opening === null ? null : form.openingCashOn,
        },
      });
      setMessage({ text: t("saved"), error: false });
      router.refresh();
    } catch (error) {
      setMessage({ text: problem(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  const input = (
    key: keyof typeof form,
    label: string,
    hint: string,
    type: "text" | "date" = "text",
  ) => (
    <Field>
      <FieldLabel htmlFor={`settings-${key}`}>{label}</FieldLabel>
      <Input
        id={`settings-${key}`}
        type={type}
        inputMode={type === "text" ? "decimal" : undefined}
        autoComplete="off"
        disabled={!canEdit}
        value={form[key]}
        onChange={(event) => set(key, event.target.value)}
      />
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="space-y-4 rounded-xl border p-4"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {input("budgetAlertPercent", t("budgetAlertPercent"), t("budgetAlertPercentHint"))}
        {input(
          "unusualSpendMultiplier",
          t("unusualSpendMultiplier"),
          t("unusualSpendMultiplierHint"),
        )}
        {input(
          "unusualSpendMinSamples",
          t("unusualSpendMinSamples"),
          t("unusualSpendMinSamplesHint"),
        )}
        {input("duplicateWindowDays", t("duplicateWindowDays"), t("duplicateWindowDaysHint"))}
        {input("forecastWeeks", t("forecastWeeks"), t("forecastWeeksHint"))}
        {input("openingCash", t("openingCash"), t("openingCashHint"))}
        {input("openingCashOn", t("openingCashOn"), t("openingCashOnHint"), "date")}
      </div>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {message.text}
        </p>
      ) : null}
      {canEdit ? (
        <Button type="submit" disabled={busy}>
          {t("save")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
      )}
    </form>
  );
}
