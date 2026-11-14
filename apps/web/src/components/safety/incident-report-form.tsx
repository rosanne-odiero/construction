"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import {
  BODY_PARTS,
  INCIDENT_KINDS,
  INCIDENT_PERSON_ROLES,
  INCIDENT_SEVERITIES,
  INJURY_TYPES,
  type BodyPart,
  type IncidentKind,
  type IncidentPersonRole,
  type InjuryType,
} from "@pm-buddy/types";
import {
  incidentDetailResponseSchema,
  reportIncidentRequestSchema,
  type QualityPhoto,
  type SafetyLabourer,
  type SafetyOptionsResponse,
  type Site,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { PhotoThumbs, PhotoUpload } from "@/components/quality/photos";
import { FormError, selectClass } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { nairobiMoment } from "@/lib/safety";
import { checkboxClass, field } from "./common";
import { LabourerPicker } from "./labourer-picker";

type PersonMode = "labourer" | "staff" | "name";
export type PersonDraft = {
  key: number;
  role: IncidentPersonRole;
  mode: PersonMode;
  labourer: SafetyLabourer | null;
  userId: string;
  name: string;
  injuryType: InjuryType | "";
  bodyPart: BodyPart | "";
};

/** A person row as the API expects it (one reference; injury codes for the injured only). */
export function personInput(person: PersonDraft) {
  return {
    role: person.role,
    ...(person.mode === "labourer" && person.labourer ? { labourerId: person.labourer.id } : {}),
    ...(person.mode === "staff" && person.userId ? { userId: person.userId } : {}),
    ...(person.mode === "name" ? { name: person.name } : {}),
    ...(person.role === "injured"
      ? {
          ...(person.injuryType ? { injuryType: person.injuryType } : {}),
          ...(person.bodyPart ? { bodyPart: person.bodyPart } : {}),
        }
      : {}),
  };
}

/** The people section: injured, involved and witnesses, each a labourer, staff member or name. */
export function PeopleEditor({
  projectId,
  siteId,
  staff,
  people,
  onChange,
  disabled,
}: {
  projectId: string;
  siteId: string;
  staff: SafetyOptionsResponse["staff"];
  people: PersonDraft[];
  onChange: (people: PersonDraft[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("safety");
  const next = useRef(people.length + 1);
  const update = (key: number, change: Partial<PersonDraft>) =>
    onChange(people.map((person) => (person.key === key ? { ...person, ...change } : person)));
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t("report.people")}</legend>
      <p className="text-sm text-muted-foreground">{t("report.peopleHint")}</p>
      {people.map((person, index) => (
        <div
          key={person.key}
          role="group"
          aria-label={t("report.personLabel", { index: index + 1 })}
          className="space-y-3 rounded-md bg-muted/40 p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`person-role-${person.key}`}>{t("report.role")}</FieldLabel>
                <select
                  id={`person-role-${person.key}`}
                  value={person.role}
                  disabled={disabled}
                  className={selectClass}
                  onChange={(event) =>
                    update(person.key, { role: event.currentTarget.value as IncidentPersonRole })
                  }
                >
                  {INCIDENT_PERSON_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {t(`personRole.${role}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`person-mode-${person.key}`}>
                  {t("report.reference")}
                </FieldLabel>
                <select
                  id={`person-mode-${person.key}`}
                  value={person.mode}
                  disabled={disabled}
                  className={selectClass}
                  onChange={(event) =>
                    update(person.key, {
                      mode: event.currentTarget.value as PersonMode,
                      labourer: null,
                      userId: "",
                      name: "",
                    })
                  }
                >
                  <option value="labourer">{t("report.byLabourer")}</option>
                  <option value="staff">{t("report.byStaff")}</option>
                  <option value="name">{t("report.byName")}</option>
                </select>
              </Field>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled}
              aria-label={t("report.removePerson", { index: index + 1 })}
              onClick={() => onChange(people.filter((entry) => entry.key !== person.key))}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          {person.mode === "labourer" ? (
            <LabourerPicker
              projectId={projectId}
              siteId={siteId}
              value={person.labourer}
              disabled={disabled}
              onChange={(labourer) => update(person.key, { labourer })}
            />
          ) : person.mode === "staff" ? (
            <Field>
              <FieldLabel htmlFor={`person-staff-${person.key}`}>{t("report.staff")}</FieldLabel>
              <select
                id={`person-staff-${person.key}`}
                value={person.userId}
                disabled={disabled}
                className={selectClass}
                onChange={(event) => update(person.key, { userId: event.currentTarget.value })}
              >
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
              <FieldLabel htmlFor={`person-name-${person.key}`}>{t("report.name")}</FieldLabel>
              <Input
                id={`person-name-${person.key}`}
                value={person.name}
                maxLength={120}
                disabled={disabled}
                onChange={(event) => update(person.key, { name: event.currentTarget.value })}
              />
            </Field>
          )}
          {person.role === "injured" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`person-injury-${person.key}`}>
                  {t("report.injuryType")}
                </FieldLabel>
                <select
                  id={`person-injury-${person.key}`}
                  value={person.injuryType}
                  disabled={disabled}
                  className={selectClass}
                  onChange={(event) =>
                    update(person.key, { injuryType: event.currentTarget.value as InjuryType })
                  }
                >
                  <option value="">—</option>
                  {INJURY_TYPES.map((injury) => (
                    <option key={injury} value={injury}>
                      {t(`injuryType.${injury}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`person-body-${person.key}`}>
                  {t("report.bodyPart")}
                </FieldLabel>
                <select
                  id={`person-body-${person.key}`}
                  value={person.bodyPart}
                  disabled={disabled}
                  className={selectClass}
                  onChange={(event) =>
                    update(person.key, { bodyPart: event.currentTarget.value as BodyPart })
                  }
                >
                  <option value="">—</option>
                  {BODY_PARTS.map((part) => (
                    <option key={part} value={part}>
                      {t(`bodyPart.${part}`)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || people.length >= 20}
        onClick={() => {
          onChange([
            ...people,
            {
              key: next.current++,
              role: people.length ? "witness" : "injured",
              mode: "labourer",
              labourer: null,
              userId: "",
              name: "",
              injuryType: "",
              bodyPart: "",
            },
          ]);
        }}
      >
        <Plus className="size-4" aria-hidden />
        {t("report.addPerson")}
      </Button>
    </fieldset>
  );
}

/**
 * Reports an incident or near miss from a phone on site (D8.2): what, how bad, when (Nairobi
 * time), where, what happened, immediate actions, first aid, people and photos.
 */
export function IncidentReportForm({
  projectId,
  sites,
  staff,
  today,
  now,
  followUp,
}: {
  projectId: string;
  sites: Site[];
  staff: SafetyOptionsResponse["staff"];
  /** DD/MM/YYYY and HH:MM in Nairobi when the page was rendered. */
  today: string;
  now: string;
  followUp: { id: string; code: string } | null;
}) {
  const t = useTranslations("safety");
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [kind, setKind] = useState<IncidentKind>("near_miss");
  const [people, setPeople] = useState<PersonDraft[]>([]);
  const [photos, setPhotos] = useState<QualityPhoto[]>([]);

  async function submit(form: FormData) {
    const occurredAt = nairobiMoment(field(form, "date"), field(form, "time"));
    const parsed = reportIncidentRequestSchema.safeParse({
      siteId,
      kind,
      severity: form.get("severity"),
      occurredAt,
      location: field(form, "location"),
      description: field(form, "description"),
      immediateActions: field(form, "immediateActions"),
      firstAidGiven: form.get("firstAidGiven") === "on",
      people: people.map(personInput),
      photoIds: photos.map((photo) => photo.id),
      ...(followUp ? { followUpOfId: followUp.id } : {}),
    });
    // The incident's own fields first, then the people (their issues all sit under `people`).
    const fieldsValid =
      parsed.success || parsed.error.issues.every((issue) => issue.path[0] === "people");
    if (!fieldsValid || !occurredAt || new Date(occurredAt).getTime() > Date.now() + 300_000) {
      setError(t("report.invalid"));
      return;
    }
    if (people.some((person) => !personComplete(person))) {
      setError(t("report.personInvalid"));
      return;
    }
    const injured = people.some((person) => person.role === "injured");
    if (kind === "injury" && !injured) {
      setError(t("report.injuredRequired"));
      return;
    }
    if (kind === "near_miss" && injured) {
      setError(t("report.nearMissNoInjury"));
      return;
    }
    if (!parsed.success) {
      setError(t("report.personInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { incident } = await liveRequest(
        `/projects/${projectId}/safety/incidents`,
        incidentDetailResponseSchema,
        { method: "POST", body: parsed.data },
      );
      router.push(`/projects/${projectId}/safety/incidents/${incident.id}`);
    } catch (caught) {
      setError(problem(caught));
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="max-w-2xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(new FormData(event.currentTarget));
      }}
    >
      {followUp ? (
        <p className="text-sm font-medium">{t("report.followUpOf", { code: followUp.code })}</p>
      ) : null}
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="report-site">{t("filters.site")}</FieldLabel>
          <select
            id="report-site"
            value={siteId}
            disabled={busy}
            className={selectClass}
            onChange={(event) => {
              setSiteId(event.currentTarget.value);
              setPhotos([]);
              setPeople((current) => current.map((person) => ({ ...person, labourer: null })));
            }}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="report-kind">{t("report.kind")}</FieldLabel>
          <select
            id="report-kind"
            value={kind}
            disabled={busy}
            className={selectClass}
            onChange={(event) => setKind(event.currentTarget.value as IncidentKind)}
          >
            {INCIDENT_KINDS.map((option) => (
              <option key={option} value={option}>
                {t(`kind.${option}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="report-severity">{t("report.severity")}</FieldLabel>
        <select
          id="report-severity"
          name="severity"
          defaultValue="minor"
          disabled={busy}
          className={selectClass}
          aria-describedby={kind === "near_miss" ? "report-severity-hint" : undefined}
        >
          {INCIDENT_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {t(`severity.${severity}`)} — {t(`severityHint.${severity}`)}
            </option>
          ))}
        </select>
        {kind === "near_miss" ? (
          <p id="report-severity-hint" className="text-sm text-muted-foreground">
            {t("report.severityNearMiss")}
          </p>
        ) : null}
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="report-date">{t("report.date")}</FieldLabel>
          <Input
            id="report-date"
            name="date"
            inputMode="numeric"
            defaultValue={today}
            disabled={busy}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="report-time">{t("report.time")}</FieldLabel>
          <Input
            id="report-time"
            name="time"
            inputMode="numeric"
            defaultValue={now}
            disabled={busy}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="report-location">{t("report.location")}</FieldLabel>
        <Input id="report-location" name="location" maxLength={200} disabled={busy} required />
      </Field>
      <Field>
        <FieldLabel htmlFor="report-description">{t("report.description")}</FieldLabel>
        <Textarea
          id="report-description"
          name="description"
          maxLength={2000}
          disabled={busy}
          aria-describedby="report-description-hint"
          required
        />
        <p id="report-description-hint" className="text-sm text-muted-foreground">
          {t("report.descriptionHint")}
        </p>
      </Field>
      <Field>
        <FieldLabel htmlFor="report-immediate">{t("report.immediateActions")}</FieldLabel>
        <Textarea id="report-immediate" name="immediateActions" maxLength={2000} disabled={busy} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="firstAidGiven" className={checkboxClass} disabled={busy} />
        {t("report.firstAidGiven")}
      </label>
      <PeopleEditor
        projectId={projectId}
        siteId={siteId}
        staff={staff}
        people={people}
        onChange={setPeople}
        disabled={busy}
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("report.photos")}</p>
        <PhotoThumbs
          projectId={projectId}
          photos={photos}
          label={t("report.photos")}
          disabled={busy}
          onRemove={(photoId) =>
            setPhotos((current) => current.filter((photo) => photo.id !== photoId))
          }
        />
        {siteId && photos.length < 6 ? (
          <PhotoUpload
            projectId={projectId}
            siteId={siteId}
            caption={t("report.photoCaption")}
            label={t("report.addPhoto")}
            disabled={busy}
            onUploaded={(photo) => setPhotos((current) => [...current, photo])}
          />
        ) : null}
      </div>
      <Button type="submit" disabled={busy || !siteId} className="w-full sm:w-auto">
        {t("report.submit")}
      </Button>
    </form>
  );
}

/** Whether a person row names someone and, if injured, has both injury codes. */
export function personComplete(person: PersonDraft): boolean {
  const named =
    person.mode === "labourer"
      ? person.labourer !== null
      : person.mode === "staff"
        ? person.userId !== ""
        : Array.from(person.name.trim()).length >= 2;
  return (
    named && (person.role !== "injured" || (person.injuryType !== "" && person.bodyPart !== ""))
  );
}
