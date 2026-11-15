"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { PLANT_CATEGORIES, PLANT_SETTINGS_LIMITS } from "@pm-buddy/types";
import {
  plantSettingsResponseSchema,
  updatePlantSettingsRequestSchema,
  type PlantSettings,
} from "@pm-buddy/validation";
import { checkboxClass, field } from "@/components/safety/common";
import { FormError, useScheduleMutation } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

const NUMBERS = [
  "fuelVariancePercent",
  "fuelMinHours",
  "fuelMinKm",
  "idleHireDays",
  "hireEndingDays",
  "serviceDueSoonPercent",
] as const;

/** The company's plant settings (config.manage); read-only for everyone else. */
export function PlantSettingsForm({ settings }: { settings: PlantSettings }) {
  const t = useTranslations("plant");
  const { busy, error, setError, run } = useScheduleMutation();
  const [saved, setSaved] = useState(false);
  const canEdit = settings.permissions.canEdit;
  return (
    <form
      noValidate
      className="max-w-2xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const parsed = updatePlantSettingsRequestSchema.safeParse({
          ...Object.fromEntries(NUMBERS.map((key) => [key, Number(field(form, key))])),
          certificateCategories: PLANT_CATEGORIES.filter((category) =>
            form.getAll("certificateCategories").includes(category),
          ),
          version: settings.version,
        });
        if (!parsed.success) {
          setError(t("settings.invalid"));
          return;
        }
        setSaved(false);
        void run(
          () =>
            liveRequest("/plant/settings", plantSettingsResponseSchema, {
              method: "PUT",
              body: parsed.data,
            }),
          () => setSaved(true),
        );
      }}
    >
      <FormError message={error} />
      {saved ? (
        <p role="status" className="text-sm">
          {t("settings.saved")}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {NUMBERS.map((key) => (
          <Field key={key}>
            <FieldLabel htmlFor={`settings-${key}`}>{t(`settings.${key}`)}</FieldLabel>
            <Input
              id={`settings-${key}`}
              name={key}
              inputMode="numeric"
              defaultValue={String(settings[key])}
              disabled={!canEdit}
            />
            <FieldDescription>{t("settings.range", PLANT_SETTINGS_LIMITS[key])}</FieldDescription>
          </Field>
        ))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("settings.certificateCategories")}</legend>
        <p className="text-xs text-muted-foreground">{t("settings.certificateHint")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PLANT_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="certificateCategories"
                value={category}
                defaultChecked={settings.certificateCategories.includes(category)}
                disabled={!canEdit}
                className={checkboxClass}
              />
              {t(`category.${category}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {canEdit ? (
        <Button type="submit" disabled={busy}>
          {t("settings.save")}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t("settings.readOnly")}</p>
      )}
    </form>
  );
}
