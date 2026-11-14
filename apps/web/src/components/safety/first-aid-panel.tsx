"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { Plus } from "lucide-react";
import {
  FIRST_AID_REFERRALS,
  FIRST_AID_TREATMENTS,
  INJURY_TYPES,
  KIT_CHECK_OUTCOMES,
} from "@pm-buddy/types";
import {
  addFirstAiderRequestSchema,
  createFirstAidKitRequestSchema,
  firstAiderResponseSchema,
  firstAidKitResponseSchema,
  linkTreatmentRequestSchema,
  recordKitCheckRequestSchema,
  recordTreatmentRequestSchema,
  treatmentResponseSchema,
  voidRequestSchema,
  type FirstAider,
  type FirstAidKit,
  type FirstAidResponse,
  type SafetyLabourer,
  type SafetyOptionsResponse,
  type Site,
  type Treatment,
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseCalendarInput } from "@/lib/project-input";
import { certificateTone, kitStateTone, nairobiMoment, safetyHref } from "@/lib/safety";
import { field, Pager, ReasonDialog } from "./common";
import { LabourerPicker } from "./labourer-picker";

type Mode =
  | { kind: "kit" }
  | { kind: "check"; kit: FirstAidKit }
  | { kind: "retire"; kit: FirstAidKit }
  | { kind: "aider" }
  | { kind: "remove"; aider: FirstAider }
  | { kind: "treatment" }
  | { kind: "void"; treatment: Treatment }
  | { kind: "link"; treatment: Treatment };

const aiderName = (aider: FirstAider) =>
  aider.labourer?.fullName ?? aider.staff?.displayName ?? "—";

/** First aid on a project (D8.2): kits and their checks, first-aiders, treatments. */
export function FirstAidPanel({
  projectId,
  data,
  sites,
  staff,
  openIncidents,
  today,
  now,
  cursor,
}: {
  projectId: string;
  data: FirstAidResponse;
  sites: Site[];
  staff: SafetyOptionsResponse["staff"];
  openIncidents: { id: string; code: string; siteId: string }[];
  today: string;
  now: string;
  cursor?: string;
}) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<Mode | null>(null);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [labourer, setLabourer] = useState<SafetyLabourer | null>(null);
  const [personMode, setPersonMode] = useState<"labourer" | "other">("labourer");
  const { permissions } = data;
  const base = `/projects/${projectId}/safety/first-aid`;
  const todayIso = parseCalendarInput(today)!;
  const open = (next: Mode) => {
    setError(null);
    setLabourer(null);
    setPersonMode("labourer");
    setMode(next);
  };
  const post = (path: string, schema: z.ZodType<unknown>, body: Record<string, unknown>) =>
    void run(
      () => liveRequest(path, schema, { method: "POST", body }),
      () => setMode(null),
    );

  function submit(form: FormData) {
    if (!mode) return;
    if (mode.kind === "kit") {
      const parsed = createFirstAidKitRequestSchema.safeParse({
        siteId,
        label: field(form, "label"),
        location: field(form, "location"),
      });
      if (!parsed.success) return setError(t("firstAid.kitInvalid"));
      return post(`${base}/kits`, firstAidKitResponseSchema, parsed.data);
    }
    if (mode.kind === "check") {
      const checkedOn = parseCalendarInput(field(form, "checkedOn"));
      const expiresOn = parseCalendarInput(field(form, "expiresOn"));
      const parsed = recordKitCheckRequestSchema.safeParse({
        checkedOn,
        outcome: form.get("outcome"),
        expiresOn: expiresOn ?? null,
        notes: field(form, "notes"),
      });
      if (!parsed.success || !checkedOn || checkedOn > todayIso || expiresOn === undefined)
        return setError(t("firstAid.checkInvalid"));
      return post(`${base}/kits/${mode.kit.id}/checks`, firstAidKitResponseSchema, parsed.data);
    }
    if (mode.kind === "aider") {
      const expires = parseCalendarInput(field(form, "certificateExpiresOn"));
      const userId = field(form, "userId");
      const parsed = addFirstAiderRequestSchema.safeParse({
        siteId,
        ...(personMode === "labourer" ? { labourerId: labourer?.id } : { userId }),
        certificateExpiresOn: expires,
        certificateReference: field(form, "certificateReference"),
      });
      if (!parsed.success || !expires) return setError(t("firstAid.aiderInvalid"));
      return post(`${base}/first-aiders`, firstAiderResponseSchema, parsed.data);
    }
    if (mode.kind === "treatment") {
      const treatedAt = nairobiMoment(field(form, "date"), field(form, "time"));
      const firstAiderId = field(form, "firstAiderId");
      const incidentId = field(form, "incidentId");
      const parsed = recordTreatmentRequestSchema.safeParse({
        siteId,
        treatedAt,
        ...(personMode === "labourer"
          ? { labourerId: labourer?.id }
          : { personName: field(form, "personName") }),
        injuryType: form.get("injuryType"),
        treatment: form.get("treatment"),
        referral: form.get("referral"),
        ...(firstAiderId ? { firstAiderId } : {}),
        ...(incidentId ? { incidentId } : {}),
      });
      if (!parsed.success || !treatedAt || new Date(treatedAt).getTime() > Date.now() + 300_000)
        return setError(t("firstAid.treatmentInvalid"));
      return post(`${base}/treatments`, treatmentResponseSchema, parsed.data);
    }
    if (mode.kind === "link") {
      const parsed = linkTreatmentRequestSchema.safeParse({
        version: mode.treatment.version,
        incidentId: field(form, "incidentId"),
      });
      if (!parsed.success) return setError(t("firstAid.linkInvalid"));
      return post(
        `${base}/treatments/${mode.treatment.id}/link`,
        treatmentResponseSchema,
        parsed.data,
      );
    }
  }

  function reason(text: string) {
    if (!mode) return;
    const target =
      mode.kind === "retire"
        ? { path: `${base}/kits/${mode.kit.id}/retire`, version: mode.kit.version }
        : mode.kind === "remove"
          ? { path: `${base}/first-aiders/${mode.aider.id}/remove`, version: mode.aider.version }
          : mode.kind === "void"
            ? {
                path: `${base}/treatments/${mode.treatment.id}/void`,
                version: mode.treatment.version,
              }
            : null;
    if (!target) return;
    const parsed = voidRequestSchema.safeParse({ version: target.version, reason: text });
    if (!parsed.success) return setError(t("actions.reasonInvalid"));
    const schema =
      mode.kind === "retire"
        ? firstAidKitResponseSchema
        : mode.kind === "remove"
          ? firstAiderResponseSchema
          : treatmentResponseSchema;
    post(target.path, schema, parsed.data);
  }

  const siteAiders = data.firstAiders.filter((aider) => aider.siteId === siteId);
  const dialogTitle =
    mode?.kind === "kit"
      ? t("firstAid.addKit")
      : mode?.kind === "check"
        ? t("firstAid.checkTitle")
        : mode?.kind === "aider"
          ? t("firstAid.addAider")
          : mode?.kind === "treatment"
            ? t("firstAid.record")
            : t("firstAid.linkTitle");
  const siteSelect =
    mode?.kind === "kit" || mode?.kind === "aider" || mode?.kind === "treatment" ? (
      <Field>
        <FieldLabel htmlFor="first-aid-site">{t("filters.site")}</FieldLabel>
        <select
          id="first-aid-site"
          value={siteId}
          className={selectClass}
          onChange={(event) => {
            setSiteId(event.currentTarget.value);
            setLabourer(null);
          }}
        >
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </Field>
    ) : null;
  const personFields =
    mode?.kind === "aider" || mode?.kind === "treatment" ? (
      <>
        <Field>
          <FieldLabel htmlFor="first-aid-person">
            {mode.kind === "aider" ? t("firstAid.aiderKind") : t("firstAid.person")}
          </FieldLabel>
          <select
            id="first-aid-person"
            value={personMode}
            className={selectClass}
            onChange={(event) => setPersonMode(event.currentTarget.value as "labourer" | "other")}
          >
            <option value="labourer">{t("firstAid.byLabourer")}</option>
            <option value="other">
              {mode.kind === "aider" ? t("report.byStaff") : t("firstAid.byName")}
            </option>
          </select>
        </Field>
        {personMode === "labourer" ? (
          <LabourerPicker
            projectId={projectId}
            siteId={siteId}
            value={labourer}
            onChange={setLabourer}
          />
        ) : mode.kind === "aider" ? (
          <Field>
            <FieldLabel htmlFor="first-aid-staff">{t("report.staff")}</FieldLabel>
            <select id="first-aid-staff" name="userId" defaultValue="" className={selectClass}>
              <option value="">—</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="first-aid-name">{t("firstAid.personName")}</FieldLabel>
            <Input id="first-aid-name" name="personName" maxLength={120} />
          </Field>
        )}
      </>
    ) : null;

  return (
    <div className="space-y-6">
      <ul className="flex flex-wrap gap-2" aria-label={t("firstAid.countsLabel")}>
        <li>
          <StatusBadge
            tone={data.counts.kitsAttention ? "warning" : "neutral"}
            className="h-auto whitespace-normal"
          >
            {t("firstAid.countKits", { count: data.counts.kitsAttention })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge
            tone={data.counts.certificatesExpired ? "danger" : "neutral"}
            className="h-auto whitespace-normal"
          >
            {t("firstAid.countExpired", { count: data.counts.certificatesExpired })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="info" className="h-auto whitespace-normal">
            {t("firstAid.countTreatments", { count: data.counts.treatmentsLast30Days })}
          </StatusBadge>
        </li>
      </ul>

      <section aria-labelledby="kits-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="kits-heading" className="text-base font-semibold">
            {t("firstAid.kits")}
          </h3>
          {permissions.canManage && sites.length ? (
            <Button size="sm" onClick={() => open({ kind: "kit" })}>
              <Plus className="size-4" aria-hidden />
              {t("firstAid.addKit")}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("firstAid.kitsHint", { days: data.kitCheckIntervalDays })}
        </p>
        {data.kits.length ? (
          <ul className="space-y-2">
            {data.kits.map((kit) => (
              <li key={kit.id} className="space-y-1 rounded-md border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{kit.label}</span>
                  <StatusBadge tone={kitStateTone[kit.state]} className="h-auto whitespace-normal">
                    {t(`kitState.${kit.state}`)}
                  </StatusBadge>
                </p>
                <p className="break-words text-muted-foreground">
                  {kit.siteName}
                  {kit.location ? ` · ${kit.location}` : ""}
                </p>
                <p className="break-words">
                  {kit.lastCheck
                    ? t("firstAid.lastCheck", {
                        date: formatCalendarDate(kit.lastCheck.checkedOn),
                        name: kit.lastCheck.checkedBy.displayName,
                        outcome: t(`kitOutcome.${kit.lastCheck.outcome}`),
                      })
                    : t("firstAid.neverChecked")}
                  {kit.lastCheck?.expiresOn
                    ? ` · ${t("firstAid.expires", { date: formatCalendarDate(kit.lastCheck.expiresOn) })}`
                    : ""}
                  {kit.nextCheckOn
                    ? ` · ${t("firstAid.nextCheck", { date: formatCalendarDate(kit.nextCheckOn) })}`
                    : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {kit.permissions.canCheck ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-8 max-w-full whitespace-normal"
                      onClick={() => open({ kind: "check", kit })}
                    >
                      {t("firstAid.check", { label: kit.label })}
                    </Button>
                  ) : null}
                  {kit.permissions.canRetire ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-8 max-w-full whitespace-normal"
                      onClick={() => open({ kind: "retire", kit })}
                    >
                      {t("firstAid.retire", { label: kit.label })}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("firstAid.noKits")}</p>
        )}
      </section>

      <section aria-labelledby="aiders-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="aiders-heading" className="text-base font-semibold">
            {t("firstAid.aiders")}
          </h3>
          {permissions.canManage && sites.length ? (
            <Button size="sm" onClick={() => open({ kind: "aider" })}>
              <Plus className="size-4" aria-hidden />
              {t("firstAid.addAider")}
            </Button>
          ) : null}
        </div>
        {data.firstAiders.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {data.firstAiders.map((aider) => (
              <li key={aider.id} className="flex flex-wrap items-center gap-2 p-3">
                <span className="font-medium break-words">{aiderName(aider)}</span>
                <span className="text-muted-foreground">{aider.siteName}</span>
                <StatusBadge
                  tone={certificateTone[aider.certificateState]}
                  className="h-auto whitespace-normal"
                >
                  {t(`certificateState.${aider.certificateState}`)}
                </StatusBadge>
                <span className="text-muted-foreground">
                  {t("firstAid.certificate", {
                    date: formatCalendarDate(aider.certificateExpiresOn),
                  })}
                </span>
                {aider.permissions.canRemove ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-auto min-h-8 max-w-full whitespace-normal"
                    onClick={() => open({ kind: "remove", aider })}
                  >
                    {t("firstAid.remove", { name: aiderName(aider) })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("firstAid.noAiders")}</p>
        )}
      </section>

      <section aria-labelledby="treatments-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="treatments-heading" className="text-base font-semibold">
            {t("firstAid.treatments")}
          </h3>
          {permissions.canRecord && sites.length ? (
            <Button size="sm" onClick={() => open({ kind: "treatment" })}>
              <Plus className="size-4" aria-hidden />
              {t("firstAid.record")}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t("firstAid.treatmentsHint")}</p>
        {data.treatments.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {data.treatments.map((treatment) => (
              <li key={treatment.id} className="space-y-1 p-3">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{treatment.code}</span>
                  <span>{formatDateTime(treatment.treatedAt)}</span>
                  <span className="text-muted-foreground">{treatment.siteName}</span>
                  {treatment.status === "voided" ? (
                    <StatusBadge tone="neutral">{t("inductionStatus.voided")}</StatusBadge>
                  ) : null}
                </p>
                <p className="break-words">
                  {treatment.restricted
                    ? t("firstAid.restricted")
                    : `${treatment.labourer?.fullName ?? treatment.personName ?? ""} — ${
                        treatment.injuryType ? t(`injuryType.${treatment.injuryType}`) : ""
                      }, ${treatment.treatment ? t(`treatment.${treatment.treatment}`) : ""}`}{" "}
                  · {t(`referral.${treatment.referral}`)}
                  {treatment.firstAider
                    ? ` · ${t("firstAid.by", { name: treatment.firstAider.displayName })}`
                    : ""}
                  {treatment.incident
                    ? ` · ${t("firstAid.linkedTo", { code: treatment.incident.code })}`
                    : ""}
                </p>
                {treatment.voidReason ? (
                  <p className="break-words text-muted-foreground">{treatment.voidReason}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {treatment.permissions.canLink && openIncidents.length ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open({ kind: "link", treatment })}
                    >
                      {t("firstAid.link", { code: treatment.code })}
                    </Button>
                  ) : null}
                  {treatment.permissions.canVoid ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open({ kind: "void", treatment })}
                    >
                      {t("firstAid.void", { code: treatment.code })}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("firstAid.noTreatments")}</p>
        )}
        <Pager
          label={t("firstAid.pages")}
          firstHref={cursor ? safetyHref(projectId, "first-aid") : null}
          nextHref={
            data.nextCursor
              ? safetyHref(projectId, "first-aid", { cursor: String(data.nextCursor) })
              : null
          }
        />
      </section>

      <ReasonDialog
        open={mode?.kind === "retire" || mode?.kind === "remove" || mode?.kind === "void"}
        title={
          mode?.kind === "retire"
            ? t("firstAid.retireTitle")
            : mode?.kind === "remove"
              ? t("firstAid.removeTitle")
              : t("firstAid.voidTitle")
        }
        busy={busy}
        error={error}
        onOpenChange={(next) => {
          if (!next) setMode(null);
        }}
        onSubmit={reason}
      />
      <Dialog
        open={
          mode !== null && mode.kind !== "retire" && mode.kind !== "remove" && mode.kind !== "void"
        }
        onOpenChange={(next) => {
          if (!busy && !next) setMode(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {mode?.kind === "treatment"
                ? t("firstAid.recordHint")
                : mode?.kind === "check"
                  ? mode.kit.label
                  : mode?.kind === "aider"
                    ? t("firstAid.aiderHint")
                    : mode?.kind === "link"
                      ? mode.treatment.code
                      : t("firstAid.kitsHint", { days: data.kitCheckIntervalDays })}
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
            {siteSelect}
            {mode?.kind === "kit" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="kit-label">{t("firstAid.label")}</FieldLabel>
                  <Input id="kit-label" name="label" maxLength={80} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="kit-location">{t("firstAid.location")}</FieldLabel>
                  <Input id="kit-location" name="location" maxLength={200} />
                </Field>
              </>
            ) : null}
            {mode?.kind === "check" ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="check-date">{t("firstAid.checkedOn")}</FieldLabel>
                    <Input
                      id="check-date"
                      name="checkedOn"
                      inputMode="numeric"
                      defaultValue={today}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="check-outcome">{t("firstAid.outcome")}</FieldLabel>
                    <select
                      id="check-outcome"
                      name="outcome"
                      defaultValue="complete"
                      className={selectClass}
                    >
                      {KIT_CHECK_OUTCOMES.map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {t(`kitOutcome.${outcome}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="check-expires">{t("firstAid.expiresOn")}</FieldLabel>
                  <Input id="check-expires" name="expiresOn" inputMode="numeric" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="check-notes">{t("firstAid.checkNotes")}</FieldLabel>
                  <Textarea id="check-notes" name="notes" maxLength={500} />
                </Field>
              </>
            ) : null}
            {personFields}
            {mode?.kind === "aider" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="aider-expires">
                    {t("firstAid.certificateExpires")}
                  </FieldLabel>
                  <Input id="aider-expires" name="certificateExpiresOn" inputMode="numeric" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="aider-reference">
                    {t("firstAid.certificateReference")}
                  </FieldLabel>
                  <Input id="aider-reference" name="certificateReference" maxLength={60} />
                </Field>
              </div>
            ) : null}
            {mode?.kind === "treatment" ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="treatment-date">{t("firstAid.treatedOn")}</FieldLabel>
                    <Input
                      id="treatment-date"
                      name="date"
                      inputMode="numeric"
                      defaultValue={today}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="treatment-time">{t("firstAid.treatedAt")}</FieldLabel>
                    <Input id="treatment-time" name="time" inputMode="numeric" defaultValue={now} />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="treatment-injury">{t("firstAid.injuryType")}</FieldLabel>
                    <select
                      id="treatment-injury"
                      name="injuryType"
                      defaultValue="cut"
                      className={selectClass}
                    >
                      {INJURY_TYPES.map((injury) => (
                        <option key={injury} value={injury}>
                          {t(`injuryType.${injury}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="treatment-given">
                      {t("firstAid.treatmentLabel")}
                    </FieldLabel>
                    <select
                      id="treatment-given"
                      name="treatment"
                      defaultValue="cleaned_dressed"
                      className={selectClass}
                    >
                      {FIRST_AID_TREATMENTS.map((given) => (
                        <option key={given} value={given}>
                          {t(`treatment.${given}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="treatment-referral">{t("firstAid.referral")}</FieldLabel>
                    <select
                      id="treatment-referral"
                      name="referral"
                      defaultValue="none"
                      className={selectClass}
                    >
                      {FIRST_AID_REFERRALS.map((referral) => (
                        <option key={referral} value={referral}>
                          {t(`referral.${referral}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="treatment-aider">{t("firstAid.firstAider")}</FieldLabel>
                  <select
                    id="treatment-aider"
                    name="firstAiderId"
                    defaultValue=""
                    className={selectClass}
                  >
                    <option value="">—</option>
                    {siteAiders.map((aider) => (
                      <option key={aider.id} value={aider.id}>
                        {aiderName(aider)}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : null}
            {mode?.kind === "treatment" || mode?.kind === "link" ? (
              <Field>
                <FieldLabel htmlFor="treatment-incident">{t("firstAid.incident")}</FieldLabel>
                <select
                  id="treatment-incident"
                  name="incidentId"
                  defaultValue=""
                  className={selectClass}
                >
                  <option value="">{t("firstAid.noIncident")}</option>
                  {openIncidents.map((incident) => (
                    <option key={incident.id} value={incident.id}>
                      {incident.code}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setMode(null)}>
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
