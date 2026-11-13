"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { P2P_LIMITS } from "@pm-buddy/types";
import {
  procurementSettingsResponseSchema,
  type ProcurementSettingsResponse,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;
const validTolerance = (value: string) => PERCENT.test(value) && Number(value) <= 100;

/**
 * The company's procurement settings (config.manage to change them): the price-change alert
 * threshold (D5.1) and, for D5.2, the minimum complete quotations before an award, the
 * three-way match quantity and price tolerances, and whether a missing KRA eTIMS number blocks
 * payment (CR-TAX-02). Saved together with the version read here (409 if someone else saved).
 */
export function ProcurementSettingsForm({
  settings,
  canManage,
}: {
  settings: ProcurementSettingsResponse["settings"];
  canManage: boolean;
}) {
  const t = useTranslations("p2p.settings");
  const tAlerts = useTranslations("catalogue.alerts");
  const problem = useProblemMessage();
  const router = useRouter();
  const [percent, setPercent] = useState(settings.priceChangeAlertPercent);
  const [minQuotes, setMinQuotes] = useState(String(settings.minQuotes));
  const [qty, setQty] = useState(settings.qtyTolerancePercent);
  const [price, setPrice] = useState(settings.priceTolerancePercent);
  const [blockEtims, setBlockEtims] = useState(settings.blockPaymentWithoutEtims);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const valid =
    /^\d{1,4}(\.\d{1,4})?$/.test(percent) &&
    Number(percent) > 0 &&
    Number(percent) <= 1000 &&
    /^\d{1,2}$/.test(minQuotes) &&
    Number(minQuotes) >= 1 &&
    Number(minQuotes) <= P2P_LIMITS.maxMinQuotes &&
    validTolerance(qty) &&
    validTolerance(price);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest("/procurement/settings", procurementSettingsResponseSchema, {
        method: "PUT",
        body: {
          priceChangeAlertPercent: percent,
          minQuotes: Number(minQuotes),
          qtyTolerancePercent: qty,
          priceTolerancePercent: price,
          blockPaymentWithoutEtims: blockEtims,
          version: settings.version,
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

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save();
      }}
    >
      <fieldset className="space-y-3" disabled={!canManage}>
        <legend className="text-sm font-semibold">{t("alertsLegend")}</legend>
        <Field className="max-w-xs">
          <FieldLabel htmlFor="alert-threshold">{tAlerts("thresholdLabel")}</FieldLabel>
          <Input
            id="alert-threshold"
            inputMode="decimal"
            value={percent}
            onChange={(event) => setPercent(event.target.value.trim())}
          />
        </Field>
      </fieldset>
      <fieldset className="space-y-3" disabled={!canManage}>
        <legend className="text-sm font-semibold">{t("rulesLegend")}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="min-quotes">{t("minQuotes")}</FieldLabel>
            <Input
              id="min-quotes"
              type="number"
              min={1}
              max={P2P_LIMITS.maxMinQuotes}
              value={minQuotes}
              onChange={(event) => setMinQuotes(event.target.value.trim())}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="qty-tolerance">{t("qtyTolerance")}</FieldLabel>
            <Input
              id="qty-tolerance"
              inputMode="decimal"
              value={qty}
              aria-describedby="tolerance-hint"
              onChange={(event) => setQty(event.target.value.trim())}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="price-tolerance">{t("priceTolerance")}</FieldLabel>
            <Input
              id="price-tolerance"
              inputMode="decimal"
              value={price}
              aria-describedby="tolerance-hint"
              onChange={(event) => setPrice(event.target.value.trim())}
            />
          </Field>
        </div>
        <p id="tolerance-hint" className="text-xs text-muted-foreground">
          {t("toleranceHint")}
        </p>
        <Field orientation="horizontal">
          <input
            id="block-etims"
            type="checkbox"
            className="mt-0.5 size-4"
            checked={blockEtims}
            onChange={(event) => setBlockEtims(event.target.checked)}
          />
          <div>
            <FieldLabel htmlFor="block-etims">{t("blockEtims")}</FieldLabel>
            <FieldDescription>{t("blockEtimsHint")}</FieldDescription>
          </div>
        </Field>
      </fieldset>
      {!valid && canManage ? <p className="text-sm text-destructive">{t("invalid")}</p> : null}
      {canManage ? (
        <Button type="submit" variant="secondary" disabled={busy || !valid}>
          {t("save")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t("readOnly")}</p>
      )}
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
