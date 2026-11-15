"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link2, Plus, Trash2 } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { requisitionDetailResponseSchema, type UnitWire } from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { isPositiveQuantity } from "@/lib/p2p";
import type { ProjectOption, SiteOption } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { BqItemPicker, type BqItemChoice } from "./bq-item-picker";
import { useP2pProblem } from "./use-p2p-problem";

type MaterialOption = { id: string; code: string; name: string; baseUnit: string };
type Line = {
  key: string;
  materialId: string;
  quantity: string;
  unit: string;
  bqItem: BqItemChoice | null;
  note: string;
};
export type RequisitionInitial = {
  id: string;
  number: string;
  version: number;
  projectId: string;
  siteId: string | null;
  neededBy: string;
  notes: string | null;
  lines: Omit<Line, "key">[];
};

const blankLine = (key: string): Line => ({
  key,
  materialId: "",
  quantity: "",
  unit: "",
  bqItem: null,
  note: "",
});

/**
 * Raise or edit a draft requisition (D5.2): project, optional delivery site, needed-by date and
 * catalogue materials in any unit with an optional BQ item tag. The API converts every line to
 * the material's base unit and refuses conversions it cannot make.
 */
export function RequisitionForm({
  projects,
  sites,
  materials,
  units,
  initial,
  defaultProjectId,
  today,
}: {
  projects: ProjectOption[];
  sites: Record<string, SiteOption[]>;
  materials: MaterialOption[];
  units: UnitWire[];
  initial?: RequisitionInitial;
  defaultProjectId?: string;
  today: string;
}) {
  const t = useTranslations("p2p.requisitions.form");
  const tCommon = useTranslations("p2p.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const router = useRouter();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [projectId, setProjectId] = useState(
    initial?.projectId ?? defaultProjectId ?? projects[0]?.id ?? "",
  );
  const [siteId, setSiteId] = useState(initial?.siteId ?? "");
  const [neededBy, setNeededBy] = useState(initial?.neededBy ?? today);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  // Keys are stable between the server render and hydration (they also make the field IDs).
  const nextKey = useRef(initial?.lines.length ?? 1);
  const [lines, setLines] = useState<Line[]>(
    initial?.lines.map((line, index) => ({ ...line, key: `line${index}` })) ?? [blankLine("line0")],
  );
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const materialOf = (id: string) => materials.find((material) => material.id === id);
  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const valid =
    Boolean(projectId) &&
    /^\d{4}-\d{2}-\d{2}$/.test(neededBy) &&
    lines.length > 0 &&
    lines.every((line) => line.materialId && line.unit && isPositiveQuantity(line.quantity.trim()));

  async function save() {
    setBusy(true);
    setFailure(null);
    const body = {
      siteId: siteId || null,
      neededBy,
      notes: notes.trim() || null,
      lines: lines.map((line) => ({
        materialId: line.materialId,
        quantity: line.quantity.trim(),
        unit: line.unit,
        bqItemLineageId: line.bqItem?.lineageId ?? null,
        note: line.note.trim() || null,
      })),
    };
    try {
      const result = initial
        ? await liveRequest(
            `/procurement/requisitions/${initial.id}`,
            requisitionDetailResponseSchema,
            { method: "PATCH", body: { ...body, version: initial.version } },
          )
        : await liveRequest("/procurement/requisitions", requisitionDetailResponseSchema, {
            method: "POST",
            body: { ...body, projectId },
          });
      router.push(`/procurement/requisitions/${result.requisition.id}`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  if (!projects.length) return <p className="text-sm text-muted-foreground">{t("noProjects")}</p>;
  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void save();
      }}
    >
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="requisition-project">{t("project")}</FieldLabel>
            <select
              id="requisition-project"
              className={selectClass}
              value={projectId}
              disabled={Boolean(initial)}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSiteId("");
                setLines((current) => current.map((line) => ({ ...line, bqItem: null })));
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} · {project.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="requisition-site">{t("site")}</FieldLabel>
            <select
              id="requisition-site"
              className={selectClass}
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
            >
              <option value="">—</option>
              {(sites[projectId] ?? []).map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="requisition-needed-by">{t("neededBy")}</FieldLabel>
            <Input
              id="requisition-needed-by"
              type="date"
              value={neededBy}
              onChange={(event) => setNeededBy(event.target.value)}
              required
            />
          </Field>
          <Field className="sm:col-span-3">
            <FieldLabel htmlFor="requisition-notes">{tCommon("notesOptional")}</FieldLabel>
            <Textarea
              id="requisition-notes"
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("lines")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {lines.map((line, index) => {
            const material = materialOf(line.materialId);
            const no = index + 1;
            return (
              <fieldset key={line.key} className="space-y-3 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">{t("line", { no })}</legend>
                <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                  <Field>
                    <FieldLabel htmlFor={`line-${line.key}-material`}>{t("material")}</FieldLabel>
                    <select
                      id={`line-${line.key}-material`}
                      className={selectClass}
                      value={line.materialId}
                      onChange={(event) => {
                        const chosen = materialOf(event.target.value);
                        update(line.key, {
                          materialId: event.target.value,
                          unit: chosen?.baseUnit ?? "",
                        });
                      }}
                    >
                      <option value="">{t("chooseMaterial")}</option>
                      {materials.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.code} · {option.name}
                        </option>
                      ))}
                    </select>
                    {material ? (
                      <FieldDescription>
                        {t("baseUnit", { unit: label(material.baseUnit) })}
                      </FieldDescription>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`line-${line.key}-quantity`}>{t("quantity")}</FieldLabel>
                    <Input
                      id={`line-${line.key}-quantity`}
                      inputMode="decimal"
                      value={line.quantity}
                      aria-invalid={
                        line.quantity !== "" && !isPositiveQuantity(line.quantity.trim())
                      }
                      onChange={(event) => update(line.key, { quantity: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`line-${line.key}-unit`}>{t("unit")}</FieldLabel>
                    <select
                      id={`line-${line.key}-unit`}
                      className={selectClass}
                      value={line.unit}
                      onChange={(event) => update(line.key, { unit: event.target.value })}
                    >
                      <option value="">—</option>
                      {units.map((unit) => (
                        <option key={unit.code} value={unit.code}>
                          {label(unit.code)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">{t("bqItem")}</p>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={line.bqItem ? undefined : "text-muted-foreground"}>
                        {line.bqItem
                          ? `${line.bqItem.ref ? `${line.bqItem.ref} · ` : ""}${line.bqItem.description}`
                          : t("bqNone")}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setPicking(line.key)}
                      >
                        <Link2 aria-hidden /> {line.bqItem ? t("bqChange") : t("bqLink")}
                      </Button>
                      {line.bqItem ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => update(line.key, { bqItem: null })}
                        >
                          {t("bqUnlink")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <Field>
                    <FieldLabel htmlFor={`line-${line.key}-note`}>{t("lineNote")}</FieldLabel>
                    <Input
                      id={`line-${line.key}-note`}
                      maxLength={300}
                      value={line.note}
                      onChange={(event) => update(line.key, { note: event.target.value })}
                    />
                  </Field>
                </div>
                {lines.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setLines((current) => current.filter((entry) => entry.key !== line.key))
                    }
                  >
                    <Trash2 aria-hidden /> {t("removeLine", { no })}
                  </Button>
                ) : null}
              </fieldset>
            );
          })}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const key = `line${nextKey.current}`;
              nextKey.current += 1;
              setLines((current) => [...current, blankLine(key)]);
            }}
          >
            <Plus aria-hidden /> {t("addLine")}
          </Button>
        </CardContent>
      </Card>

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !valid}>
        {initial ? t("update") : t("create")}
      </Button>
      <BqItemPicker
        projectId={projectId}
        open={picking !== null}
        onClose={() => setPicking(null)}
        onChoose={(item) => {
          if (picking) update(picking, { bqItem: item });
        }}
      />
    </form>
  );
}
