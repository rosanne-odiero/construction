"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Lock, Plus } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import {
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  ROOT_CAUSE_CATEGORIES,
  type IncidentKind,
} from "@pm-buddy/types";
import {
  addIncidentPhotosRequestSchema,
  closeIncidentRequestSchema,
  incidentDetailResponseSchema,
  investigateIncidentRequestSchema,
  regulatorDecisionRequestSchema,
  updateIncidentRequestSchema,
  voidRequestSchema,
  type IncidentDetailResponse,
  type SafetyOptionsResponse,
} from "@pm-buddy/validation";
import { PhotoThumbs, PhotoUpload } from "@/components/quality/photos";
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
import { formatCalendarDate, formatDate, formatDateTime, formatTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseCalendarInput } from "@/lib/project-input";
import { regulatorTone } from "@/lib/safety";
import { ActionCard, RaiseActionDialog } from "./action-card";
import { checkboxClass, field, ReasonDialog } from "./common";
import {
  PeopleEditor,
  personComplete,
  personInput,
  type PersonDraft,
} from "./incident-report-form";

type Mode = "investigate" | "regulator" | "close" | "void" | "edit" | "raise";

/**
 * One incident (D8.2): details, people (safety managers only), photos, the investigation, the
 * regulator decision, corrective actions and first-aid treatments, and closing. A closed incident
 * is read-only (the database refuses any change).
 */
export function IncidentDetail({
  projectId,
  detail,
  staff,
}: {
  projectId: string;
  detail: IncidentDetailResponse;
  staff: SafetyOptionsResponse["staff"];
}) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();
  const [mode, setMode] = useState<Mode | null>(null);
  const [decision, setDecision] = useState<"notified" | "not_notifiable">("notified");
  const [people, setPeople] = useState<PersonDraft[]>([]);
  const { incident } = detail;
  const { permissions } = incident;
  const path = `/projects/${projectId}/safety/incidents/${incident.id}`;
  const open = (next: Mode) => {
    setError(null);
    if (next === "edit")
      setPeople(
        (incident.people ?? []).map((person, index) => ({
          key: index + 1,
          role: person.role,
          mode: person.labourer ? "labourer" : person.staff ? "staff" : "name",
          labourer: person.labourer,
          userId: person.staff?.id ?? "",
          name: person.name ?? "",
          injuryType: person.injuryType ?? "",
          bodyPart: person.bodyPart ?? "",
        })),
      );
    setMode(next);
  };
  const send = (suffix: string, method: "POST" | "PATCH", body: Record<string, unknown>) =>
    void run(
      () => liveRequest(`${path}${suffix}`, incidentDetailResponseSchema, { method, body }),
      () => setMode(null),
    );

  function submit(form: FormData) {
    if (mode === "investigate") {
      const parsed = investigateIncidentRequestSchema.safeParse({
        version: incident.version,
        rootCauseCategory: form.get("rootCauseCategory"),
        rootCause: field(form, "rootCause"),
        contributingFactors: field(form, "contributingFactors"),
      });
      if (!parsed.success) return setError(t("detail.investigationInvalid"));
      return send("/investigation", "POST", parsed.data);
    }
    if (mode === "regulator") {
      const notifiedOn = parseCalendarInput(field(form, "notifiedOn"));
      const reference = field(form, "reference");
      const parsed = regulatorDecisionRequestSchema.safeParse(
        decision === "notified"
          ? {
              version: incident.version,
              decision,
              notifiedOn: notifiedOn ?? undefined,
              ...(reference ? { reference } : {}),
            }
          : { version: incident.version, decision, reason: field(form, "reason") },
      );
      if (!parsed.success || (typeof notifiedOn === "string" && notifiedOn > nairobiDate()))
        return setError(t("detail.decisionInvalid"));
      return send("/regulator", "POST", parsed.data);
    }
    if (mode === "close") {
      const parsed = closeIncidentRequestSchema.safeParse({
        version: incident.version,
        closureNote: field(form, "closureNote"),
        noActionReason: field(form, "noActionReason"),
      });
      const needsReason = incident.closeBlockers.includes("no_verified_action");
      if (!parsed.success || (needsReason && (parsed.data.noActionReason?.length ?? 0) < 3))
        return setError(t("detail.closeInvalid"));
      return send("/close", "POST", parsed.data);
    }
    if (mode === "edit") {
      if (people.some((person) => !personComplete(person)))
        return setError(t("report.personInvalid"));
      const kind = form.get("kind") as IncidentKind;
      const injured = people.some((person) => person.role === "injured");
      if (kind === "injury" && !injured) return setError(t("report.injuredRequired"));
      if (kind === "near_miss" && injured) return setError(t("report.nearMissNoInjury"));
      const parsed = updateIncidentRequestSchema.safeParse({
        version: incident.version,
        kind,
        severity: form.get("severity"),
        location: field(form, "location"),
        description: field(form, "description"),
        immediateActions: field(form, "immediateActions"),
        firstAidGiven: form.get("firstAidGiven") === "on",
        ...(permissions.canSeePeople ? { people: people.map(personInput) } : {}),
      });
      if (!parsed.success) return setError(t("report.invalid"));
      return send("", "PATCH", parsed.data);
    }
  }

  const locked = incident.status === "closed";
  return (
    <div className="space-y-6">
      {locked ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted p-3 text-sm"
        >
          <Lock className="size-4" aria-hidden />
          {t("detail.locked")}
          <Link
            className="underline"
            href={`/projects/${projectId}/safety/incidents/new?followUp=${incident.id}`}
          >
            {t("detail.reportFollowUp")}
          </Link>
        </p>
      ) : null}
      {incident.status === "voided" && incident.voidReason ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm break-words">
          {t("detail.voided", { reason: incident.voidReason })}
        </p>
      ) : null}
      <dl className="grid grid-cols-1 gap-3 rounded-md border p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("detail.occurred")}</dt>
          <dd>
            {t("incidents.occurred", {
              date: formatDate(incident.occurredAt),
              time: formatTime(incident.occurredAt),
            })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.where")}</dt>
          <dd className="break-words">
            {incident.location} · {incident.siteName}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.firstAid")}</dt>
          <dd>{incident.firstAidGiven ? t("detail.firstAidYes") : t("detail.firstAidNo")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("incidentStatus.reported")}</dt>
          <dd>
            {t("detail.reportedBy", {
              name: incident.reportedBy.displayName,
              at: formatDateTime(incident.reportedAt),
            })}
          </dd>
        </div>
      </dl>
      <p className="text-sm break-words whitespace-pre-wrap">{incident.description}</p>
      {incident.immediateActions ? (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("detail.immediateActions")}</h2>
          <p className="text-sm break-words whitespace-pre-wrap">{incident.immediateActions}</p>
        </div>
      ) : null}
      {permissions.canEdit || permissions.canVoid ? (
        <div className="flex flex-wrap gap-2">
          {permissions.canEdit ? (
            <Button variant="outline" size="sm" onClick={() => open("edit")}>
              {t("detail.edit")}
            </Button>
          ) : null}
          {permissions.canVoid ? (
            <Button variant="outline" size="sm" onClick={() => open("void")}>
              {t("detail.void")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="incident-people" className="space-y-2">
        <h2 id="incident-people" className="text-base font-semibold">
          {t("detail.people")}
        </h2>
        {incident.people ? (
          incident.people.length ? (
            <ul className="space-y-1 text-sm">
              {incident.people.map((person) => (
                <li key={person.id} className="break-words">
                  <span className="font-medium">{t(`personRole.${person.role}`)}:</span>{" "}
                  {person.labourer
                    ? `${person.labourer.fullName} (${person.labourer.workerNo})`
                    : (person.staff?.displayName ?? person.name)}
                  {person.injuryType && person.bodyPart
                    ? ` — ${t(`injuryType.${person.injuryType}`)}, ${t(`bodyPart.${person.bodyPart}`)}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("detail.noPeople")}</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("detail.peopleRestricted", {
              injured: incident.peopleCounts.injured,
              involved: incident.peopleCounts.involved,
              witnesses: incident.peopleCounts.witness,
            })}
          </p>
        )}
      </section>

      <section aria-labelledby="incident-photos" className="space-y-2">
        <h2 id="incident-photos" className="text-base font-semibold">
          {t("detail.photos")}
        </h2>
        {incident.photos.length ? (
          <PhotoThumbs projectId={projectId} photos={incident.photos} label={t("detail.photos")} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noPhotos")}</p>
        )}
        {permissions.canAddPhotos ? (
          <PhotoUpload
            projectId={projectId}
            siteId={incident.siteId}
            caption={t("report.photoCaption")}
            label={t("detail.addPhotos")}
            disabled={busy}
            onUploaded={(photo) => {
              const parsed = addIncidentPhotosRequestSchema.parse({
                version: incident.version,
                photoIds: [photo.id],
              });
              send("/photos", "POST", parsed);
            }}
          />
        ) : null}
        {mode === null ? <FormError message={error} /> : null}
      </section>

      <section aria-labelledby="incident-investigation" className="space-y-2">
        <h2 id="incident-investigation" className="text-base font-semibold">
          {t("detail.investigation")}
        </h2>
        {incident.investigation ? (
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">{t("detail.rootCauseCategory")}:</span>{" "}
              {t(`rootCause.${incident.investigation.rootCauseCategory}`)}
            </p>
            <p className="break-words whitespace-pre-wrap">{incident.investigation.rootCause}</p>
            {incident.investigation.contributingFactors ? (
              <p className="break-words whitespace-pre-wrap text-muted-foreground">
                {incident.investigation.contributingFactors}
              </p>
            ) : null}
            <p className="text-muted-foreground">
              {t("detail.investigatedBy", {
                name: incident.investigation.investigatedBy.displayName,
                at: formatDateTime(incident.investigation.investigatedAt),
              })}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noInvestigation")}</p>
        )}
        {permissions.canInvestigate ? (
          <Button size="sm" onClick={() => open("investigate")}>
            {incident.investigation ? t("detail.revise") : t("detail.investigate")}
          </Button>
        ) : null}
      </section>

      <section aria-labelledby="incident-regulator" className="space-y-2">
        <h2 id="incident-regulator" className="text-base font-semibold">
          {t("detail.regulator")}
        </h2>
        <StatusBadge
          tone={regulatorTone[incident.regulator.state]}
          className="h-auto max-w-full whitespace-normal text-left"
        >
          {t(`regulatorState.${incident.regulator.state}`)}
        </StatusBadge>
        {incident.regulator.notifiedOn ? (
          <p className="text-sm break-words">
            {t("detail.notifiedDetail", {
              date: formatCalendarDate(incident.regulator.notifiedOn),
              reference: incident.regulator.reference ?? "none",
            })}
          </p>
        ) : null}
        {incident.regulator.reason ? (
          <p className="text-sm break-words">{incident.regulator.reason}</p>
        ) : null}
        {incident.regulator.decidedBy && incident.regulator.decidedAt ? (
          <p className="text-sm text-muted-foreground">
            {t("detail.decidedBy", {
              name: incident.regulator.decidedBy.displayName,
              at: formatDateTime(incident.regulator.decidedAt),
            })}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{t("detail.regulatorHint")}</p>
        {permissions.canDecideRegulator ? (
          <Button size="sm" variant="outline" onClick={() => open("regulator")}>
            {t("detail.recordDecision")}
          </Button>
        ) : null}
      </section>

      <section aria-labelledby="incident-actions" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="incident-actions" className="text-base font-semibold">
            {t("detail.actions")}
          </h2>
          {permissions.canRaiseAction ? (
            <Button size="sm" onClick={() => open("raise")}>
              <Plus className="size-4" aria-hidden />
              {t("detail.raiseAction")}
            </Button>
          ) : null}
        </div>
        {detail.correctiveActions.length ? (
          <ul className="space-y-3">
            {detail.correctiveActions.map((action) => (
              <li key={action.id}>
                <ActionCard
                  projectId={projectId}
                  action={action}
                  staff={staff}
                  showSource={false}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noActions")}</p>
        )}
      </section>

      {detail.treatments.length ? (
        <section aria-labelledby="incident-treatments" className="space-y-2">
          <h2 id="incident-treatments" className="text-base font-semibold">
            {t("detail.treatments")}
          </h2>
          <ul className="space-y-1 text-sm">
            {detail.treatments.map((treatment) => (
              <li key={treatment.id} className="break-words">
                <span className="font-mono">{treatment.code}</span> ·{" "}
                {formatDateTime(treatment.treatedAt)} ·{" "}
                {treatment.restricted
                  ? t("firstAid.restricted")
                  : `${treatment.labourer?.fullName ?? treatment.personName ?? ""} — ${
                      treatment.injuryType ? t(`injuryType.${treatment.injuryType}`) : ""
                    }, ${treatment.treatment ? t(`treatment.${treatment.treatment}`) : ""}`}{" "}
                · {t(`referral.${treatment.referral}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {incident.status === "reported" || incident.status === "investigated" ? (
        <section aria-labelledby="incident-close" className="space-y-2 rounded-md border p-4">
          <h2 id="incident-close" className="text-base font-semibold">
            {t("detail.blockers")}
          </h2>
          {incident.closeBlockers.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {incident.closeBlockers.map((blocker) => (
                <li key={blocker}>{t(`blocker.${blocker}`)}</li>
              ))}
            </ul>
          ) : null}
          {permissions.canClose ? (
            <Button onClick={() => open("close")}>{t("detail.close")}</Button>
          ) : null}
        </section>
      ) : null}
      {incident.closedBy && incident.closedAt ? (
        <p className="text-sm break-words">
          {t("detail.closedBy", {
            name: incident.closedBy.displayName,
            at: formatDateTime(incident.closedAt),
          })}
          {incident.closureNote ? ` — ${incident.closureNote}` : ""}
          {incident.noActionReason ? ` — ${incident.noActionReason}` : ""}
        </p>
      ) : null}

      <RaiseActionDialog
        projectId={projectId}
        staff={staff}
        source={{ kind: "incident", id: incident.id }}
        open={mode === "raise"}
        onOpenChange={(next) => setMode(next ? "raise" : null)}
      />
      <ReasonDialog
        open={mode === "void"}
        title={t("detail.voidTitle")}
        hint={t("detail.voidHint")}
        busy={busy}
        error={error}
        onOpenChange={(next) => setMode(next ? "void" : null)}
        onSubmit={(reason) => {
          const parsed = voidRequestSchema.safeParse({ version: incident.version, reason });
          if (!parsed.success) return setError(t("actions.reasonInvalid"));
          send("/void", "POST", parsed.data);
        }}
      />
      <Dialog
        open={mode === "investigate" || mode === "regulator" || mode === "close" || mode === "edit"}
        onOpenChange={(next) => {
          if (!busy && !next) setMode(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mode === "investigate"
                ? incident.investigation
                  ? t("detail.revise")
                  : t("detail.investigate")
                : mode === "regulator"
                  ? t("detail.regulator")
                  : mode === "close"
                    ? t("detail.closeTitle")
                    : t("detail.editTitle")}
            </DialogTitle>
            <DialogDescription>
              {mode === "regulator"
                ? t("detail.regulatorHint")
                : mode === "close"
                  ? t("detail.closeHint")
                  : `${incident.code} · ${incident.location}`}
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
            {mode === "investigate" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="investigation-category">
                    {t("detail.rootCauseCategory")}
                  </FieldLabel>
                  <select
                    id="investigation-category"
                    name="rootCauseCategory"
                    defaultValue={incident.investigation?.rootCauseCategory ?? "unsafe_condition"}
                    className={selectClass}
                  >
                    {ROOT_CAUSE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {t(`rootCause.${category}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="investigation-root">{t("detail.rootCause")}</FieldLabel>
                  <Textarea
                    id="investigation-root"
                    name="rootCause"
                    maxLength={2000}
                    defaultValue={incident.investigation?.rootCause}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="investigation-factors">
                    {t("detail.contributing")}
                  </FieldLabel>
                  <Textarea
                    id="investigation-factors"
                    name="contributingFactors"
                    maxLength={2000}
                    defaultValue={incident.investigation?.contributingFactors ?? ""}
                  />
                </Field>
              </>
            ) : null}
            {mode === "regulator" ? (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t("detail.decision")}</legend>
                  {(["notified", "not_notifiable"] as const).map((option) => (
                    <label key={option} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="decision"
                        value={option}
                        checked={decision === option}
                        onChange={() => setDecision(option)}
                        className={checkboxClass}
                      />
                      {option === "notified" ? t("detail.notified") : t("detail.notNotifiable")}
                    </label>
                  ))}
                </fieldset>
                {decision === "notified" ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="regulator-date">{t("detail.notifiedOn")}</FieldLabel>
                      <Input
                        id="regulator-date"
                        name="notifiedOn"
                        inputMode="numeric"
                        placeholder="DD/MM/YYYY"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="regulator-reference">{t("detail.reference")}</FieldLabel>
                      <Input id="regulator-reference" name="reference" maxLength={60} />
                    </Field>
                  </div>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="regulator-reason">{t("detail.decisionReason")}</FieldLabel>
                    <Textarea id="regulator-reason" name="reason" maxLength={500} />
                  </Field>
                )}
              </>
            ) : null}
            {mode === "close" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="close-note">{t("detail.closureNote")}</FieldLabel>
                  <Textarea id="close-note" name="closureNote" maxLength={1000} />
                </Field>
                {incident.closeBlockers.includes("no_verified_action") ? (
                  <Field>
                    <FieldLabel htmlFor="close-reason">{t("detail.noActionReason")}</FieldLabel>
                    <Textarea id="close-reason" name="noActionReason" maxLength={500} />
                  </Field>
                ) : null}
              </>
            ) : null}
            {mode === "edit" ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="edit-kind">{t("report.kind")}</FieldLabel>
                    <select
                      id="edit-kind"
                      name="kind"
                      defaultValue={incident.kind}
                      className={selectClass}
                    >
                      {INCIDENT_KINDS.map((option) => (
                        <option key={option} value={option}>
                          {t(`kind.${option}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="edit-severity">{t("report.severity")}</FieldLabel>
                    <select
                      id="edit-severity"
                      name="severity"
                      defaultValue={incident.severity}
                      className={selectClass}
                    >
                      {INCIDENT_SEVERITIES.map((severity) => (
                        <option key={severity} value={severity}>
                          {t(`severity.${severity}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="edit-location">{t("report.location")}</FieldLabel>
                  <Input
                    id="edit-location"
                    name="location"
                    maxLength={200}
                    defaultValue={incident.location}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="edit-description">{t("report.description")}</FieldLabel>
                  <Textarea
                    id="edit-description"
                    name="description"
                    maxLength={2000}
                    defaultValue={incident.description}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="edit-immediate">{t("report.immediateActions")}</FieldLabel>
                  <Textarea
                    id="edit-immediate"
                    name="immediateActions"
                    maxLength={2000}
                    defaultValue={incident.immediateActions ?? ""}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="firstAidGiven"
                    defaultChecked={incident.firstAidGiven}
                    className={checkboxClass}
                  />
                  {t("report.firstAidGiven")}
                </label>
                {permissions.canSeePeople ? (
                  <PeopleEditor
                    projectId={projectId}
                    siteId={incident.siteId}
                    staff={staff}
                    people={people}
                    onChange={setPeople}
                    disabled={busy}
                  />
                ) : null}
              </>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setMode(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {mode === "close" ? t("detail.close") : t("actions.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
