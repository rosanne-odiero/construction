"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Save, Trash2 } from "lucide-react";
import { buildupRate, type BuildupLineInput } from "@pm-buddy/domain";
import {
  BUILDUP_OUTPUT_UNITS,
  BUILDUP_RESOURCE_KINDS,
  type BuildupOutputUnit,
  type BuildupResourceKind,
} from "@pm-buddy/types";
import { buildupResponseSchema, type BuildupResponse } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { decimalKesToMinor, formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { useUnitLabel } from "./bq-labels";

type Line = {
  key: string;
  kind: BuildupResourceKind;
  resourceName: string;
  unit: string;
  quantity: string;
  waste: string;
  cost: string;
};

const QUANTITY = /^\d{1,9}(\.\d{1,6})?$/;
const WASTE = /^\d{1,3}(\.\d{1,4})?$/;
const KES = /^\d{1,9}(\.\d{1,2})?$/;
// Keys must match between the server render and hydration: initial lines use their position.
const newLine = (
  kind: BuildupResourceKind = "material",
  key: string = crypto.randomUUID(),
): Line => ({
  key,
  kind,
  resourceName: "",
  unit: "",
  quantity: "",
  waste: "",
  cost: "",
});
const kes = (minor: number | null) =>
  minor === null ? "" : `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/**
 * Creates a build-up or saves a new version of one. The rate preview uses the same domain function
 * as the API (each line rounded half-up to the cent; undefined while a line has no unit cost).
 */
export function BuildupEditor({ existing }: { existing?: BuildupResponse }) {
  const t = useTranslations("rateBuildUps.editor");
  const tKinds = useTranslations("rateBuildUps.kinds");
  const unitLabel = useUnitLabel();
  const problem = useProblemMessage();
  const router = useRouter();
  const current = existing?.current;
  const [code, setCode] = useState(existing?.buildup.code ?? "");
  const [name, setName] = useState(current?.name ?? "");
  const [unit, setUnit] = useState<BuildupOutputUnit>(current?.unit ?? "m3");
  const [assumptions, setAssumptions] = useState(current?.assumptions ?? "");
  const [lines, setLines] = useState<Line[]>(
    current
      ? current.lines.map((line, index) => ({
          key: `line-${index}`,
          kind: line.kind,
          resourceName: line.resourceName,
          unit: line.unit,
          quantity: line.quantity,
          waste: line.wastePercent ?? "",
          cost: kes(line.unitCostMinor),
        }))
      : [newLine("material", "line-0"), newLine("labour", "line-1")],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const validLine = (line: Line) =>
    line.resourceName.trim().length > 0 &&
    line.unit.trim().length > 0 &&
    QUANTITY.test(line.quantity) &&
    Number(line.quantity) > 0 &&
    (line.waste === "" || (WASTE.test(line.waste) && Number(line.waste) <= 100)) &&
    (line.cost === "" || KES.test(line.cost));
  const inputs: BuildupLineInput[] = lines.filter(validLine).map((line) => ({
    kind: line.kind,
    resourceName: line.resourceName.trim(),
    unit: line.unit.trim(),
    quantity: line.quantity,
    wastePercent: line.waste === "" ? null : line.waste,
    unitCostMinor: line.cost === "" ? null : decimalKesToMinor(line.cost),
  }));
  const preview = buildupRate(inputs);
  const valid =
    (existing ? true : /^[A-Za-z0-9][A-Za-z0-9./-]{0,29}$/.test(code.trim())) &&
    name.trim().length >= 3 &&
    lines.length > 0 &&
    lines.every(validLine);

  function update(key: string, patch: Partial<Line>) {
    setLines(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    const body = { name: name.trim(), unit, assumptions: assumptions.trim(), lines: inputs };
    try {
      const saved = await liveRequest(
        existing ? `/rate-buildups/${existing.buildup.id}` : "/rate-buildups",
        buildupResponseSchema,
        existing
          ? { method: "PUT", body: { ...body, version: existing.buildup.version } }
          : { method: "POST", body: { ...body, code: code.trim() } },
      );
      router.push(`/rate-buildups/${saved.buildup.id}`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            {existing
              ? t("editTitle", { version: existing.buildup.currentVersionNo + 1 })
              : t("createTitle")}
          </h2>
        </CardTitle>
        <CardDescription>
          {existing ? t("editDescription") : t("createDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <form
          id="buildup-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="buildup-code">{t("code")}</FieldLabel>
              <Input
                id="buildup-code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                maxLength={30}
                disabled={Boolean(existing)}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="buildup-name">{t("name")}</FieldLabel>
              <Input
                id="buildup-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={150}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="buildup-unit">{t("unit")}</FieldLabel>
              <select
                id="buildup-unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value as BuildupOutputUnit)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {BUILDUP_OUTPUT_UNITS.map((option) => (
                  <option key={option} value={option}>
                    {unitLabel(option, null)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="buildup-assumptions">{t("assumptions")}</FieldLabel>
            <Textarea
              id="buildup-assumptions"
              value={assumptions}
              onChange={(event) => setAssumptions(event.target.value)}
              maxLength={2000}
              rows={3}
            />
            <FieldDescription>{t("assumptionsHint")}</FieldDescription>
          </Field>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("lines")}</legend>
            {lines.map((line, index) => {
              const amount = (() => {
                if (!validLine(line) || line.cost === "") return null;
                return buildupRate([
                  {
                    kind: line.kind,
                    resourceName: line.resourceName,
                    unit: line.unit,
                    quantity: line.quantity,
                    wastePercent: line.waste === "" ? null : line.waste,
                    unitCostMinor: decimalKesToMinor(line.cost),
                  },
                ]).rateMinor;
              })();
              return (
                <div
                  key={line.key}
                  className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[8rem_1fr_7rem_7rem_6rem_8rem_auto]"
                >
                  <Field>
                    <FieldLabel htmlFor={`${line.key}-kind`}>
                      {t("cols.kind", { line: index + 1 })}
                    </FieldLabel>
                    <select
                      id={`${line.key}-kind`}
                      value={line.kind}
                      onChange={(event) =>
                        update(line.key, { kind: event.target.value as BuildupResourceKind })
                      }
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      {BUILDUP_RESOURCE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {tKinds(kind)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${line.key}-name`}>{t("cols.resource")}</FieldLabel>
                    <Input
                      id={`${line.key}-name`}
                      value={line.resourceName}
                      maxLength={120}
                      onChange={(event) => update(line.key, { resourceName: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${line.key}-unit`}>{t("cols.unit")}</FieldLabel>
                    <Input
                      id={`${line.key}-unit`}
                      value={line.unit}
                      maxLength={30}
                      onChange={(event) => update(line.key, { unit: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${line.key}-qty`}>{t("cols.quantity")}</FieldLabel>
                    <Input
                      id={`${line.key}-qty`}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) =>
                        update(line.key, { quantity: event.target.value.trim() })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${line.key}-waste`}>{t("cols.waste")}</FieldLabel>
                    <Input
                      id={`${line.key}-waste`}
                      inputMode="decimal"
                      value={line.waste}
                      onChange={(event) => update(line.key, { waste: event.target.value.trim() })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${line.key}-cost`}>{t("cols.cost")}</FieldLabel>
                    <Input
                      id={`${line.key}-cost`}
                      inputMode="decimal"
                      value={line.cost}
                      onChange={(event) => update(line.key, { cost: event.target.value.trim() })}
                    />
                  </Field>
                  <div className="flex items-end justify-between gap-2 sm:flex-col sm:items-end">
                    <span className="text-sm tabular-nums" aria-live="polite">
                      {amount === null ? t("unpriced") : formatKES(amount)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={lines.length === 1}
                      aria-label={t("removeLine", { line: index + 1 })}
                      onClick={() => setLines(lines.filter((other) => other.key !== line.key))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={lines.length >= 50}
              onClick={() => setLines([...lines, newLine()])}
            >
              <Plus aria-hidden /> {t("addLine")}
            </Button>
          </fieldset>
        </form>
        <dl className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-4" aria-live="polite">
          {(["material", "labour", "plant"] as const).map((kind) => (
            <div key={kind}>
              <dt className="text-xs text-muted-foreground">{tKinds(kind)}</dt>
              <dd className="tabular-nums">{formatKES(preview.byKind[kind])}</dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-muted-foreground">
              {t("rate", { unit: unitLabel(unit, null) })}
            </dt>
            <dd className="font-semibold tabular-nums" data-testid="buildup-rate-preview">
              {preview.rateMinor === null
                ? t("rateUnavailable", { count: preview.unpricedLines })
                : formatKES(preview.rateMinor)}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{t("rounding")}</p>
        <Button type="submit" form="buildup-form" disabled={busy || !valid}>
          <Save aria-hidden /> {existing ? t("saveVersion") : t("create")}
        </Button>
      </CardContent>
    </Card>
  );
}
