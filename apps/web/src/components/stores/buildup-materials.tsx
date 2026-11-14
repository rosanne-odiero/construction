"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link2, Link2Off } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import {
  buildupMaterialsResponseSchema,
  type BuildupMaterialsResponse,
  type UnitWire,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { StatusBadge } from "@/components/status-badge";
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
import { liveRequest } from "@/lib/live-api";
import { unitLabel } from "@/lib/procurement";
import { formatStock } from "@/lib/stores";

type MaterialOption = { id: string; name: string; baseUnit: string };

/**
 * Maps the material lines of a build-up version to catalogue materials (D5.3), so stores can work
 * out theoretical consumption in each material's base unit. The build-up version itself never
 * changes; unmapped lines are reported as "not mapped" by the variance report.
 */
export function BuildupMaterials({
  initial,
  materials,
  units,
}: {
  initial: BuildupMaterialsResponse;
  materials: MaterialOption[];
  units: UnitWire[];
}) {
  const t = useTranslations("stores.mapping");
  const tCommon = useTranslations("stores.common");
  const tUnits = useTranslations("catalogue.units");
  const problem = useP2pProblem();
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [materialId, setMaterialId] = useState("");
  const [unit, setUnit] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const base = `/rate-buildups/${view.buildup.id}/versions/${view.versionNo}/materials`;
  const line = view.lines.find((entry) => entry.lineId === editing) ?? null;

  async function call(path: string, method: "PUT" | "DELETE", body?: Record<string, unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      setView(await liveRequest(path, buildupMaterialsResponseSchema, { method, body }));
      setEditing(null);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  if (!view.lines.length) return null;
  return (
    <section aria-labelledby="buildup-materials" className="space-y-3">
      <h2 id="buildup-materials" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("description", { version: view.versionNo })}
      </p>
      {failure && !editing ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      <ul className="space-y-2">
        {view.lines.map((entry) => (
          <li
            key={entry.lineId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="font-medium">
                {entry.lineNo}. {entry.resourceName}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("perUnit", {
                  quantity: formatStock(entry.quantity),
                  unit: entry.unit,
                  output: view.buildup.unit,
                })}
              </p>
              {entry.mapping ? (
                <p className="text-sm">
                  {t("mappedTo", {
                    material: entry.mapping.material.name,
                    unit: label(entry.mapping.unit),
                    quantity: formatStock(entry.mapping.basePerUnitDecimal),
                    base: label(entry.mapping.material.baseUnit),
                  })}
                </p>
              ) : (
                <StatusBadge tone="warning">{t("notMapped")}</StatusBadge>
              )}
            </div>
            {view.permissions.canMap ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFailure(null);
                    setEditing(entry.lineId);
                    setMaterialId(entry.mapping?.material.id ?? materials[0]?.id ?? "");
                    setUnit(entry.mapping?.unit ?? materials[0]?.baseUnit ?? "");
                  }}
                >
                  <Link2 aria-hidden /> {entry.mapping ? t("change") : t("map")}
                </Button>
                {entry.mapping ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void call(`${base}/${entry.lineId}`, "DELETE")}
                  >
                    <Link2Off aria-hidden /> {t("unmap")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <Dialog open={line !== null} onOpenChange={(next) => (next ? undefined : setEditing(null))}>
        <DialogContent>
          {line ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("dialogTitle", { line: line.resourceName })}</DialogTitle>
                <DialogDescription>{t("dialogDescription", { unit: line.unit })}</DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="map-material">{tCommon("material")}</FieldLabel>
                <select
                  id="map-material"
                  className={`${selectClass} h-11`}
                  value={materialId}
                  onChange={(event) => {
                    setMaterialId(event.target.value);
                    setUnit(
                      materials.find((entry) => entry.id === event.target.value)?.baseUnit ?? unit,
                    );
                  }}
                >
                  {materials.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="map-unit">{t("unit")}</FieldLabel>
                <select
                  id="map-unit"
                  className={`${selectClass} h-11`}
                  value={unit}
                  onChange={(event) => setUnit(event.target.value)}
                >
                  {units.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {label(entry.code)}
                    </option>
                  ))}
                </select>
                <FieldDescription>{t("unitHint")}</FieldDescription>
              </Field>
              {failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {tCommon("close")}
                </Button>
                <Button
                  type="button"
                  disabled={busy || !materialId || !unit}
                  onClick={() => void call(`${base}/${line.lineId}`, "PUT", { materialId, unit })}
                >
                  {tCommon("save")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
