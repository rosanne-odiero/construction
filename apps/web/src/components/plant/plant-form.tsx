"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  FUEL_TYPES,
  HIRE_RATE_UNITS,
  METER_TYPES,
  PLANT_CATEGORIES,
  type FuelType,
  type MeterType,
  type PlantOwnership,
} from "@pm-buddy/types";
import {
  createPlantRequestSchema,
  plantDetailResponseSchema,
  updatePlantRequestSchema,
  type PlantDetail,
  type PlantOptionsResponse,
} from "@pm-buddy/validation";
import { field } from "@/components/safety/common";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { parseTenthsInput } from "@/lib/plant";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { minorToInput, parseKesInput } from "@/lib/spending";

/** An optional typed date: empty is null, otherwise the ISO date (undefined when invalid). */
const optionalDate = (text: string) => (text.trim() === "" ? null : parseCalendarInput(text));

/**
 * Registers a plant item (owned or hired) or changes an item's details. Fixed once registered:
 * the code, ownership, meter, fuel type and opening reading (D8.3).
 */
export function PlantForm({
  options,
  today,
  item,
  onDone,
}: {
  options: PlantOptionsResponse;
  today: string;
  item?: PlantDetail;
  onDone?: () => void;
}) {
  const t = useTranslations("plant");
  const router = useRouter();
  const { busy, error, setError, run } = useScheduleMutation();
  const editing = Boolean(item);
  const [ownership, setOwnership] = useState<PlantOwnership>(item?.ownership ?? "owned");
  const [meterType, setMeterType] = useState<MeterType>(item?.meterType ?? "hours");
  const [fuelType, setFuelType] = useState<FuelType>(item?.fuelType ?? "diesel");
  const [supplierId, setSupplierId] = useState(item?.hire?.supplier.id ?? "");
  const hired = ownership === "hired";
  const needsStandard = meterType !== "none" && fuelType !== "none";
  const prefix = editing ? "plant-edit" : "plant-new";

  function submit(form: FormData) {
    const rate = hired ? parseKesInput(field(form, "rate")) : null;
    const hireStartOn = hired ? parseCalendarInput(field(form, "hireStartOn")) : null;
    const hireEndOn = hired ? optionalDate(field(form, "hireEndOn")) : null;
    const serviceEvery = field(form, "serviceEvery");
    const serviceDays = field(form, "serviceEveryDays");
    const quantity = Number(field(form, "quantity") || "1");
    const values = {
      name: field(form, "name"),
      category: form.get("category"),
      quantity: Number.isInteger(quantity) ? quantity : -1,
      makeModel: field(form, "makeModel"),
      registration: field(form, "registration"),
      supplierId: hired ? supplierId || null : null,
      lpoId: hired ? field(form, "lpoId") || null : null,
      hireRateMinor: rate,
      hireRateUnit: hired ? form.get("hireRateUnit") : null,
      hireStartOn,
      hireEndOn,
      standardConsumption: needsStandard ? field(form, "standardConsumption") || null : null,
      serviceEvery: meterType !== "none" && serviceEvery ? parseTenthsInput(serviceEvery) : null,
      serviceEveryDays: serviceDays ? Number(serviceDays) : null,
      notes: field(form, "notes"),
    };
    if (
      (hired && (rate === null || !hireStartOn)) ||
      hireEndOn === undefined ||
      (serviceEvery !== "" && meterType !== "none" && !values.serviceEvery)
    ) {
      setError(t("form.invalid"));
      return;
    }
    if (item) {
      const parsed = updatePlantRequestSchema.safeParse({ ...values, version: item.version });
      if (!parsed.success) {
        setError(t("form.invalid"));
        return;
      }
      void run(
        () =>
          liveRequest(`/plant/${item.id}`, plantDetailResponseSchema, {
            method: "PATCH",
            body: parsed.data,
          }),
        onDone,
      );
      return;
    }
    const openingOn = parseCalendarInput(field(form, "openingOn"));
    const parsed = createPlantRequestSchema.safeParse({
      ...values,
      code: field(form, "code"),
      ownership,
      meterType,
      fuelType,
      openingOn,
      openingReading:
        meterType === "none" ? null : (parseTenthsInput(field(form, "openingReading")) ?? ""),
      siteId: field(form, "siteId") || null,
    });
    if (!parsed.success || !openingOn || openingOn > (parseCalendarInput(today) ?? "")) {
      setError(t("form.invalid"));
      return;
    }
    void run(async () => {
      const created = await liveRequest("/plant", plantDetailResponseSchema, {
        method: "POST",
        body: parsed.data,
      });
      router.push(`/plant/${created.item.id}`);
    });
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {editing ? null : (
          <Field>
            <FieldLabel htmlFor={`${prefix}-code`}>{t("form.code")}</FieldLabel>
            <Input id={`${prefix}-code`} name="code" maxLength={20} autoComplete="off" />
            <FieldDescription>{t("form.codeHint")}</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor={`${prefix}-name`}>{t("form.name")}</FieldLabel>
          <Input id={`${prefix}-name`} name="name" maxLength={120} defaultValue={item?.name} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-category`}>{t("form.category")}</FieldLabel>
          <select
            id={`${prefix}-category`}
            name="category"
            className={selectClass}
            defaultValue={item?.category ?? "concrete_mixer"}
          >
            {PLANT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`category.${category}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-quantity`}>{t("form.quantity")}</FieldLabel>
          <Input
            id={`${prefix}-quantity`}
            name="quantity"
            inputMode="numeric"
            defaultValue={String(item?.quantity ?? 1)}
          />
          <FieldDescription>{t("form.quantityHint")}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-make`}>{t("form.makeModel")}</FieldLabel>
          <Input
            id={`${prefix}-make`}
            name="makeModel"
            maxLength={120}
            defaultValue={item?.makeModel ?? ""}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-registration`}>{t("form.registration")}</FieldLabel>
          <Input
            id={`${prefix}-registration`}
            name="registration"
            maxLength={30}
            defaultValue={item?.registration ?? ""}
          />
        </Field>
      </div>

      {editing ? null : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("form.ownership")}</legend>
          <div className="flex flex-wrap gap-4">
            {(["owned", "hired"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="ownership"
                  value={value}
                  checked={ownership === value}
                  onChange={() => setOwnership(value)}
                  className="size-4 accent-primary"
                />
                {t(`ownership.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {hired ? (
        <fieldset className="grid grid-cols-1 gap-4 rounded-md border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">{t("form.hireTerms")}</legend>
          <Field>
            <FieldLabel htmlFor={`${prefix}-supplier`}>{t("form.supplier")}</FieldLabel>
            <select
              id={`${prefix}-supplier`}
              className={selectClass}
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">{t("form.choose")}</option>
              {options.suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name} ({supplier.code})
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-lpo`}>{t("form.lpo")}</FieldLabel>
            <select
              id={`${prefix}-lpo`}
              name="lpoId"
              className={selectClass}
              defaultValue={item?.lpo?.id ?? ""}
            >
              <option value="">{t("form.none")}</option>
              {options.lpos
                .filter((lpo) => lpo.supplierId === supplierId)
                .map((lpo) => (
                  <option key={lpo.id} value={lpo.id}>
                    {lpo.number} · {lpo.projectCode}
                  </option>
                ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-rate`}>{t("form.rate")}</FieldLabel>
            <Input
              id={`${prefix}-rate`}
              name="rate"
              inputMode="decimal"
              defaultValue={item?.hire?.rateMinor ? minorToInput(item.hire.rateMinor) : ""}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-unit`}>{t("form.rateUnit")}</FieldLabel>
            <select
              id={`${prefix}-unit`}
              name="hireRateUnit"
              className={selectClass}
              defaultValue={item?.hire?.rateUnit ?? "day"}
            >
              {HIRE_RATE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {t(`rateUnit.${unit}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-start`}>{t("form.hireStart")}</FieldLabel>
            <Input
              id={`${prefix}-start`}
              name="hireStartOn"
              inputMode="numeric"
              defaultValue={item?.hire ? calendarInput(item.hire.startOn) : today}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-end`}>{t("form.hireEnd")}</FieldLabel>
            <Input
              id={`${prefix}-end`}
              name="hireEndOn"
              inputMode="numeric"
              defaultValue={item?.hireEndOn ? calendarInput(item.hireEndOn) : ""}
            />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t("form.hireHint")}</p>
        </fieldset>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-meter`}>{t("form.meterType")}</FieldLabel>
          <select
            id={`${prefix}-meter`}
            className={selectClass}
            value={meterType}
            disabled={editing}
            onChange={(event) => setMeterType(event.target.value as MeterType)}
          >
            {METER_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`meterType.${type}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-fuel`}>{t("form.fuelType")}</FieldLabel>
          <select
            id={`${prefix}-fuel`}
            className={selectClass}
            value={fuelType}
            disabled={editing}
            onChange={(event) => setFuelType(event.target.value as FuelType)}
          >
            {FUEL_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`fuelType.${type}`)}
              </option>
            ))}
          </select>
        </Field>
        {needsStandard ? (
          <Field>
            <FieldLabel htmlFor={`${prefix}-standard`}>
              {t(meterType === "km" ? "form.standardKm" : "form.standardHours")}
            </FieldLabel>
            <Input
              id={`${prefix}-standard`}
              name="standardConsumption"
              inputMode="decimal"
              defaultValue={item?.standardConsumption ?? ""}
            />
            <FieldDescription>{t("form.standardHint")}</FieldDescription>
          </Field>
        ) : null}
        {editing ? null : (
          <Field>
            <FieldLabel htmlFor={`${prefix}-opening-on`}>{t("form.openingOn")}</FieldLabel>
            <Input
              id={`${prefix}-opening-on`}
              name="openingOn"
              inputMode="numeric"
              defaultValue={today}
            />
          </Field>
        )}
        {editing || meterType === "none" ? null : (
          <Field>
            <FieldLabel htmlFor={`${prefix}-opening`}>{t("form.openingReading")}</FieldLabel>
            <Input id={`${prefix}-opening`} name="openingReading" inputMode="decimal" />
          </Field>
        )}
        {meterType === "none" ? null : (
          <Field>
            <FieldLabel htmlFor={`${prefix}-every`}>
              {t(meterType === "km" ? "form.serviceEveryKm" : "form.serviceEveryHours")}
            </FieldLabel>
            <Input
              id={`${prefix}-every`}
              name="serviceEvery"
              inputMode="decimal"
              defaultValue={item?.serviceEvery ?? ""}
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor={`${prefix}-every-days`}>{t("form.serviceEveryDays")}</FieldLabel>
          <Input
            id={`${prefix}-every-days`}
            name="serviceEveryDays"
            inputMode="numeric"
            defaultValue={item?.serviceEveryDays ? String(item.serviceEveryDays) : ""}
          />
        </Field>
        {editing ? null : (
          <Field>
            <FieldLabel htmlFor={`${prefix}-site`}>{t("form.startsAt")}</FieldLabel>
            <select id={`${prefix}-site`} name="siteId" className={selectClass} defaultValue="">
              <option value="">{t("yard")}</option>
              {options.sites.map((site) => (
                <option key={site.siteId} value={site.siteId}>
                  {site.projectCode} · {site.siteName}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={`${prefix}-notes`}>{t("form.notes")}</FieldLabel>
        <Textarea
          id={`${prefix}-notes`}
          name="notes"
          maxLength={1000}
          defaultValue={item?.notes ?? ""}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {editing ? t("form.save") : t("form.register")}
        </Button>
        {onDone ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onDone}>
            {t("actions.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
