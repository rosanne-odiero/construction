"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { STANDARD_UNITS } from "@pm-buddy/domain";
import { UNIT_DIMENSIONS, type StandardUnitCode, type UnitDimension } from "@pm-buddy/types";
import {
  procurementSettingsResponseSchema,
  unitResponseSchema,
  type UnitWire,
} from "@pm-buddy/validation";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { selectClass } from "./material-form";

const SIZED: readonly UnitDimension[] = ["mass", "length", "area", "volume", "count"];

/** Adds a company unit (a sized unit states its size in a standard unit of its dimension). */
export function UnitDialogButton() {
  const t = useTranslations("catalogue.unitsPage");
  const tDimensions = useTranslations("catalogue.dimensions");
  const tUnits = useTranslations("catalogue.units");
  const problem = useProblemMessage();
  const router = useRouter();
  const empty = () => ({
    code: "",
    name: "",
    nameSw: "",
    dimension: "volume" as UnitDimension,
    equalsQuantity: "",
    equalsUnit: "l",
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sized = SIZED.includes(form.dimension);
  const references = STANDARD_UNITS.filter(
    (unit) => unit.perBase && unit.dimension === form.dimension,
  );
  const valid =
    /^[a-z][a-z0-9_]{1,19}$/.test(form.code.trim().toLowerCase()) &&
    form.name.trim().length >= 2 &&
    (!sized ||
      (/^\d{1,12}(\.\d{1,6})?$/.test(form.equalsQuantity) && /[1-9]/.test(form.equalsQuantity)));

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest("/units", unitResponseSchema, {
        method: "POST",
        body: {
          code: form.code.trim(),
          name: form.name.trim(),
          nameSw: form.nameSw.trim(),
          dimension: form.dimension,
          equalsQuantity: sized ? form.equalsQuantity : null,
          equalsUnit: sized ? form.equalsUnit : null,
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

  return (
    <>
      <Button
        onClick={() => {
          setForm(empty());
          setFailure(null);
          setOpen(true);
        }}
      >
        <Plus aria-hidden /> {t("add")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("formTitle")}</DialogTitle>
            <DialogDescription>{t("formDescription")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id="unit-new"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) void submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor="unit-code">{t("code")}</FieldLabel>
              <Input
                id="unit-code"
                value={form.code}
                maxLength={20}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="unit-name">{t("name")}</FieldLabel>
              <Input
                id="unit-name"
                value={form.name}
                maxLength={60}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="unit-name-sw">{t("nameSw")}</FieldLabel>
              <Input
                id="unit-name-sw"
                value={form.nameSw}
                maxLength={60}
                onChange={(event) => setForm({ ...form, nameSw: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="unit-dimension">{t("dimension")}</FieldLabel>
              <select
                id="unit-dimension"
                value={form.dimension}
                className={selectClass}
                onChange={(event) => {
                  const dimension = event.target.value as UnitDimension;
                  const first = STANDARD_UNITS.find(
                    (unit) => unit.perBase && unit.dimension === dimension,
                  );
                  setForm({ ...form, dimension, equalsUnit: first?.code ?? "" });
                }}
              >
                {UNIT_DIMENSIONS.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {tDimensions(dimension)}
                  </option>
                ))}
              </select>
            </Field>
            {sized ? (
              <>
                <Field>
                  <FieldLabel htmlFor="unit-equals">{t("equals")}</FieldLabel>
                  <Input
                    id="unit-equals"
                    inputMode="decimal"
                    value={form.equalsQuantity}
                    onChange={(event) =>
                      setForm({ ...form, equalsQuantity: event.target.value.trim() })
                    }
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="unit-equals-unit">{t("equalsUnit")}</FieldLabel>
                  <select
                    id="unit-equals-unit"
                    value={form.equalsUnit}
                    className={selectClass}
                    onChange={(event) => setForm({ ...form, equalsUnit: event.target.value })}
                  >
                    {references.map((unit) => (
                      <option key={unit.code} value={unit.code}>
                        {tUnits(unit.code as StandardUnitCode)}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <FieldDescription className="sm:col-span-2">{t("noSize")}</FieldDescription>
            )}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="unit-new" disabled={busy || !valid}>
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Archives or restores a company unit. */
export function UnitStatusButton({ unit }: { unit: UnitWire }) {
  const t = useTranslations("catalogue.unitsPage");
  const problem = useProblemMessage();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const archiving = unit.status === "active";
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        aria-label={
          archiving
            ? t("archiveLabel", { code: unit.code })
            : t("restoreLabel", { code: unit.code })
        }
        onClick={() => {
          setFailure(null);
          liveRequest(`/units/${unit.id}`, unitResponseSchema, {
            method: "PATCH",
            body: { version: unit.version, status: archiving ? "archived" : "active" },
          })
            .then(() => router.refresh())
            .catch((error: unknown) => setFailure(problem(error)));
        }}
      >
        {archiving ? t("archive") : t("restore")}
      </Button>
      {failure ? (
        <span role="alert" className="text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </span>
  );
}

/** The company's price-change alert threshold (config.manage to change it). */
export function ThresholdForm({
  percent,
  version,
  canManage,
}: {
  percent: string;
  version: number;
  canManage: boolean;
}) {
  const t = useTranslations("catalogue.alerts");
  const problem = useProblemMessage();
  const router = useRouter();
  const [value, setValue] = useState(percent);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^\d{1,4}(\.\d{1,4})?$/.test(value) && Number(value) > 0 && Number(value) <= 1000;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest("/procurement/settings", procurementSettingsResponseSchema, {
        method: "PUT",
        body: { priceChangeAlertPercent: value, version },
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
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save();
      }}
    >
      <Field className="w-56">
        <FieldLabel htmlFor="alert-threshold">{t("thresholdLabel")}</FieldLabel>
        <Input
          id="alert-threshold"
          inputMode="decimal"
          value={value}
          disabled={!canManage}
          onChange={(event) => setValue(event.target.value.trim())}
        />
      </Field>
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
