"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { CONCRETE_CLASSES, CUBE_RULE, type CubeTestAge } from "@pm-buddy/types";
import {
  correctCubeResultRequestSchema,
  correctSlumpTestRequestSchema,
  createCubeSetRequestSchema,
  createSlumpTestRequestSchema,
  cubeSetResponseSchema,
  recordCubeResultRequestSchema,
  slumpTestResponseSchema,
  voidCubeSetRequestSchema,
  type CubeResult,
  type CubeSet,
  type CubeSetsResponse,
  type Site,
  type SlumpTest,
  type SlumpTestsResponse,
} from "@pm-buddy/validation";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import {
  cubeOutcomeTone,
  cubeStateTone,
  parseStrengths,
  parseWhole,
  qualityHref,
  slumpToleranceFor,
} from "@/lib/quality";

type DialogState =
  | { kind: "newSet" }
  | { kind: "record"; set: CubeSet; age: CubeTestAge }
  | { kind: "correct"; set: CubeSet; result: CubeResult }
  | { kind: "void"; set: CubeSet }
  | { kind: "newSlump" }
  | { kind: "correctSlump"; test: SlumpTest };

const CUBE_FILTERS = ["all", "overdue", "failed"] as const;

/** Concrete cube sets (7- and 28-day results, rule KE-CUBE-1) and slump tests (KE-SLUMP-1). */
export function ConcretePanel({
  projectId,
  cubes,
  slump,
  sites,
  filter,
}: {
  projectId: string;
  cubes: CubeSetsResponse;
  slump: SlumpTestsResponse;
  sites: Site[];
  filter: (typeof CUBE_FILTERS)[number];
}) {
  const t = useTranslations("quality");
  const { busy, error, setError, run } = useScheduleMutation();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [target, setTarget] = useState("75");
  const [tolerance, setTolerance] = useState("20");
  const show = (next: DialogState) => {
    setError(null);
    if (next.kind === "newSlump" || next.kind === "correctSlump") {
      const test = next.kind === "correctSlump" ? next.test : null;
      setTarget(String(test?.targetMm ?? 75));
      setTolerance(String(test?.toleranceMm ?? 20));
    }
    setDialog(next);
  };

  function submit(form: FormData) {
    if (!dialog) return;
    const text = (name: string) => String(form.get(name) ?? "");
    const date = (name: string) => parseCalendarInput(text(name));
    const invalid = () => setError(t("tests.invalid"));
    if (dialog.kind === "newSet") {
      const parsed = createCubeSetRequestSchema.safeParse({
        siteId: form.get("siteId"),
        element: text("element"),
        concreteClass: form.get("concreteClass"),
        castOn: date("castOn"),
        cubesPerAge: parseWhole(text("cubesPerAge"), 1, 6),
        batchReference: text("batchReference"),
      });
      if (!parsed.success) return invalid();
      return void run(
        () =>
          liveRequest(`/projects/${projectId}/quality/cubes`, cubeSetResponseSchema, {
            method: "POST",
            body: parsed.data,
          }),
        () => setDialog(null),
      );
    }
    if (dialog.kind === "record" || dialog.kind === "correct") {
      const strengths = parseStrengths(text("strengths"));
      if (!strengths) return setError(t("tests.strengthsInvalid"));
      const content = {
        testedOn: date("testedOn"),
        strengths,
        laboratory: text("laboratory"),
        reportReference: text("reportReference"),
      };
      const parsed =
        dialog.kind === "record"
          ? recordCubeResultRequestSchema.safeParse({ ...content, ageDays: dialog.age })
          : correctCubeResultRequestSchema.safeParse({ ...content, reason: text("reason") });
      if (!parsed.success) return invalid();
      const path =
        dialog.kind === "record"
          ? `/projects/${projectId}/quality/cubes/${dialog.set.id}/results`
          : `/projects/${projectId}/quality/cubes/${dialog.set.id}/results/${dialog.result.id}/corrections`;
      return void run(
        () => liveRequest(path, cubeSetResponseSchema, { method: "POST", body: parsed.data }),
        () => setDialog(null),
      );
    }
    if (dialog.kind === "void") {
      const parsed = voidCubeSetRequestSchema.safeParse({
        version: dialog.set.version,
        reason: text("reason"),
      });
      if (!parsed.success) return setError(t("checklist.reasonInvalid"));
      return void run(
        () =>
          liveRequest(
            `/projects/${projectId}/quality/cubes/${dialog.set.id}/void`,
            cubeSetResponseSchema,
            { method: "POST", body: parsed.data },
          ),
        () => setDialog(null),
      );
    }
    const content = {
      testedOn: date("testedOn"),
      element: text("element"),
      concreteClass: text("concreteClass") || null,
      targetMm: parseWhole(target, 10, 250),
      toleranceMm: parseWhole(tolerance, 5, 60),
      measuredMm: parseWhole(text("measuredMm"), 0, 300),
      notes: text("notes"),
    };
    const parsed =
      dialog.kind === "newSlump"
        ? createSlumpTestRequestSchema.safeParse({
            ...content,
            siteId: form.get("siteId"),
            cubeSetId: text("cubeSetId") || null,
          })
        : correctSlumpTestRequestSchema.safeParse({ ...content, reason: text("reason") });
    if (!parsed.success) return invalid();
    const path =
      dialog.kind === "newSlump"
        ? `/projects/${projectId}/quality/slump-tests`
        : `/projects/${projectId}/quality/slump-tests/${dialog.test.id}/corrections`;
    void run(
      () => liveRequest(path, slumpTestResponseSchema, { method: "POST", body: parsed.data }),
      () => setDialog(null),
    );
  }

  const suggested = slumpToleranceFor(target);
  const correcting = dialog?.kind === "correct" ? dialog.result : null;
  const slumpTest = dialog?.kind === "correctSlump" ? dialog.test : null;

  return (
    <div className="space-y-8">
      <section aria-labelledby="cubes-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="cubes-heading" className="text-base font-semibold">
            {t("tests.cubesTitle")}
          </h3>
          {cubes.permissions.canCreate ? (
            <Button disabled={!sites.length} onClick={() => show({ kind: "newSet" })}>
              <Plus className="size-4" aria-hidden />
              {t("tests.newSet")}
            </Button>
          ) : null}
        </div>
        <p className="rounded-md border bg-muted p-3 text-sm">
          {t("tests.cubeRule", {
            rule: CUBE_RULE.version,
            margin: CUBE_RULE.individualMarginNmm2,
            percent: CUBE_RULE.sevenDayIndicativePercent,
          })}
        </p>
        <nav aria-label={t("tests.filterLabel")}>
          <ul className="flex flex-wrap gap-2">
            {CUBE_FILTERS.map((key) => (
              <li key={key}>
                <Link
                  href={qualityHref(projectId, "tests", key === "all" ? {} : { filter: key })}
                  aria-current={key === filter ? "page" : undefined}
                  className={
                    key === filter
                      ? "inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3 text-sm font-medium text-primary-foreground"
                      : "inline-flex h-8 items-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent"
                  }
                >
                  {key === "all"
                    ? t("tests.filter.all")
                    : t(`tests.filter.${key}`, { count: cubes.counts[key] })}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {cubes.cubeSets.length ? (
          <ul className="space-y-3">
            {cubes.cubeSets.map((set) => (
              <li key={set.id}>
                <article
                  className="space-y-3 rounded-md border p-4"
                  aria-label={`${set.code} ${set.element}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h4 className="min-w-0 font-semibold break-words">
                      <span className="font-mono text-sm">{set.code}</span> · {set.element}
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge tone="neutral" className="h-auto whitespace-normal text-left">
                        {set.concreteClass}
                      </StatusBadge>
                      {set.status === "void" ? (
                        <StatusBadge tone="neutral" className="h-auto whitespace-normal text-left">
                          {t("tests.void")}
                        </StatusBadge>
                      ) : set.outcome ? (
                        <StatusBadge
                          tone={cubeOutcomeTone[set.outcome]}
                          className="h-auto whitespace-normal text-left"
                        >
                          {t(`cubeOutcome.${set.outcome}`)}
                        </StatusBadge>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("tests.setMeta", {
                      cast: formatCalendarDate(set.castOn),
                      site: set.siteName,
                      cubes: set.cubesPerAge,
                      strength: set.specifiedStrength,
                    })}
                    {set.batchReference ? ` · ${set.batchReference}` : ""}
                  </p>
                  {set.voidReason ? (
                    <p className="text-sm break-words">
                      {t("tests.voidReason", { reason: set.voidReason })}
                    </p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    {set.ages.map((age) => (
                      <div
                        key={age.ageDays}
                        className="min-w-0 space-y-2 rounded-md border p-3 text-sm break-words"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
                            {t("tests.ageTitle", { days: age.ageDays })}
                          </span>
                          {age.result ? (
                            <StatusBadge
                              tone={cubeOutcomeTone[age.result.outcome]}
                              className="h-auto whitespace-normal text-left"
                            >
                              {t(`cubeOutcome.${age.result.outcome}`)}
                            </StatusBadge>
                          ) : (
                            <StatusBadge
                              tone={cubeStateTone[age.state]}
                              className="h-auto whitespace-normal text-left"
                            >
                              {t(`cubeState.${age.state}`)}
                            </StatusBadge>
                          )}
                        </div>
                        {age.result ? (
                          <>
                            <p>
                              {t("tests.resultLine", {
                                mean: age.result.meanStrength,
                                percent: age.result.percentOfClass,
                                min: age.result.minStrength,
                              })}
                            </p>
                            <p className="text-muted-foreground break-words">
                              {t("tests.cubes", { values: age.result.strengths.join(" · ") })} ·{" "}
                              {formatCalendarDate(age.result.testedOn)}
                            </p>
                            {age.result.correctionReason ? (
                              <p className="break-words">
                                {t("tests.corrected", { reason: age.result.correctionReason })}
                              </p>
                            ) : null}
                            {set.permissions.canCorrect ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => show({ kind: "correct", set, result: age.result! })}
                              >
                                {t("tests.correctNamed", { code: set.code, days: age.ageDays })}
                              </Button>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <p>{t("tests.dueOn", { date: formatCalendarDate(age.dueOn) })}</p>
                            {set.permissions.canRecord && age.dueOn <= nairobiDate() ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => show({ kind: "record", set, age: age.ageDays })}
                              >
                                {t("tests.recordNamed", { code: set.code, days: age.ageDays })}
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  {set.permissions.canVoid ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => show({ kind: "void", set })}
                    >
                      {t("tests.voidNamed", { code: set.code })}
                    </Button>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("tests.noCubes")}</p>
        )}
        {cubes.nextCursor ? (
          <Link
            className="text-sm underline"
            href={qualityHref(projectId, "tests", {
              ...(filter === "all" ? {} : { filter }),
              cursor: String(cubes.nextCursor),
            })}
          >
            {t("filters.older")}
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="slump-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="slump-heading" className="text-base font-semibold">
            {t("tests.slumpTitle")}
          </h3>
          {slump.permissions.canCreate ? (
            <Button disabled={!sites.length} onClick={() => show({ kind: "newSlump" })}>
              <Plus className="size-4" aria-hidden />
              {t("tests.newSlump")}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t("tests.slumpRule")}</p>
        {slump.slumpTests.length ? (
          <ul className="space-y-3">
            {slump.slumpTests.map((test) => (
              <li key={test.id}>
                <article
                  className="space-y-2 rounded-md border p-4 text-sm"
                  aria-label={`${test.code} ${test.element}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h4 className="min-w-0 font-semibold break-words">
                      <span className="font-mono text-sm">{test.code}</span> · {test.element}
                    </h4>
                    <StatusBadge
                      tone={test.outcome === "pass" ? "success" : "danger"}
                      className="h-auto whitespace-normal text-left"
                    >
                      {t(`slumpOutcome.${test.outcome}`)}
                    </StatusBadge>
                  </div>
                  <p>
                    {t("tests.slumpLine", {
                      measured: test.measuredMm,
                      target: test.targetMm,
                      tolerance: test.toleranceMm,
                      deviation: test.deviationMm,
                    })}
                  </p>
                  <p className="text-muted-foreground">
                    {formatCalendarDate(test.testedOn)} · {test.siteName}
                    {test.concreteClass ? ` · ${test.concreteClass}` : ""}
                    {test.cubeSet ? ` · ${test.cubeSet.code}` : ""}
                  </p>
                  {test.correctionReason ? (
                    <p className="break-words">
                      {t("tests.corrected", { reason: test.correctionReason })}
                    </p>
                  ) : null}
                  {test.permissions.canCorrect ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => show({ kind: "correctSlump", test })}
                    >
                      {t("tests.correctSlumpNamed", { code: test.code })}
                    </Button>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("tests.noSlump")}</p>
        )}
      </section>

      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setDialog(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "newSet"
                ? t("tests.newSet")
                : dialog?.kind === "record"
                  ? t("tests.recordNamed", { code: dialog.set.code, days: dialog.age })
                  : dialog?.kind === "correct"
                    ? t("tests.correctNamed", {
                        code: dialog.set.code,
                        days: dialog.result.ageDays,
                      })
                    : dialog?.kind === "void"
                      ? t("tests.voidNamed", { code: dialog.set.code })
                      : dialog?.kind === "correctSlump"
                        ? t("tests.correctSlumpNamed", { code: dialog.test.code })
                        : t("tests.newSlump")}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "correct" || dialog?.kind === "correctSlump"
                ? t("tests.correctHint")
                : dialog?.kind === "void"
                  ? t("tests.voidHint")
                  : t("tests.immutableHint")}
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            {dialog?.kind === "newSet" || dialog?.kind === "newSlump" ? (
              <Field>
                <FieldLabel htmlFor="test-site">{t("fields.site")}</FieldLabel>
                <select id="test-site" name="siteId" className={selectClass}>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {dialog?.kind === "newSet" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="set-element">{t("tests.element")}</FieldLabel>
                  <Input id="set-element" name="element" maxLength={200} required />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="set-class">{t("tests.class")}</FieldLabel>
                    <select
                      id="set-class"
                      name="concreteClass"
                      defaultValue="C25"
                      className={selectClass}
                    >
                      {CONCRETE_CLASSES.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="set-cast">{t("tests.castOn")}</FieldLabel>
                    <Input
                      id="set-cast"
                      name="castOn"
                      placeholder="DD/MM/YYYY"
                      defaultValue={calendarInput(nairobiDate())}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="set-cubes">{t("tests.cubesPerAge")}</FieldLabel>
                    <Input id="set-cubes" name="cubesPerAge" inputMode="numeric" defaultValue="3" />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="set-batch">{t("tests.batchReference")}</FieldLabel>
                  <Input id="set-batch" name="batchReference" maxLength={60} />
                </Field>
              </>
            ) : null}
            {dialog?.kind === "record" || dialog?.kind === "correct" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="result-strengths">{t("tests.strengths")}</FieldLabel>
                  <Input
                    id="result-strengths"
                    name="strengths"
                    inputMode="decimal"
                    defaultValue={correcting?.strengths.join(", ") ?? ""}
                    required
                    aria-describedby="result-strengths-hint"
                  />
                  <FieldDescription id="result-strengths-hint">
                    {t("tests.strengthsHint")}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="result-tested">{t("tests.testedOn")}</FieldLabel>
                  <Input
                    id="result-tested"
                    name="testedOn"
                    placeholder="DD/MM/YYYY"
                    defaultValue={calendarInput(correcting?.testedOn ?? nairobiDate())}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="result-lab">{t("tests.laboratory")}</FieldLabel>
                    <Input
                      id="result-lab"
                      name="laboratory"
                      maxLength={120}
                      defaultValue={correcting?.laboratory ?? ""}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="result-report">{t("tests.reportReference")}</FieldLabel>
                    <Input
                      id="result-report"
                      name="reportReference"
                      maxLength={60}
                      defaultValue={correcting?.reportReference ?? ""}
                    />
                  </Field>
                </div>
              </>
            ) : null}
            {dialog?.kind === "newSlump" || dialog?.kind === "correctSlump" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="slump-element">{t("tests.element")}</FieldLabel>
                  <Input
                    id="slump-element"
                    name="element"
                    maxLength={200}
                    defaultValue={slumpTest?.element ?? ""}
                    required
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="slump-date">{t("tests.testedOn")}</FieldLabel>
                    <Input
                      id="slump-date"
                      name="testedOn"
                      placeholder="DD/MM/YYYY"
                      defaultValue={calendarInput(slumpTest?.testedOn ?? nairobiDate())}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="slump-class">{t("tests.class")}</FieldLabel>
                    <select
                      id="slump-class"
                      name="concreteClass"
                      defaultValue={slumpTest?.concreteClass ?? ""}
                      className={selectClass}
                    >
                      <option value="">{t("tests.noClass")}</option>
                      {CONCRETE_CLASSES.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {dialog.kind === "newSlump" && cubes.cubeSets.length ? (
                  <Field>
                    <FieldLabel htmlFor="slump-set">{t("tests.cubeSet")}</FieldLabel>
                    <select id="slump-set" name="cubeSetId" className={selectClass}>
                      <option value="">{t("tests.noCubeSet")}</option>
                      {cubes.cubeSets
                        .filter((set) => set.status === "active")
                        .map((set) => (
                          <option key={set.id} value={set.id}>
                            {set.code} {set.element}
                          </option>
                        ))}
                    </select>
                  </Field>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="slump-target">{t("tests.targetMm")}</FieldLabel>
                    <Input
                      id="slump-target"
                      inputMode="numeric"
                      value={target}
                      onChange={(event) => setTarget(event.currentTarget.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="slump-tolerance">{t("tests.toleranceMm")}</FieldLabel>
                    <Input
                      id="slump-tolerance"
                      inputMode="numeric"
                      value={tolerance}
                      onChange={(event) => setTolerance(event.currentTarget.value)}
                      aria-describedby="slump-tolerance-hint"
                    />
                    <FieldDescription id="slump-tolerance-hint">
                      {suggested === null
                        ? t("tests.toleranceHintNone")
                        : t("tests.toleranceHint", { value: suggested })}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="slump-measured">{t("tests.measuredMm")}</FieldLabel>
                    <Input
                      id="slump-measured"
                      name="measuredMm"
                      inputMode="numeric"
                      defaultValue={slumpTest ? String(slumpTest.measuredMm) : ""}
                      required
                    />
                  </Field>
                </div>
              </>
            ) : null}
            {dialog?.kind === "correct" ||
            dialog?.kind === "void" ||
            dialog?.kind === "correctSlump" ? (
              <Field>
                <FieldLabel htmlFor="test-reason">{t("fields.reason")}</FieldLabel>
                <Textarea id="test-reason" name="reason" minLength={3} maxLength={500} required />
              </Field>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("actions.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
