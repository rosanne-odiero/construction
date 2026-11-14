"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { FUEL_SOURCES, USAGE_DAY_STATUSES, type UsageDayStatus } from "@pm-buddy/types";
import {
  correctFuelRequestSchema,
  correctUsageRequestSchema,
  plantFuelResponseSchema,
  plantUsageResponseSchema,
  recordFuelRequestSchema,
  recordUsageRequestSchema,
  type FuelWindowWire,
  type PlantFuelEntry,
  type PlantUsageEntry,
  type ProjectPlantItem,
  type ProjectPlantOptionsResponse,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { checkboxClass, field } from "@/components/safety/common";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import {
  parseLitresInput,
  parseTenthsInput,
  plantTabHref,
  recordRetryPlan,
  runBetween,
  signedPercent,
  windowTone,
} from "@/lib/plant";
import { parseCalendarInput } from "@/lib/project-input";
import { nairobiMoment } from "@/lib/safety";
import { newClientId } from "@/lib/spending";
import { FormDialog } from "./plant-actions";

const freshIds = () => ({
  id: newClientId(),
  key: newClientId(),
  capturedAt: new Date().toISOString(),
});

/** Shared submit logic: the record ID and Idempotency-Key are created once per form. */
function useSiteSubmit() {
  const problem = useProblemMessage();
  const [ids, setIds] = useState(freshIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit<T>(send: (ids: ReturnType<typeof freshIds>) => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await send(ids);
    } catch (caught) {
      const plan = recordRetryPlan(caught);
      if (plan === "renew") setIds(freshIds());
      setError(problem(caught));
      return plan === "recorded" ? ("recorded" as const) : null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, submit };
}

function ItemPicker({
  id,
  items,
  value,
  onChange,
}: {
  id: string;
  items: ProjectPlantItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("plant");
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t("usage.item")}</FieldLabel>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.code} · {item.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A day's usage of one item, laid out for a phone on site (360 px). */
export function UsageForm({
  projectId,
  items,
  options,
  initialPlantId,
  today,
}: {
  projectId: string;
  items: ProjectPlantItem[];
  options: ProjectPlantOptionsResponse;
  initialPlantId: string | null;
  today: string;
}) {
  const t = useTranslations("plant");
  const router = useRouter();
  const { busy, error, setError, submit } = useSiteSubmit();
  const [plantId, setPlantId] = useState(
    items.find((item) => item.id === initialPlantId)?.id ?? items[0]?.id ?? "",
  );
  const item = items.find((entry) => entry.id === plantId);
  const usualStatus = (entry: ProjectPlantItem | undefined): UsageDayStatus =>
    entry?.status === "under_repair" ? "breakdown" : "working";
  const [status, setStatus] = useState<UsageDayStatus>(usualStatus(item));
  const [start, setStart] = useState(item?.meter.reading ?? "");
  const [end, setEnd] = useState("");
  const metered = item ? item.meterType !== "none" : false;
  const run = metered ? runBetween(start, end) : null;
  const unit = item?.meterType === "km" ? "km" : "hours";

  async function onSubmit(form: FormData) {
    if (!item) return;
    const usedOn = parseCalendarInput(field(form, "usedOn"));
    const operator = field(form, "operator");
    const costCodeId = field(form, "costCodeId");
    const body = {
      siteId: item.location?.siteId,
      usedOn,
      dayStatus: status,
      startReading: metered ? (parseTenthsInput(start) ?? "") : null,
      endReading: metered ? (parseTenthsInput(end) ?? "") : null,
      ...(operator.startsWith("labourer:") ? { operatorLabourerId: operator.slice(9) } : {}),
      ...(operator.startsWith("staff:") ? { operatorUserId: operator.slice(6) } : {}),
      ...(costCodeId ? { costCodeId } : {}),
      notes: field(form, "notes"),
    };
    const result = await submit(async (ids) => {
      const parsed = recordUsageRequestSchema.safeParse({
        ...body,
        id: ids.id,
        capturedAt: ids.capturedAt,
      });
      if (!parsed.success || !usedOn || usedOn > (parseCalendarInput(today) ?? "")) {
        setError(t(metered ? "usage.invalidMetered" : "usage.invalid"));
        return null;
      }
      return liveRequest(`/plant/${item.id}/usage`, plantUsageResponseSchema, {
        method: "POST",
        body: parsed.data,
        headers: { "Idempotency-Key": ids.key },
      });
    });
    if (result) router.push(plantTabHref(projectId, "usage"));
  }

  if (!item) return <p>{t("tab.empty")}</p>;
  return (
    <form
      noValidate
      className="max-w-xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(new FormData(event.currentTarget));
      }}
    >
      <FormError message={error} />
      <ItemPicker
        id="usage-item"
        items={items}
        value={plantId}
        onChange={(next) => {
          const chosen = items.find((entry) => entry.id === next);
          setPlantId(next);
          setStatus(usualStatus(chosen));
          setStart(chosen?.meter.reading ?? "");
          setEnd("");
        }}
      />
      <p className="text-sm text-muted-foreground">
        {t("usage.at", { site: item.location?.siteName ?? "—" })}
      </p>
      <Field>
        <FieldLabel htmlFor="usage-date">{t("form.date")}</FieldLabel>
        <Input id="usage-date" name="usedOn" inputMode="numeric" defaultValue={today} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("usage.status")}</legend>
        <div className="flex flex-wrap gap-4">
          {USAGE_DAY_STATUSES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="dayStatus"
                checked={status === value}
                onChange={() => setStatus(value)}
                className="size-4 accent-primary"
              />
              {t(`dayStatus.${value}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {metered ? (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="usage-start">{t(`usage.start.${unit}`)}</FieldLabel>
            <Input
              id="usage-start"
              inputMode="decimal"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="usage-end">{t(`usage.end.${unit}`)}</FieldLabel>
            <Input
              id="usage-end"
              inputMode="decimal"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </Field>
          <p className="col-span-2 text-sm" aria-live="polite">
            {run ? t(`usage.run.${unit}`, { run }) : t("usage.readingsHint")}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("usage.noMeter")}</p>
      )}
      <Field>
        <FieldLabel htmlFor="usage-operator">{t("usage.operator")}</FieldLabel>
        <select id="usage-operator" name="operator" className={selectClass} defaultValue="">
          <option value="">{t("form.none")}</option>
          {item.operators.map((operator) => (
            <option key={operator.id} value={`${operator.kind}:${operator.id}`}>
              {operator.name}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="usage-cost-code">{t("usage.costCode")}</FieldLabel>
        <select id="usage-cost-code" name="costCodeId" className={selectClass} defaultValue="">
          <option value="">{t("form.none")}</option>
          {options.costCodes.map((code) => (
            <option key={code.id} value={code.id}>
              {code.code} · {code.name}
            </option>
          ))}
        </select>
        <FieldDescription>{t("usage.costCodeHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="usage-notes">{t("form.notesOptional")}</FieldLabel>
        <Textarea id="usage-notes" name="notes" maxLength={500} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {t("actions.saveUsage")}
        </Button>
        <Button asChild variant="outline">
          <Link href={plantTabHref(projectId)}>{t("actions.cancel")}</Link>
        </Button>
      </div>
    </form>
  );
}

/** What a fuelling's window shows: an estimate for review, never proof of theft. */
export function WindowSummary({ window, unit }: { window: FuelWindowWire; unit: "h" | "km" }) {
  const t = useTranslations("plant");
  return (
    <div className="space-y-1 text-sm">
      <StatusBadge tone={windowTone[window.state]}>{t(`windowState.${window.state}`)}</StatusBadge>
      <p>
        {t("fuel.windowLine", {
          litres: window.litres,
          advance: window.advance,
          unit,
          expected: window.expectedLitres ?? "—",
          variance: window.variancePercent ? signedPercent(window.variancePercent) : "—",
        })}
      </p>
    </div>
  );
}

/** Fuel issued to an item with the meter reading at fuelling, for a phone on site. */
export function FuelForm({
  projectId,
  items,
  initialPlantId,
  today,
  now,
}: {
  projectId: string;
  items: ProjectPlantItem[];
  initialPlantId: string | null;
  today: string;
  now: string;
}) {
  const t = useTranslations("plant");
  const { busy, error, setError, submit } = useSiteSubmit();
  const fuelled = useMemo(() => items.filter((item) => item.fuelType !== "none"), [items]);
  const [plantId, setPlantId] = useState(
    fuelled.find((item) => item.id === initialPlantId)?.id ?? fuelled[0]?.id ?? "",
  );
  const [recorded, setRecorded] = useState<{
    window: FuelWindowWire | null;
    staticMeter: boolean;
  } | null>(null);
  const item = fuelled.find((entry) => entry.id === plantId);
  const metered = item ? item.meterType !== "none" : false;

  async function onSubmit(form: FormData) {
    if (!item) return;
    const issuedAt = nairobiMoment(field(form, "date"), field(form, "time"));
    const receiver = field(form, "receiver");
    const result = await submit(async (ids) => {
      const parsed = recordFuelRequestSchema.safeParse({
        id: ids.id,
        capturedAt: ids.capturedAt,
        siteId: item.location?.siteId,
        issuedAt,
        litres: parseLitresInput(field(form, "litres")) ?? "",
        meterReading: metered ? (parseTenthsInput(field(form, "meterReading")) ?? "") : null,
        tankFilled: form.get("tankFilled") === "on",
        source: form.get("source"),
        reference: field(form, "reference"),
        ...(receiver.startsWith("labourer:") ? { receivedByLabourerId: receiver.slice(9) } : {}),
        ...(receiver.startsWith("staff:") ? { receivedByUserId: receiver.slice(6) } : {}),
        notes: field(form, "notes"),
      });
      if (!parsed.success) {
        setError(t(metered ? "fuel.invalidMetered" : "fuel.invalid"));
        return null;
      }
      return liveRequest(`/plant/${item.id}/fuel`, plantFuelResponseSchema, {
        method: "POST",
        body: parsed.data,
        headers: { "Idempotency-Key": ids.key },
      });
    });
    if (result && result !== "recorded")
      setRecorded({ window: result.window, staticMeter: result.entry.meterStatic });
    else if (result === "recorded") setRecorded({ window: null, staticMeter: false });
  }

  if (!item) return <p>{t("fuel.noFuelled")}</p>;
  if (recorded)
    return (
      <section aria-labelledby="fuel-recorded" className="max-w-xl space-y-3 rounded-md border p-4">
        <h2 id="fuel-recorded" className="text-base font-semibold">
          {t("fuel.recorded", { code: item.code })}
        </h2>
        {recorded.window ? (
          <WindowSummary window={recorded.window} unit={item.meterType === "km" ? "km" : "h"} />
        ) : (
          <p className="text-sm">{t("fuel.noWindow")}</p>
        )}
        {recorded.staticMeter ? (
          <StatusBadge tone="warning" className="h-auto whitespace-normal">
            {t("alertKind.fuel_meter_static")}
          </StatusBadge>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("fuel.estimateNote")}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={plantTabHref(projectId, "fuel")}>{t("actions.backToPlant")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/plant/${item.id}`}>{t("actions.openItem")}</Link>
          </Button>
        </div>
      </section>
    );
  return (
    <form
      noValidate
      className="max-w-xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(new FormData(event.currentTarget));
      }}
    >
      <FormError message={error} />
      <ItemPicker id="fuel-item" items={fuelled} value={plantId} onChange={setPlantId} />
      <p className="text-sm text-muted-foreground">
        {t("usage.at", { site: item.location?.siteName ?? "—" })} · {t(`fuelType.${item.fuelType}`)}
        {item.meter.reading ? ` · ${t("fuel.lastReading", { reading: item.meter.reading })}` : ""}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="fuel-date">{t("form.date")}</FieldLabel>
          <Input id="fuel-date" name="date" inputMode="numeric" defaultValue={today} />
        </Field>
        <Field>
          <FieldLabel htmlFor="fuel-time">{t("form.time")}</FieldLabel>
          <Input id="fuel-time" name="time" inputMode="numeric" defaultValue={now} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="fuel-litres">{t("fuel.litres")}</FieldLabel>
          <Input id="fuel-litres" name="litres" inputMode="decimal" />
        </Field>
        {metered ? (
          <Field>
            <FieldLabel htmlFor="fuel-reading">{t(`usage.reading.${item.meterType}`)}</FieldLabel>
            <Input id="fuel-reading" name="meterReading" inputMode="decimal" />
          </Field>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="tankFilled" defaultChecked className={checkboxClass} />
        {t("fuel.tankFilled")}
      </label>
      <p className="text-xs text-muted-foreground">{t("fuel.tankHint")}</p>
      <Field>
        <FieldLabel htmlFor="fuel-source">{t("fuel.source")}</FieldLabel>
        <select id="fuel-source" name="source" className={selectClass} defaultValue="site_store">
          {FUEL_SOURCES.map((source) => (
            <option key={source} value={source}>
              {t(`fuelSource.${source}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="fuel-reference">{t("fuel.reference")}</FieldLabel>
        <Input id="fuel-reference" name="reference" maxLength={60} />
      </Field>
      <Field>
        <FieldLabel htmlFor="fuel-receiver">{t("fuel.receivedBy")}</FieldLabel>
        <select id="fuel-receiver" name="receiver" className={selectClass} defaultValue="">
          <option value="">{t("form.none")}</option>
          {item.operators.map((operator) => (
            <option key={operator.id} value={`${operator.kind}:${operator.id}`}>
              {operator.name}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="fuel-notes">{t("form.notesOptional")}</FieldLabel>
        <Textarea id="fuel-notes" name="notes" maxLength={500} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {t("actions.saveFuel")}
        </Button>
        <Button asChild variant="outline">
          <Link href={plantTabHref(projectId)}>{t("actions.cancel")}</Link>
        </Button>
      </div>
    </form>
  );
}

/** Correct (new values) or void a usage entry or fuel issue, with a reason; never an edit. */
export function CorrectEntry(
  props:
    | { kind: "usage"; plantId: string; entry: PlantUsageEntry; meterType: string }
    | { kind: "fuel"; plantId: string; entry: PlantFuelEntry; meterType: string },
) {
  const t = useTranslations("plant");
  const { busy, error, setError, run } = useScheduleMutation();
  const [action, setAction] = useState<"correct" | "void" | null>(null);
  const { entry, plantId } = props;
  if (!entry.permissions.canCorrect) return null;
  const metered = props.meterType !== "none";
  const label = props.kind === "usage" ? entry.id.slice(0, 8) : entry.id.slice(0, 8);

  function submit(form: FormData) {
    const base = {
      id: newClientId(),
      capturedAt: new Date().toISOString(),
      reason: field(form, "reason"),
    };
    const headers = { "Idempotency-Key": newClientId() };
    if (props.kind === "usage") {
      const usage = props.entry;
      const parsed = correctUsageRequestSchema.safeParse(
        action === "void"
          ? { ...base, action: "void" }
          : {
              ...base,
              action: "correct",
              siteId: usage.siteId,
              dayStatus: form.get("dayStatus"),
              startReading: metered ? (parseTenthsInput(field(form, "start")) ?? "") : null,
              endReading: metered ? (parseTenthsInput(field(form, "end")) ?? "") : null,
              ...(usage.operator?.kind === "labourer"
                ? { operatorLabourerId: usage.operator.id }
                : {}),
              ...(usage.operator?.kind === "staff" ? { operatorUserId: usage.operator.id } : {}),
              ...(usage.costCode ? { costCodeId: usage.costCode.id } : {}),
              ...(usage.bqItem ? { bqItemLineageId: usage.bqItem.lineageId } : {}),
              notes: field(form, "notes"),
            },
      );
      if (!parsed.success) return setError(t("form.invalid"));
      void run(
        () =>
          liveRequest(`/plant/${plantId}/usage/${usage.id}/corrections`, plantUsageResponseSchema, {
            method: "POST",
            body: parsed.data,
            headers,
          }),
        () => setAction(null),
      );
      return;
    }
    const issue = props.entry;
    const parsed = correctFuelRequestSchema.safeParse(
      action === "void"
        ? { ...base, action: "void" }
        : {
            ...base,
            action: "correct",
            siteId: issue.siteId,
            issuedAt: issue.issuedAt,
            litres: parseLitresInput(field(form, "litres")) ?? "",
            meterReading: metered ? (parseTenthsInput(field(form, "meterReading")) ?? "") : null,
            tankFilled: form.get("tankFilled") === "on",
            source: issue.source,
            reference: issue.reference ?? "",
            ...(issue.receivedBy?.kind === "labourer"
              ? { receivedByLabourerId: issue.receivedBy.id }
              : {}),
            ...(issue.receivedBy?.kind === "staff"
              ? { receivedByUserId: issue.receivedBy.id }
              : {}),
            notes: issue.notes ?? "",
          },
    );
    if (!parsed.success) return setError(t("form.invalid"));
    void run(
      () =>
        liveRequest(`/plant/${plantId}/fuel/${issue.id}/corrections`, plantFuelResponseSchema, {
          method: "POST",
          body: parsed.data,
          headers,
        }),
      () => setAction(null),
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {(["correct", "void"] as const)
        .filter((value) => value === "correct" || props.entry.state !== "voided")
        .map((value) => (
          <Button
            key={value}
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              setAction(value);
            }}
          >
            {t(`actions.${value}`)}
            <span className="sr-only"> {label}</span>
          </Button>
        ))}
      <FormDialog
        open={action !== null}
        onOpenChange={(next) => (next ? undefined : setAction(null))}
        title={action === "void" ? t("correct.voidTitle") : t("correct.title")}
        hint={t("correct.hint")}
        busy={busy}
        error={error}
        submitLabel={action === "void" ? t("actions.void") : t("actions.correct")}
        onSubmit={submit}
      >
        {action === "correct" && props.kind === "usage" ? (
          <>
            <Field>
              <FieldLabel htmlFor="correct-status">{t("usage.status")}</FieldLabel>
              <select
                id="correct-status"
                name="dayStatus"
                className={selectClass}
                defaultValue={props.entry.dayStatus}
              >
                {USAGE_DAY_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`dayStatus.${value}`)}
                  </option>
                ))}
              </select>
            </Field>
            {metered ? (
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="correct-start">{t("correct.start")}</FieldLabel>
                  <Input
                    id="correct-start"
                    name="start"
                    inputMode="decimal"
                    defaultValue={props.entry.startReading ?? ""}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="correct-end">{t("correct.end")}</FieldLabel>
                  <Input
                    id="correct-end"
                    name="end"
                    inputMode="decimal"
                    defaultValue={props.entry.endReading ?? ""}
                  />
                </Field>
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor="correct-notes">{t("form.notesOptional")}</FieldLabel>
              <Textarea
                id="correct-notes"
                name="notes"
                maxLength={500}
                defaultValue={props.entry.notes ?? ""}
              />
            </Field>
          </>
        ) : null}
        {action === "correct" && props.kind === "fuel" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="correct-litres">{t("fuel.litres")}</FieldLabel>
                <Input
                  id="correct-litres"
                  name="litres"
                  inputMode="decimal"
                  defaultValue={props.entry.litres}
                />
              </Field>
              {metered ? (
                <Field>
                  <FieldLabel htmlFor="correct-reading">{t("correct.reading")}</FieldLabel>
                  <Input
                    id="correct-reading"
                    name="meterReading"
                    inputMode="decimal"
                    defaultValue={props.entry.meterReading ?? ""}
                  />
                </Field>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="tankFilled"
                defaultChecked={props.entry.tankFilled}
                className={checkboxClass}
              />
              {t("fuel.tankFilled")}
            </label>
          </>
        ) : null}
        <Field>
          <FieldLabel htmlFor="correct-reason">{t("form.reason")}</FieldLabel>
          <Textarea id="correct-reason" name="reason" maxLength={500} />
        </Field>
      </FormDialog>
    </div>
  );
}
