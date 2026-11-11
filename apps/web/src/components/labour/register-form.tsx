"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CircleCheck, ShieldAlert } from "lucide-react";
import {
  addCalendarDays,
  isOldEnoughToRegister,
  latestAllowedBirthDate,
  normaliseIdNumber,
  normaliseKraPin,
  normaliseStatutoryNumber,
  normalizeKenyanPhone,
} from "@pm-buddy/domain";
import {
  ACCREDITATION_CATEGORIES,
  ENGAGEMENT_TYPES,
  GENDERS,
  ID_DOCUMENT_TYPES,
  KENYA_COUNTIES,
  RATE_BASES,
  type Locale,
} from "@pm-buddy/types";
import {
  labourerResponseSchema,
  registerLabourerRequestSchema,
  type LabourerWarning,
  type LabourSetupResponse,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FoundationApiError } from "@/lib/foundation-api";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { selectClass } from "./action-dialog";
import {
  ConsentCapture,
  consentComplete,
  useConsentCapture,
  type ConsentNotices,
} from "./consent-notice";
import { localName } from "./labour-badges";

type Values = {
  fullName: string;
  dateOfBirth: string;
  gender: string;
  homeCounty: string;
  idType: (typeof ID_DOCUMENT_TYPES)[number];
  idNumber: string;
  phone: string;
  kraPin: string;
  nssfNumber: string;
  shaNumber: string;
  kinName: string;
  kinRelationship: string;
  kinPhone: string;
  tradeId: string;
  skillLevelId: string;
  engagementType: (typeof ENGAGEMENT_TYPES)[number];
  rateBasis: (typeof RATE_BASES)[number];
  projectId: string;
  startDate: string;
  ncaCategory: (typeof ACCREDITATION_CATEGORIES)[number];
  ncaCard: string;
  ncaExpires: string;
};
type FieldName = keyof Values;
type Invalid =
  | "required"
  | "date"
  | "under18"
  | "idNumber"
  | "phone"
  | "kraPin"
  | "statutory"
  | "kin"
  | "futureDate"
  | "cardNumber";
type Match = { labourerId: string; workerNo: string; matchedOn: string };
type Registered = { id: string; workerNo: string; fullName: string; warnings: LabourerWarning[] };

const NO_PROJECT = "none";

const WARNING_KEYS = {
  "phone-shared": "phoneShared",
  "accreditation-missing": "accreditationMissing",
  "accreditation-expiring": "accreditationExpiring",
  "accreditation-expired": "accreditationExpired",
  "do-not-rehire-overridden": "doNotRehireOverridden",
} as const satisfies Record<LabourerWarning, string>;

/**
 * Registration (D3.1): consent first (EN/SW notice, signed or witnessed), then the worker's
 * details. Under-18s, duplicates and do-not-rehire matches are explained before anything is saved;
 * the API and the database apply the same rules again.
 */
export function RegisterForm({
  setup,
  companyWide,
  canOverride,
  company,
  today,
  notices,
  noticeVersion,
  initialLanguage,
}: {
  setup: LabourSetupResponse;
  companyWide: boolean;
  canOverride: boolean;
  company: string;
  today: string;
  notices: ConsentNotices;
  noticeVersion: string;
  initialLanguage: Locale;
}) {
  const t = useTranslations("labourLive.register");
  const tPanel = useTranslations("labourLive.panel");
  const tConsent = useTranslations("labourLive.consent");
  const locale = useLocale();
  const router = useRouter();
  const problem = useProblemMessage();
  const trades = setup.trades.filter((trade) => trade.active);
  const skillLevels = setup.skillLevels.filter((level) => level.active);
  const initial = (): Values => ({
    fullName: "",
    dateOfBirth: "",
    gender: "",
    homeCounty: "",
    idType: "national_id",
    idNumber: "",
    phone: "",
    kraPin: "",
    nssfNumber: "",
    shaNumber: "",
    kinName: "",
    kinRelationship: "",
    kinPhone: "",
    tradeId: "",
    skillLevelId: "",
    engagementType: "casual",
    rateBasis: "daily",
    projectId: setup.manageableProjects[0]?.id ?? NO_PROJECT,
    startDate: calendarInput(today),
    ncaCategory: "nca_skilled_worker",
    ncaCard: "",
    ncaExpires: "",
  });
  const [step, setStep] = useState<"consent" | "details">("consent");
  const [consent, setConsent] = useConsentCapture(initialLanguage);
  const [values, setValues] = useState<Values>(initial);
  const [invalid, setInvalid] = useState<Partial<Record<FieldName, Invalid>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [match, setMatch] = useState<{ code: string; match: Match } | null>(null);
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<Registered | null>(null);
  const oldest = latestAllowedBirthDate(today);

  const set = (name: FieldName) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [name]: event.target.value }));
    if (["idNumber", "idType", "phone", "kraPin"].includes(name)) setMatch(null);
  };

  function request(overrideReason?: string): Record<string, unknown> | null {
    const errors: Partial<Record<FieldName, Invalid>> = {};
    const text = (value: string) => value.trim();
    if (text(values.fullName).length < 3) errors.fullName = "required";
    const dateOfBirth = parseCalendarInput(values.dateOfBirth);
    if (!dateOfBirth) errors.dateOfBirth = "date";
    else if (!isOldEnoughToRegister(dateOfBirth, today)) errors.dateOfBirth = "under18";
    if (!values.gender) errors.gender = "required";
    if (!normaliseIdNumber(values.idType, values.idNumber)) errors.idNumber = "idNumber";
    if (text(values.phone) && !normalizeKenyanPhone(values.phone)) errors.phone = "phone";
    if (text(values.kraPin) && !normaliseKraPin(values.kraPin)) errors.kraPin = "kraPin";
    for (const name of ["nssfNumber", "shaNumber"] as const)
      if (text(values[name]) && !normaliseStatutoryNumber(values[name])) errors[name] = "statutory";
    const kin = [values.kinName, values.kinRelationship, values.kinPhone].map(text);
    if (kin.some(Boolean) && (kin[0]!.length < 2 || kin[1]!.length < 2)) errors.kinName = "kin";
    if (kin[2] && !normalizeKenyanPhone(kin[2])) errors.kinPhone = "phone";
    if (!values.tradeId) errors.tradeId = "required";
    if (!values.skillLevelId) errors.skillLevelId = "required";
    const project = values.projectId === NO_PROJECT ? undefined : values.projectId;
    const startDate = project ? parseCalendarInput(values.startDate) : undefined;
    if (project && !startDate) errors.startDate = "date";
    else if (startDate && startDate > today) errors.startDate = "futureDate";
    const ncaExpires = parseCalendarInput(values.ncaExpires);
    if (text(values.ncaCard) || text(values.ncaExpires)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9/-]{2,39}$/.test(text(values.ncaCard)))
        errors.ncaCard = "cardNumber";
      if (!ncaExpires) errors.ncaExpires = "date";
    }
    setInvalid(errors);
    if (Object.keys(errors).length) return null;
    const optional = (value: string) => (text(value) ? text(value) : undefined);
    const body: Record<string, unknown> = {
      fullName: text(values.fullName),
      dateOfBirth,
      gender: values.gender,
      homeCounty: values.homeCounty || undefined,
      idType: values.idType,
      idNumber: text(values.idNumber),
      phone: optional(values.phone),
      kraPin: optional(values.kraPin),
      nssfNumber: optional(values.nssfNumber),
      shaNumber: optional(values.shaNumber),
      nextOfKin: kin[0]
        ? { name: kin[0], relationship: kin[1], phone: kin[2] ? kin[2] : undefined }
        : undefined,
      tradeId: values.tradeId,
      skillLevelId: values.skillLevelId,
      engagementType: values.engagementType,
      rateBasis: values.rateBasis,
      projectId: project,
      engagementStartDate: startDate ?? undefined,
      consent: {
        noticeVersion,
        language: consent.language,
        method: consent.method,
        witnessName: consent.method === "witnessed_verbal" ? text(consent.witnessName) : undefined,
        granted: true,
      },
      accreditation: text(values.ncaCard)
        ? { category: values.ncaCategory, cardNumber: text(values.ncaCard), expiresOn: ncaExpires }
        : undefined,
      doNotRehireOverride: overrideReason ? { reason: overrideReason } : undefined,
    };
    const parsed = registerLabourerRequestSchema.safeParse(body);
    if (!parsed.success) {
      setFailure(problem(new FoundationApiError(400, "validation-error")));
      return null;
    }
    return body;
  }

  async function submit(overrideReason?: string) {
    const body = request(overrideReason);
    if (!body) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest("/labour/labourers", labourerResponseSchema, {
        method: "POST",
        body,
      });
      setRegistered({
        id: result.labourer.id,
        workerNo: result.labourer.workerNo,
        fullName: result.labourer.fullName,
        warnings: result.warnings,
      });
      setMatch(null);
      setOverride("");
      router.refresh();
    } catch (error) {
      if (
        error instanceof FoundationApiError &&
        error.match?.labourerId &&
        ["duplicate-identity", "kra-pin-taken", "do-not-rehire-match"].includes(error.code)
      ) {
        setMatch({ code: error.code, match: error.match as Match });
        setFailure(null);
      } else {
        if (error instanceof FoundationApiError && error.code === "under-minimum-age")
          setInvalid({ dateOfBirth: "under18" });
        setFailure(problem(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function engageExisting(labourerId: string, overrideReason?: string) {
    const project = values.projectId === NO_PROJECT ? null : values.projectId;
    if (!project) return;
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/labour/labourers/${labourerId}/engagements`, labourerResponseSchema, {
        method: "POST",
        body: {
          projectId: project,
          startDate: parseCalendarInput(values.startDate) ?? undefined,
          ...(overrideReason ? { doNotRehireOverride: { reason: overrideReason } } : {}),
        },
      });
      router.push(`/labour?worker=${labourerId}`);
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  if (registered)
    return (
      <section
        aria-labelledby="registered-heading"
        className="max-w-2xl space-y-4 rounded-xl border p-6"
      >
        <h2 id="registered-heading" className="flex items-center gap-2 text-lg font-semibold">
          <CircleCheck className="size-5 text-success" aria-hidden />
          {t("done.title", { name: registered.fullName, workerNo: registered.workerNo })}
        </h2>
        <p role="status" className="text-sm text-muted-foreground">
          {t("done.description")}
        </p>
        {registered.warnings.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {registered.warnings.map((warning) => (
              <li key={warning}>{t(`warnings.${WARNING_KEYS[warning]}`)}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/labour?worker=${registered.id}`}>{t("done.open")}</Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setRegistered(null);
              setValues(initial());
              setConsent({
                language: initialLanguage,
                method: "signed",
                witnessName: "",
                agreed: false,
              });
              setStep("consent");
            }}
          >
            {t("done.another")}
          </Button>
        </div>
      </section>
    );

  if (step === "consent")
    return (
      <section aria-labelledby="consent-step" className="max-w-3xl space-y-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase">
            {t("stepOf", { step: 1, total: 2 })}
          </p>
          <h2 id="consent-step" className="text-lg font-semibold">
            {t("consentStep")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("consentStepHint")}</p>
        </div>
        <ConsentCapture
          value={consent}
          onChange={setConsent}
          notices={notices}
          company={company}
          noticeVersion={noticeVersion}
        />
        <p className="text-sm text-muted-foreground">{t("refusedHint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!consentComplete(consent)} onClick={() => setStep("details")}>
            {t("continue")}
          </Button>
          <Button asChild variant="outline">
            <Link href="/labour">{t("cancel")}</Link>
          </Button>
        </div>
      </section>
    );

  const field = (
    name: FieldName,
    options: {
      label?: string;
      hint?: string;
      required?: boolean;
      type?: string;
      inputMode?: "numeric" | "tel" | "text";
      maxLength?: number;
    } = {},
  ) => (
    <Field data-invalid={invalid[name] ? true : undefined}>
      <FieldLabel htmlFor={`register-${name}`}>
        {options.label ?? t(`fields.${name as "fullName"}`)}
        {options.required ? <span aria-hidden> *</span> : null}
      </FieldLabel>
      <Input
        id={`register-${name}`}
        value={values[name]}
        onChange={set(name)}
        type={options.type ?? "text"}
        inputMode={options.inputMode}
        maxLength={options.maxLength ?? 150}
        autoComplete="off"
        required={options.required}
        aria-invalid={invalid[name] ? true : undefined}
        aria-describedby={
          [
            options.hint ? `register-${name}-hint` : "",
            invalid[name] ? `register-${name}-error` : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      {options.hint ? (
        <FieldDescription id={`register-${name}-hint`}>{options.hint}</FieldDescription>
      ) : null}
      <InvalidMessage id={`register-${name}-error`} reason={invalid[name]} oldest={oldest} />
    </Field>
  );
  const select = (
    name: FieldName,
    label: string,
    options: { value: string; label: string }[],
    extra: { required?: boolean; placeholder?: string } = {},
  ) => (
    <Field data-invalid={invalid[name] ? true : undefined}>
      <FieldLabel htmlFor={`register-${name}`}>
        {label}
        {extra.required ? <span aria-hidden> *</span> : null}
      </FieldLabel>
      <select
        id={`register-${name}`}
        className={selectClass}
        value={values[name]}
        onChange={set(name)}
        required={extra.required}
        aria-invalid={invalid[name] ? true : undefined}
        aria-describedby={invalid[name] ? `register-${name}-error` : undefined}
      >
        {extra.placeholder !== undefined ? <option value="">{extra.placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <InvalidMessage id={`register-${name}-error`} reason={invalid[name]} oldest={oldest} />
    </Field>
  );
  const project = setup.manageableProjects.find((entry) => entry.id === values.projectId);

  return (
    <section aria-labelledby="details-step" className="max-w-3xl space-y-4">
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase">
          {t("stepOf", { step: 2, total: 2 })}
        </p>
        <h2 id="details-step" className="text-lg font-semibold">
          {t("detailsStep")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("consentRecorded", {
            language: tConsent(`languages.${consent.language}`),
            method: tConsent(`methods.${consent.method}`),
          })}{" "}
          <Button variant="link" className="h-auto p-0" onClick={() => setStep("consent")}>
            {t("changeConsent")}
          </Button>
        </p>
      </div>
      {!trades.length || !skillLevels.length ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("noSetup")}{" "}
          <Link href="/labour/setup" className="underline underline-offset-4">
            {t("openSetup")}
          </Link>
        </p>
      ) : null}
      <form
        noValidate
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {match ? (
          <MatchNotice
            code={match.code}
            match={match.match}
            project={project ? `${project.code} · ${project.name}` : null}
            canOverride={canOverride}
            override={override}
            onOverrideChange={setOverride}
            busy={busy}
            onEngage={(reason) => void engageExisting(match.match.labourerId, reason)}
            onRegisterAnyway={(reason) => void submit(reason)}
          />
        ) : null}

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-base font-semibold">{t("sections.person")}</legend>
          <div className="sm:col-span-2">{field("fullName", { required: true })}</div>
          {field("dateOfBirth", {
            required: true,
            inputMode: "numeric",
            hint: t("dobHint", { date: formatCalendarDate(oldest) }),
            maxLength: 10,
          })}
          {select(
            "gender",
            t("fields.gender"),
            GENDERS.map((value) => ({ value, label: tPanel(`genders.${value}`) })),
            { required: true, placeholder: t("choose") },
          )}
          {select(
            "homeCounty",
            t("fields.homeCounty"),
            KENYA_COUNTIES.map((county) => ({ value: county.key, label: county.name })),
            { placeholder: t("notSelected") },
          )}
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-1 text-base font-semibold">{t("sections.identity")}</legend>
          <p className="text-sm text-muted-foreground sm:col-span-2">{t("identityHint")}</p>
          {select(
            "idType",
            t("fields.idType"),
            ID_DOCUMENT_TYPES.map((value) => ({ value, label: tPanel(`idTypes.${value}`) })),
            { required: true },
          )}
          {field("idNumber", { required: true, maxLength: 40 })}
          {field("phone", {
            type: "tel",
            inputMode: "tel",
            hint: t("phoneHint"),
            maxLength: 20,
          })}
          {field("kraPin", { hint: t("kraPinHint"), maxLength: 20 })}
          {field("nssfNumber", { maxLength: 40 })}
          {field("shaNumber", { maxLength: 40 })}
          {field("kinName", { maxLength: 120 })}
          {field("kinRelationship", { maxLength: 60 })}
          {field("kinPhone", { type: "tel", inputMode: "tel", maxLength: 20 })}
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-base font-semibold">{t("sections.work")}</legend>
          {select(
            "tradeId",
            t("fields.tradeId"),
            trades.map((trade) => ({ value: trade.id, label: localName(trade, locale) })),
            { required: true, placeholder: t("choose") },
          )}
          {select(
            "skillLevelId",
            t("fields.skillLevelId"),
            skillLevels.map((level) => ({ value: level.id, label: localName(level, locale) })),
            { required: true, placeholder: t("choose") },
          )}
          {select(
            "engagementType",
            t("fields.engagementType"),
            ENGAGEMENT_TYPES.map((value) => ({
              value,
              label: tPanel(`engagementTypes.${value}`),
            })),
          )}
          {select(
            "rateBasis",
            t("fields.rateBasis"),
            RATE_BASES.map((value) => ({ value, label: tPanel(`rateBases.${value}`) })),
          )}
          {select("projectId", t("fields.projectId"), [
            ...setup.manageableProjects.map((entry) => ({
              value: entry.id,
              label: `${entry.code} · ${entry.name}`,
            })),
            ...(companyWide ? [{ value: NO_PROJECT, label: t("noProject") }] : []),
          ])}
          {values.projectId !== NO_PROJECT
            ? field("startDate", { inputMode: "numeric", hint: t("dateHint"), maxLength: 10 })
            : null}
        </fieldset>

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-1 text-base font-semibold">{t("sections.nca")}</legend>
          <p className="text-sm text-muted-foreground sm:col-span-2">{t("ncaHint")}</p>
          {select(
            "ncaCategory",
            t("fields.ncaCategory"),
            ACCREDITATION_CATEGORIES.map((value) => ({
              value,
              label: tPanel(`accreditations.categories.${value}`),
            })),
          )}
          {field("ncaCard", { maxLength: 40 })}
          {field("ncaExpires", {
            inputMode: "numeric",
            hint: t("ncaExpiresHint", {
              date: formatCalendarDate(addCalendarDays(today, 365)),
            }),
            maxLength: 10,
          })}
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !trades.length || !skillLevels.length}>
            {t("submit")}
          </Button>
          <Button type="button" variant="outline" onClick={() => setStep("consent")}>
            {t("back")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function InvalidMessage({
  id,
  reason,
  oldest,
}: {
  id: string;
  reason: Invalid | undefined;
  oldest: string;
}) {
  const t = useTranslations("labourLive.register.invalid");
  if (!reason) return null;
  return (
    <FieldError id={id}>
      {reason === "under18" ? t("under18", { date: formatCalendarDate(oldest) }) : t(reason)}
    </FieldError>
  );
}

/** Explains a 409 match by ID, KRA PIN or phone and offers the allowed next step. */
function MatchNotice({
  code,
  match,
  project,
  canOverride,
  override,
  onOverrideChange,
  busy,
  onEngage,
  onRegisterAnyway,
}: {
  code: string;
  match: Match;
  project: string | null;
  canOverride: boolean;
  override: string;
  onOverrideChange: (value: string) => void;
  busy: boolean;
  onEngage: (overrideReason?: string) => void;
  onRegisterAnyway: (overrideReason: string) => void;
}) {
  const t = useTranslations("labourLive.register.match");
  const tOverride = useTranslations("labourLive.override");
  const flagged = code === "do-not-rehire-match";
  const on = t(`on.${match.matchedOn as "id"}`);
  const reasonOk = override.trim().length >= 10;
  // A flagged phone match may be a different person sharing a phone: overridable when registering.
  const overrideRegistration = flagged && match.matchedOn === "phone" && canOverride;
  // The same person (ID) may be engaged again on this project, with an override when flagged.
  const engage = match.matchedOn === "id" && project !== null && (!flagged || canOverride);
  return (
    <div
      role="alert"
      className={
        flagged
          ? "space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
          : "space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
      }
    >
      <p className="flex items-start gap-2 font-medium">
        {flagged ? <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
        {flagged
          ? t("flagged", { workerNo: match.workerNo, on })
          : code === "kra-pin-taken"
            ? t("kraPin", { workerNo: match.workerNo })
            : t("duplicate", { workerNo: match.workerNo })}
      </p>
      <p>
        {flagged ? (canOverride ? t("flaggedCanOverride") : t("flaggedNoOverride")) : t("hint")}
      </p>
      {flagged && canOverride && (overrideRegistration || engage) ? (
        <Field>
          <FieldLabel htmlFor="register-override">{tOverride("reason")}</FieldLabel>
          <Textarea
            id="register-override"
            value={override}
            onChange={(event) => onOverrideChange(event.target.value)}
            minLength={10}
            maxLength={500}
            rows={3}
            aria-describedby="register-override-hint"
          />
          <FieldDescription id="register-override-hint">{tOverride("hint")}</FieldDescription>
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {engage ? (
          <Button
            type="button"
            size="sm"
            disabled={busy || (flagged && !reasonOk)}
            onClick={() => onEngage(flagged ? override.trim() : undefined)}
          >
            {t("engage", { workerNo: match.workerNo, project: project ?? "" })}
          </Button>
        ) : null}
        {overrideRegistration ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy || !reasonOk}
            onClick={() => onRegisterAnyway(override.trim())}
          >
            {t("registerAnyway")}
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline">
          <Link href={`/labour?worker=${match.labourerId}`}>
            {t("open", { workerNo: match.workerNo })}
          </Link>
        </Button>
      </div>
    </div>
  );
}
