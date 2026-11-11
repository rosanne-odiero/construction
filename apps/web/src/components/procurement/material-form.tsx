"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Pencil, Plus } from "lucide-react";
import {
  MATERIAL_CATEGORIES,
  ROOFING_GAUGES,
  STEEL_BAR_DIAMETERS_MM,
  type MaterialCategory,
  type StandardUnitCode,
} from "@pm-buddy/types";
import {
  CATEGORY_ATTRIBUTES,
  materialResponseSchema,
  type Material,
  type MaterialAttributesInput,
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
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { unitLabel } from "@/lib/procurement";

type AttributeKey = keyof MaterialAttributesInput;
type Form = {
  name: string;
  nameSw: string;
  category: MaterialCategory;
  baseUnit: string;
  spec: string;
  notes: string;
  status: "active" | "archived";
  attributes: Partial<Record<AttributeKey, string>>;
};

const LENGTH = /^\d{1,6}(\.\d{1,4})?$/;
const TEXT_ATTRIBUTES: AttributeKey[] = [
  "pieceLengthM",
  "coverWidthM",
  "sectionWidthMm",
  "sectionDepthMm",
  "sheetWidthM",
  "sheetLengthM",
  "rollLengthM",
];
export const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

const fromMaterial = (material?: Material): Form => ({
  name: material?.name ?? "",
  nameSw: material?.nameSw ?? "",
  category: material?.category ?? "other",
  baseUnit: material?.baseUnit ?? "nr",
  spec: material?.spec ?? "",
  notes: material?.notes ?? "",
  status: material?.status ?? "active",
  attributes: Object.fromEntries(
    Object.entries(material?.attributes ?? {}).map(([key, value]) => [key, String(value)]),
  ),
});

/** Adds or edits a material; the attributes shown depend on the category. */
export function MaterialFormButton({
  units,
  material,
}: {
  units: readonly UnitWire[];
  material?: Material;
}) {
  const t = useTranslations("catalogue.form");
  const tCategories = useTranslations("catalogue.categories");
  const tStatuses = useTranslations("catalogue.statuses");
  const tUnits = useTranslations("catalogue.units");
  const problem = useProblemMessage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(() => fromMaterial(material));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const editing = material !== undefined;
  const id = editing ? `material-${material.id}` : "material-new";
  const allowed = CATEGORY_ATTRIBUTES[form.category];
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const usable = units.filter((unit) => unit.status === "active" || unit.code === form.baseUnit);

  const attributes = (): MaterialAttributesInput => {
    const result: Record<string, string | number> = {};
    for (const key of allowed) {
      const value = form.attributes[key]?.trim();
      if (!value) continue;
      result[key] = key === "diameterMm" || key === "gauge" ? Number(value) : value;
    }
    return result as MaterialAttributesInput;
  };
  const valid =
    form.name.trim().length >= 2 &&
    form.baseUnit.length > 0 &&
    TEXT_ATTRIBUTES.every((key) => {
      const value = form.attributes[key]?.trim();
      return !allowed.includes(key) || !value || (LENGTH.test(value) && /[1-9]/.test(value));
    });

  async function submit() {
    setBusy(true);
    setFailure(null);
    const body = {
      name: form.name.trim(),
      nameSw: form.nameSw.trim(),
      category: form.category,
      baseUnit: form.baseUnit,
      spec: form.spec.trim(),
      notes: form.notes.trim(),
      attributes: attributes(),
    };
    try {
      const saved = await liveRequest(
        editing ? `/materials/${material.id}` : "/materials",
        materialResponseSchema,
        editing
          ? { method: "PATCH", body: { ...body, status: form.status, version: material.version } }
          : { method: "POST", body },
      );
      setOpen(false);
      if (editing) router.refresh();
      else router.push(`/catalogue/${saved.material.id}`);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const textAttribute = (key: AttributeKey, hint?: string) =>
    allowed.includes(key) ? (
      <Field key={key}>
        <FieldLabel htmlFor={`${id}-${key}`}>{t(key)}</FieldLabel>
        <Input
          id={`${id}-${key}`}
          inputMode={key === "meshType" ? undefined : "decimal"}
          value={form.attributes[key] ?? ""}
          maxLength={key === "meshType" ? 6 : 11}
          onChange={(event) =>
            setForm({ ...form, attributes: { ...form.attributes, [key]: event.target.value } })
          }
        />
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      </Field>
    ) : null;

  return (
    <>
      <Button
        variant={editing ? "outline" : "default"}
        onClick={() => {
          setForm(fromMaterial(material));
          setFailure(null);
          setOpen(true);
        }}
      >
        {editing ? <Pencil aria-hidden /> : <Plus aria-hidden />}{" "}
        {editing ? t("edit") : t("create")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("editTitle", { code: material.code }) : t("createTitle")}
            </DialogTitle>
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
              <FieldLabel htmlFor={`${id}-name`}>{t("name")}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={form.name}
                maxLength={150}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-name-sw`}>{t("nameSw")}</FieldLabel>
              <Input
                id={`${id}-name-sw`}
                value={form.nameSw}
                maxLength={150}
                onChange={(event) => setForm({ ...form, nameSw: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-category`}>{t("category")}</FieldLabel>
              <select
                id={`${id}-category`}
                value={form.category}
                className={selectClass}
                onChange={(event) =>
                  setForm({ ...form, category: event.target.value as MaterialCategory })
                }
              >
                {MATERIAL_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {tCategories(category)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-unit`}>{t("baseUnit")}</FieldLabel>
              <select
                id={`${id}-unit`}
                value={form.baseUnit}
                className={selectClass}
                onChange={(event) => setForm({ ...form, baseUnit: event.target.value })}
              >
                {usable.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {label(unit.code)}
                  </option>
                ))}
              </select>
              <FieldDescription>{t("baseUnitHint")}</FieldDescription>
            </Field>
            <fieldset className="grid gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-2">
              <legend className="px-1 text-sm font-medium">{t("attributes")}</legend>
              {allowed.length === 0 ? (
                <p className="text-sm text-muted-foreground sm:col-span-2">{t("noAttributes")}</p>
              ) : null}
              {allowed.includes("diameterMm") ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-diameter`}>{t("diameterMm")}</FieldLabel>
                  <select
                    id={`${id}-diameter`}
                    value={form.attributes.diameterMm ?? ""}
                    className={selectClass}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        attributes: { ...form.attributes, diameterMm: event.target.value },
                      })
                    }
                  >
                    <option value="">{t("none")}</option>
                    {STEEL_BAR_DIAMETERS_MM.map((diameter) => (
                      <option key={diameter} value={diameter}>
                        {t("diameterOption", { diameter })}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {allowed.includes("gauge") ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-gauge`}>{t("gauge")}</FieldLabel>
                  <select
                    id={`${id}-gauge`}
                    value={form.attributes.gauge ?? ""}
                    className={selectClass}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        attributes: { ...form.attributes, gauge: event.target.value },
                      })
                    }
                  >
                    <option value="">{t("none")}</option>
                    {ROOFING_GAUGES.map((gauge) => (
                      <option key={gauge} value={gauge}>
                        {t("gaugeOption", { gauge })}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {textAttribute("meshType")}
              {textAttribute(
                "pieceLengthM",
                form.category === "steel" ? t("pieceLengthSteelHint") : undefined,
              )}
              {textAttribute("coverWidthM")}
              {textAttribute("sectionWidthMm")}
              {textAttribute("sectionDepthMm")}
              {textAttribute("sheetWidthM")}
              {textAttribute("sheetLengthM")}
              {textAttribute("rollLengthM")}
            </fieldset>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-spec`}>{t("spec")}</FieldLabel>
              <Input
                id={`${id}-spec`}
                value={form.spec}
                maxLength={200}
                onChange={(event) => setForm({ ...form, spec: event.target.value })}
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-notes`}>{t("notes")}</FieldLabel>
              <Textarea
                id={`${id}-notes`}
                value={form.notes}
                maxLength={2000}
                rows={2}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </Field>
            {editing ? (
              <Field>
                <FieldLabel htmlFor={`${id}-status`}>{t("status")}</FieldLabel>
                <select
                  id={`${id}-status`}
                  value={form.status}
                  className={selectClass}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as Form["status"] })
                  }
                >
                  {(["active", "archived"] as const).map((status) => (
                    <option key={status} value={status}>
                      {tStatuses(status)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form={id} disabled={busy || !valid}>
              {editing ? t("save") : t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
