"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  BREAKDOWN_SEVERITIES,
  METER_RESET_REASONS,
  SERVICE_KINDS,
  type BreakdownResolution,
} from "@pm-buddy/types";
import {
  assignOperatorRequestSchema,
  closePlantRequestSchema,
  movePlantRequestSchema,
  plantDetailResponseSchema,
  projectPlantOptionsResponseSchema,
  recordMeterResetRequestSchema,
  recordServiceRequestSchema,
  reportBreakdownRequestSchema,
  resolveBreakdownRequestSchema,
  type PlantBreakdown,
  type PlantDetailResponse,
  type PlantOperator,
  type PlantOptionsResponse,
  type PlantServiceRecord,
  type ProjectPlantOptionsResponse,
} from "@pm-buddy/validation";
import { field, ReasonDialog } from "@/components/safety/common";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { parseTenthsInput } from "@/lib/plant";
import { parseCalendarInput } from "@/lib/project-input";
import { nairobiMoment } from "@/lib/safety";
import { PlantForm } from "./plant-form";

/** A dialog with a form: the API's problem shows inside, so nothing typed is lost. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  hint,
  busy,
  error,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hint?: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("plant");
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hint ? <DialogDescription>{hint}</DialogDescription> : null}
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(new FormData(event.currentTarget));
          }}
        >
          <FormError message={error} />
          {children}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Date (DD/MM/YYYY) and time (HH:MM) fields for a Nairobi moment. */
function MomentFields({ id, today, now }: { id: string; today: string; now: string }) {
  const t = useTranslations("plant");
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-date`}>{t("form.date")}</FieldLabel>
        <Input id={`${id}-date`} name="date" inputMode="numeric" defaultValue={today} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-time`}>{t("form.time")}</FieldLabel>
        <Input id={`${id}-time`} name="time" inputMode="numeric" defaultValue={now} />
      </Field>
    </div>
  );
}

type Mode = "edit" | "move" | "close" | "operator" | "service" | "reset" | "breakdown" | null;

/** The item page's actions, offered by the record's `permissions` (D8.3). */
export function PlantActions({
  detail,
  options,
  today,
  now,
}: {
  detail: PlantDetailResponse;
  options: PlantOptionsResponse | null;
  today: string;
  now: string;
}) {
  const t = useTranslations("plant");
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<Mode>(null);
  const [operatorKind, setOperatorKind] = useState<"labourer" | "staff">("labourer");
  const [people, setPeople] = useState<ProjectPlantOptionsResponse | null>(null);
  const [labourerId, setLabourerId] = useState("");
  const { item, permissions } = detail;
  const location = item.location;
  const open = (next: Mode) => {
    setError(null);
    setMode(next);
  };
  const post = (path: string, body: Record<string, unknown>) =>
    run(
      () =>
        liveRequest(`/plant/${item.id}${path}`, plantDetailResponseSchema, {
          method: "POST",
          body,
        }),
      () => setMode(null),
    );

  async function searchPeople(text: string) {
    if (!location) return;
    const query = new URLSearchParams({ search: text.trim() });
    try {
      setPeople(
        await liveRequest(
          `/projects/${location.projectId}/plant/options?${query.toString()}`,
          projectPlantOptionsResponseSchema,
        ),
      );
    } catch {
      setError(t("form.searchFailed"));
    }
  }

  const buttons: [Mode, boolean, string][] = [
    ["edit", permissions.canEdit && options !== null, t("actions.edit")],
    ["move", permissions.canMove && options !== null, t("actions.move")],
    ["operator", permissions.canAssignOperator, t("actions.assignOperator")],
    ["breakdown", permissions.canReportBreakdown, t("actions.reportBreakdown")],
    ["service", permissions.canRecordService, t("actions.recordService")],
    ["reset", permissions.canResetMeter, t("actions.resetMeter")],
    [
      "close",
      permissions.canClose,
      item.ownership === "hired" ? t("actions.offHire") : t("actions.dispose"),
    ],
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {location && permissions.canRecordUsage ? (
        <Button asChild>
          <Link href={`/projects/${location.projectId}/plant/usage?plantId=${item.id}`}>
            {t("actions.recordUsage")}
          </Link>
        </Button>
      ) : null}
      {location && permissions.canRecordFuel ? (
        <Button asChild variant="secondary">
          <Link href={`/projects/${location.projectId}/plant/fuel?plantId=${item.id}`}>
            {t("actions.recordFuel")}
          </Link>
        </Button>
      ) : null}
      {buttons
        .filter(([, allowed]) => allowed)
        .map(([key, , label]) => (
          <Button
            key={key}
            variant="outline"
            onClick={() => {
              open(key);
              if (key === "operator" && !people) void searchPeople("");
            }}
          >
            {label}
          </Button>
        ))}

      {options ? (
        <Dialog open={mode === "edit"} onOpenChange={(next) => setMode(next ? "edit" : null)}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("actions.edit")}</DialogTitle>
              <DialogDescription>{t("form.fixedHint")}</DialogDescription>
            </DialogHeader>
            <PlantForm options={options} today={today} item={item} onDone={() => setMode(null)} />
          </DialogContent>
        </Dialog>
      ) : null}

      <FormDialog
        open={mode === "move"}
        onOpenChange={(next) => setMode(next ? "move" : null)}
        title={t("actions.move")}
        hint={t("move.hint")}
        busy={busy}
        error={error}
        submitLabel={t("actions.move")}
        onSubmit={(form) => {
          const parsed = movePlantRequestSchema.safeParse({
            version: item.version,
            siteId: field(form, "siteId") || null,
            movedOn: parseCalendarInput(field(form, "movedOn")),
            reason: field(form, "reason"),
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void post("/moves", parsed.data);
        }}
      >
        <Field>
          <FieldLabel htmlFor="move-site">{t("move.to")}</FieldLabel>
          <select id="move-site" name="siteId" className={selectClass} defaultValue="">
            <option value="">{t("yard")}</option>
            {(options?.sites ?? [])
              .filter((site) => site.siteId !== location?.siteId)
              .map((site) => (
                <option key={site.siteId} value={site.siteId}>
                  {site.projectCode} · {site.siteName}
                </option>
              ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="move-date">{t("form.date")}</FieldLabel>
          <Input id="move-date" name="movedOn" inputMode="numeric" defaultValue={today} />
        </Field>
        <Field>
          <FieldLabel htmlFor="move-reason">{t("form.reasonOptional")}</FieldLabel>
          <Textarea id="move-reason" name="reason" maxLength={500} />
        </Field>
      </FormDialog>

      <FormDialog
        open={mode === "close"}
        onOpenChange={(next) => setMode(next ? "close" : null)}
        title={item.ownership === "hired" ? t("actions.offHire") : t("actions.dispose")}
        hint={t("close.hint")}
        busy={busy}
        error={error}
        submitLabel={item.ownership === "hired" ? t("actions.offHire") : t("actions.dispose")}
        onSubmit={(form) => {
          const parsed = closePlantRequestSchema.safeParse({
            version: item.version,
            action: item.ownership === "hired" ? "off_hire" : "dispose",
            closedOn: parseCalendarInput(field(form, "closedOn")),
            reason: field(form, "reason"),
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void post("/close", parsed.data);
        }}
      >
        <Field>
          <FieldLabel htmlFor="close-date">{t("form.date")}</FieldLabel>
          <Input id="close-date" name="closedOn" inputMode="numeric" defaultValue={today} />
        </Field>
        <Field>
          <FieldLabel htmlFor="close-reason">{t("form.reason")}</FieldLabel>
          <Textarea id="close-reason" name="reason" maxLength={500} />
        </Field>
      </FormDialog>

      <FormDialog
        open={mode === "operator"}
        onOpenChange={(next) => setMode(next ? "operator" : null)}
        title={t("actions.assignOperator")}
        hint={t("operator.hint")}
        busy={busy}
        error={error}
        submitLabel={t("actions.assignOperator")}
        onSubmit={(form) => {
          const expires = field(form, "certificateExpiresOn");
          const to = field(form, "toOn");
          const parsed = assignOperatorRequestSchema.safeParse({
            projectId: location?.projectId,
            kind: operatorKind,
            ...(operatorKind === "labourer"
              ? { labourerId: labourerId || undefined }
              : { userId: field(form, "userId") || undefined }),
            fromOn: parseCalendarInput(field(form, "fromOn")),
            toOn: to ? parseCalendarInput(to) : null,
            certificateRef: field(form, "certificateRef"),
            certificateExpiresOn: expires ? parseCalendarInput(expires) : null,
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void post("/operators", parsed.data);
        }}
      >
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">{t("operator.kind")}</legend>
          {(["labourer", "staff"] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="operatorKind"
                checked={operatorKind === kind}
                onChange={() => setOperatorKind(kind)}
                className="size-4 accent-primary"
              />
              {t(`operator.${kind}`)}
            </label>
          ))}
        </fieldset>
        {operatorKind === "labourer" ? (
          <>
            <Field>
              <FieldLabel htmlFor="operator-search">{t("operator.search")}</FieldLabel>
              <Input
                id="operator-search"
                type="search"
                maxLength={100}
                onChange={(event) => void searchPeople(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="operator-labourer">{t("operator.labourer")}</FieldLabel>
              <select
                id="operator-labourer"
                className={selectClass}
                value={labourerId}
                onChange={(event) => setLabourerId(event.target.value)}
              >
                <option value="">{t("form.choose")}</option>
                {(people?.labourers ?? []).map((labourer) => (
                  <option key={labourer.id} value={labourer.id}>
                    {labourer.fullName} ({labourer.workerNo})
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <Field>
            <FieldLabel htmlFor="operator-staff">{t("operator.staff")}</FieldLabel>
            <select id="operator-staff" name="userId" className={selectClass} defaultValue="">
              <option value="">{t("form.choose")}</option>
              {(people?.staff ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="operator-from">{t("operator.from")}</FieldLabel>
            <Input id="operator-from" name="fromOn" inputMode="numeric" defaultValue={today} />
          </Field>
          <Field>
            <FieldLabel htmlFor="operator-to">{t("operator.to")}</FieldLabel>
            <Input id="operator-to" name="toOn" inputMode="numeric" />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="operator-cert">{t("operator.certificate")}</FieldLabel>
          <Input id="operator-cert" name="certificateRef" maxLength={60} />
        </Field>
        <Field>
          <FieldLabel htmlFor="operator-expiry">{t("operator.expires")}</FieldLabel>
          <Input id="operator-expiry" name="certificateExpiresOn" inputMode="numeric" />
        </Field>
      </FormDialog>

      <FormDialog
        open={mode === "breakdown"}
        onOpenChange={(next) => setMode(next ? "breakdown" : null)}
        title={t("actions.reportBreakdown")}
        hint={t("breakdown.hint")}
        busy={busy}
        error={error}
        submitLabel={t("actions.reportBreakdown")}
        onSubmit={(form) => {
          const reportedAt = nairobiMoment(field(form, "date"), field(form, "time"));
          const parsed = reportBreakdownRequestSchema.safeParse({
            siteId: location?.siteId,
            reportedAt,
            severity: form.get("severity"),
            description: field(form, "description"),
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void post("/breakdowns", parsed.data);
        }}
      >
        <MomentFields id="breakdown" today={today} now={now} />
        <Field>
          <FieldLabel htmlFor="breakdown-severity">{t("breakdown.severity")}</FieldLabel>
          <select
            id="breakdown-severity"
            name="severity"
            className={selectClass}
            defaultValue="major"
          >
            {BREAKDOWN_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`severity.${severity}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="breakdown-description">{t("breakdown.description")}</FieldLabel>
          <Textarea id="breakdown-description" name="description" maxLength={1000} />
        </Field>
      </FormDialog>

      <FormDialog
        open={mode === "service"}
        onOpenChange={(next) => setMode(next ? "service" : null)}
        title={t("actions.recordService")}
        hint={t("service.hint")}
        busy={busy}
        error={error}
        submitLabel={t("actions.recordService")}
        onSubmit={(form) => {
          const reading = field(form, "meterReading");
          const parsed = recordServiceRequestSchema.safeParse({
            servicedAt: nairobiMoment(field(form, "date"), field(form, "time")),
            kind: form.get("kind"),
            meterReading: item.meterType === "none" ? null : (parseTenthsInput(reading) ?? ""),
            description: field(form, "description"),
            doneBy: field(form, "doneBy"),
            costReference: field(form, "costReference"),
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void post("/services", parsed.data);
        }}
      >
        <MomentFields id="service" today={today} now={now} />
        <Field>
          <FieldLabel htmlFor="service-kind">{t("service.kind")}</FieldLabel>
          <select id="service-kind" name="kind" className={selectClass} defaultValue="service">
            {SERVICE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`serviceKind.${kind}`)}
              </option>
            ))}
          </select>
        </Field>
        {item.meterType === "none" ? null : (
          <Field>
            <FieldLabel htmlFor="service-reading">
              {t(`usage.reading.${item.meterType}`)}
            </FieldLabel>
            <Input
              id="service-reading"
              name="meterReading"
              inputMode="decimal"
              defaultValue={item.meter.reading ?? ""}
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="service-description">{t("service.description")}</FieldLabel>
          <Textarea id="service-description" name="description" maxLength={500} />
        </Field>
        <Field>
          <FieldLabel htmlFor="service-by">{t("service.doneBy")}</FieldLabel>
          <Input id="service-by" name="doneBy" maxLength={120} />
        </Field>
        <Field>
          <FieldLabel htmlFor="service-ref">{t("service.costReference")}</FieldLabel>
          <Input id="service-ref" name="costReference" maxLength={60} />
        </Field>
      </FormDialog>

      <FormDialog
        open={mode === "reset"}
        onOpenChange={(next) => setMode(next ? "reset" : null)}
        title={t("actions.resetMeter")}
        hint={t("reset.hint")}
        busy={busy}
        error={error}
        submitLabel={t("actions.resetMeter")}
        onSubmit={(form) => {
          const parsed = recordMeterResetRequestSchema.safeParse({
            resetAt: nairobiMoment(field(form, "date"), field(form, "time")),
            oldReading: parseTenthsInput(field(form, "oldReading")) ?? "",
            newReading: parseTenthsInput(field(form, "newReading")) ?? "",
            reason: form.get("reason"),
            note: field(form, "note"),
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void post("/meter-resets", parsed.data);
        }}
      >
        <MomentFields id="reset" today={today} now={now} />
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="reset-old">{t("reset.old")}</FieldLabel>
            <Input
              id="reset-old"
              name="oldReading"
              inputMode="decimal"
              defaultValue={item.meter.reading ?? ""}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="reset-new">{t("reset.new")}</FieldLabel>
            <Input id="reset-new" name="newReading" inputMode="decimal" defaultValue="0" />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="reset-reason">{t("reset.reason")}</FieldLabel>
          <select
            id="reset-reason"
            name="reason"
            className={selectClass}
            defaultValue="meter_replaced"
          >
            {METER_RESET_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(`resetReason.${reason}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="reset-note">{t("form.reason")}</FieldLabel>
          <Textarea id="reset-note" name="note" maxLength={500} />
        </Field>
      </FormDialog>
    </div>
  );
}

/** Record the repair of a breakdown, or send the item off hire / write it off. */
export function BreakdownActions({
  plantId,
  breakdown,
  today,
}: {
  plantId: string;
  breakdown: PlantBreakdown;
  today: string;
}) {
  const t = useTranslations("plant");
  const { busy, error, setError, run } = useScheduleMutation();
  const [resolution, setResolution] = useState<BreakdownResolution | null>(null);
  const offered: [BreakdownResolution, boolean][] = [
    ["repaired", breakdown.permissions.canRepair],
    ["off_hire", breakdown.permissions.canOffHire],
    ["written_off", breakdown.permissions.canWriteOff],
  ];
  if (!offered.some(([, allowed]) => allowed)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {offered
        .filter(([, allowed]) => allowed)
        .map(([key]) => (
          <Button
            key={key}
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              setResolution(key);
            }}
          >
            {t(`resolve.${key}`)}
            <span className="sr-only">: {breakdown.code}</span>
          </Button>
        ))}
      <FormDialog
        open={resolution !== null}
        onOpenChange={(next) => (next ? undefined : setResolution(null))}
        title={resolution ? `${t(`resolve.${resolution}`)}: ${breakdown.code}` : ""}
        hint={resolution && resolution !== "repaired" ? t("resolve.closeHint") : undefined}
        busy={busy}
        error={error}
        submitLabel={resolution ? t(`resolve.${resolution}`) : ""}
        onSubmit={(form) => {
          const parsed = resolveBreakdownRequestSchema.safeParse({
            version: breakdown.version,
            resolution,
            resolvedOn: parseCalendarInput(field(form, "resolvedOn")),
            note: field(form, "note"),
            repairedBy: field(form, "repairedBy"),
            costReference: field(form, "costReference"),
          });
          if (!parsed.success) return setError(t("form.invalid"));
          void run(
            () =>
              liveRequest(
                `/plant/${plantId}/breakdowns/${breakdown.id}/resolve`,
                plantDetailResponseSchema,
                { method: "POST", body: parsed.data },
              ),
            () => setResolution(null),
          );
        }}
      >
        <Field>
          <FieldLabel htmlFor="resolve-date">{t("form.date")}</FieldLabel>
          <Input id="resolve-date" name="resolvedOn" inputMode="numeric" defaultValue={today} />
        </Field>
        {resolution === "repaired" ? (
          <>
            <Field>
              <FieldLabel htmlFor="resolve-by">{t("resolve.repairedBy")}</FieldLabel>
              <Input id="resolve-by" name="repairedBy" maxLength={120} />
            </Field>
            <Field>
              <FieldLabel htmlFor="resolve-ref">{t("service.costReference")}</FieldLabel>
              <Input id="resolve-ref" name="costReference" maxLength={60} />
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel htmlFor="resolve-note">
            {resolution === "repaired" ? t("form.reasonOptional") : t("form.reason")}
          </FieldLabel>
          <Textarea id="resolve-note" name="note" maxLength={500} />
        </Field>
      </FormDialog>
    </div>
  );
}

/** Void a service record entered in error. */
export function ServiceVoid({
  plantId,
  service,
}: {
  plantId: string;
  service: PlantServiceRecord;
}) {
  const t = useTranslations("plant");
  const { busy, error, setError, run } = useScheduleMutation();
  const [open, setOpen] = useState(false);
  if (!service.permissions.canVoid) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t("actions.void")}
      </Button>
      <ReasonDialog
        open={open}
        title={t("service.voidTitle")}
        busy={busy}
        error={error}
        onOpenChange={setOpen}
        onSubmit={(reason) =>
          void run(
            () =>
              liveRequest(
                `/plant/${plantId}/services/${service.id}/void`,
                plantDetailResponseSchema,
                {
                  method: "POST",
                  body: { version: service.version, reason },
                },
              ),
            () => setOpen(false),
          )
        }
      />
    </>
  );
}

/** End an operator assignment on a date. */
export function OperatorEnd({
  plantId,
  operator,
  today,
}: {
  plantId: string;
  operator: PlantOperator;
  today: string;
}) {
  const t = useTranslations("plant");
  const { busy, error, setError, run } = useScheduleMutation();
  const [open, setOpen] = useState(false);
  if (!operator.permissions.canEnd) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t("operator.end")}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={t("operator.end")}
        busy={busy}
        error={error}
        submitLabel={t("operator.end")}
        onSubmit={(form) => {
          const toOn = parseCalendarInput(field(form, "toOn"));
          if (!toOn) return setError(t("form.invalid"));
          void run(
            () =>
              liveRequest(
                `/plant/${plantId}/operators/${operator.id}/end`,
                plantDetailResponseSchema,
                { method: "POST", body: { version: operator.version, toOn } },
              ),
            () => setOpen(false),
          );
        }}
      >
        <Field>
          <FieldLabel htmlFor="operator-end-date">{t("form.date")}</FieldLabel>
          <Input id="operator-end-date" name="toOn" inputMode="numeric" defaultValue={today} />
        </Field>
      </FormDialog>
    </>
  );
}
