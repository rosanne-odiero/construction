"use client";

import { createContext, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCcw, ShieldCheck, ShieldX, Trash2, UserX } from "lucide-react";
import {
  CONSENT_METHODS,
  LOCALES,
  type BiometricModality,
  type ConsentMethod,
  type ConsentNoticeVersion,
  type Locale,
} from "@pm-buddy/types";
import type { Messages } from "@pm-buddy/i18n";
import {
  biometricEnrolmentResponseSchema,
  biometricRetentionRunResponseSchema,
  workerBiometricsResponseSchema,
} from "@pm-buddy/validation";
import { ActionDialog } from "@/components/labour/action-dialog";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { fillNotice } from "@/lib/biometrics";
import { liveRequest } from "@/lib/live-api";

export type BiometricNoticeText = Messages["labourConsentNotices"]["biometricFaceV1"];
export type BiometricNoticeValues = Parameters<typeof fillNotice>[1];

type Outcome = { modality: BiometricModality; text: string };
const OutcomeContext = createContext<((outcome: Outcome) => void) | null>(null);
const ShownOutcome = createContext<Outcome | null>(null);

/**
 * Keeps the last action's confirmation across the page refresh that follows it: recording a yes,
 * a withdrawal or a deletion removes the control that made it, so its own message would vanish.
 */
export function BiometricOutcomes({ children }: { children: React.ReactNode }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  return (
    <OutcomeContext.Provider value={setOutcome}>
      <ShownOutcome.Provider value={outcome}>{children}</ShownOutcome.Provider>
    </OutcomeContext.Provider>
  );
}

/** The modality's live confirmation (always rendered, so screen readers announce changes). */
export function ModalityOutcome({ modality }: { modality: BiometricModality }) {
  const outcome = useContext(ShownOutcome);
  const text = outcome?.modality === modality ? outcome.text : "";
  return (
    <p role="status" className={text ? "text-sm text-muted-foreground" : "sr-only"}>
      {text}
    </p>
  );
}

const useAnnounce = () => useContext(OutcomeContext) ?? (() => undefined);

const SECTIONS = [
  "who",
  "what",
  "why",
  "no",
  "where",
  "howLong",
  "change",
  "rights",
  "questions",
] as const;

/**
 * The pinned biometric notice of one modality in the language the worker chose (DPIA §7.2/§7.3),
 * with the company, the retention period and the DPO's name and phone filled in.
 */
export function BiometricNotice({
  notice,
  language,
  values,
  id,
}: {
  notice: BiometricNoticeText;
  language: Locale;
  values: BiometricNoticeValues;
  id: string;
}) {
  const fill = (text: string) => fillNotice(text, values);
  return (
    <article
      lang={language}
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed"
    >
      <h4 id={`${id}-title`} className="text-base font-semibold">
        {fill(notice.title)}
      </h4>
      {SECTIONS.map((section) => (
        <section key={section} className="space-y-1">
          <h5 className="font-medium">{fill(notice[`${section}Title`])}</h5>
          <p>{fill(notice[section])}</p>
        </section>
      ))}
      <p className="font-medium">{fill(notice.question)}</p>
    </article>
  );
}

/** How the worker answered: signed, or read aloud with a named witness. */
function MethodChoice({
  name,
  method,
  witness,
  onMethod,
  onWitness,
}: {
  name: string;
  method: ConsentMethod;
  witness: string;
  onMethod: (method: ConsentMethod) => void;
  onWitness: (witness: string) => void;
}) {
  const t = useTranslations("biometrics.worker");
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("method")}</legend>
        {CONSENT_METHODS.map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${name}-method`}
              value={value}
              checked={method === value}
              onChange={() => onMethod(value)}
              className="size-4 accent-primary"
            />
            {t(`methods.${value}`)}
          </label>
        ))}
      </fieldset>
      {method === "witnessed_verbal" ? (
        <Field>
          <FieldLabel htmlFor={`${name}-witness`}>{t("witness")}</FieldLabel>
          <Input
            id={`${name}-witness`}
            value={witness}
            onChange={(event) => onWitness(event.target.value)}
            maxLength={120}
            autoComplete="off"
            required
            aria-describedby={`${name}-witness-hint`}
          />
          <FieldDescription id={`${name}-witness-hint`}>{t("witnessHint")}</FieldDescription>
        </Field>
      ) : null}
    </>
  );
}

const witnessBody = (method: ConsentMethod, witness: string) =>
  method === "witnessed_verbal" ? { witnessName: witness.trim() } : {};
const witnessMissing = (method: ConsentMethod, witness: string) =>
  method === "witnessed_verbal" && witness.trim().length < 3;

/**
 * Records the worker's yes or no to the notice of one modality (biometrics.enrol). A refusal is
 * recorded with no reason asked; the worker keeps using the card fallback either way.
 */
export function BiometricConsentForm({
  labourerId,
  modality,
  noticeVersion,
  notices,
  values,
  initialLanguage,
}: {
  labourerId: string;
  modality: BiometricModality;
  noticeVersion: ConsentNoticeVersion;
  notices: Record<Locale, BiometricNoticeText>;
  values: BiometricNoticeValues;
  initialLanguage: Locale;
}) {
  const t = useTranslations("biometrics.worker");
  const tb = useTranslations("biometrics");
  const router = useRouter();
  const problem = useProblemMessage();
  const [language, setLanguage] = useState<Locale>(initialLanguage);
  const [method, setMethod] = useState<ConsentMethod>("signed");
  const [witness, setWitness] = useState("");
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = `consent-${modality}`;
  const record = async (granted: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(
        `/biometrics/labourers/${labourerId}/consents`,
        workerBiometricsResponseSchema,
        {
          method: "POST",
          body: {
            modality,
            noticeVersion,
            language,
            method,
            granted,
            ...witnessBody(method, witness),
          },
        },
      );
      announce({ modality, text: t("recorded") });
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid={`${name}-form`}>
      <p className="text-sm">{t("canRecord")}</p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("language")}</legend>
        <div className="flex flex-wrap gap-4">
          {LOCALES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${name}-language`}
                value={value}
                checked={language === value}
                onChange={() => setLanguage(value)}
                className="size-4 accent-primary"
              />
              {t(`languages.${value}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <BiometricNotice
        notice={notices[language]}
        language={language}
        values={values}
        id={`${name}-notice`}
      />
      <p className="text-xs text-muted-foreground">
        {t("notice", { version: noticeVersion })} · {t("draftNotice")}
      </p>
      <MethodChoice
        name={name}
        method={method}
        witness={witness}
        onMethod={setMethod}
        onWitness={setWitness}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || witnessMissing(method, witness)}
          onClick={() => record(true)}
          aria-describedby={`${name}-yes-hint`}
        >
          <ShieldCheck aria-hidden /> {t("yes")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || witnessMissing(method, witness)}
          onClick={() => record(false)}
          aria-describedby={`${name}-no-hint`}
        >
          <ShieldX aria-hidden /> {t("no")}
        </Button>
      </div>
      <p id={`${name}-yes-hint`} className="text-xs text-muted-foreground">
        {t("yesConfirm", { modality: tb(`modalities.${modality}`).toLowerCase() })}
      </p>
      <p id={`${name}-no-hint`} className="text-xs text-muted-foreground">
        {t("noConfirm")}
      </p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** Records the worker's withdrawal: the modality's templates are deleted at once. */
export function WithdrawBiometricConsent({
  labourerId,
  modality,
}: {
  labourerId: string;
  modality: BiometricModality;
}) {
  const t = useTranslations("biometrics.worker");
  const tb = useTranslations("biometrics");
  const router = useRouter();
  const announce = useAnnounce();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<ConsentMethod>("signed");
  const [witness, setWitness] = useState("");
  const word = tb(`modalities.${modality}`).toLowerCase();
  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        <UserX aria-hidden /> {t("withdraw.button")}
      </Button>
      <ActionDialog
        id={`withdraw-${modality}`}
        open={open}
        onOpenChange={setOpen}
        title={t("withdraw.title", { modality: word })}
        description={t("withdraw.description", { modality: word })}
        submitLabel={t("withdraw.submit")}
        submitDisabled={witnessMissing(method, witness)}
        destructive
        onSubmit={async () => {
          await liveRequest(
            `/biometrics/labourers/${labourerId}/consents/withdraw`,
            workerBiometricsResponseSchema,
            { method: "POST", body: { modality, method, ...witnessBody(method, witness) } },
          );
          announce({ modality, text: t("withdraw.done") });
          router.refresh();
        }}
      >
        <MethodChoice
          name={`withdraw-${modality}`}
          method={method}
          witness={witness}
          onMethod={setMethod}
          onWitness={setWitness}
        />
      </ActionDialog>
    </>
  );
}

/** Deletes an enrolment's templates on the worker's request (biometrics.manage). */
export function DeleteBiometricTemplates({
  enrolmentId,
  modality,
}: {
  enrolmentId: string;
  modality: BiometricModality;
}) {
  const t = useTranslations("biometrics.worker.delete");
  const tb = useTranslations("biometrics");
  const router = useRouter();
  const announce = useAnnounce();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden /> {t("button")}
      </Button>
      <ActionDialog
        id={`delete-${enrolmentId}`}
        open={open}
        onOpenChange={setOpen}
        title={t("title", { modality: tb(`modalities.${modality}`).toLowerCase() })}
        description={t("description")}
        submitLabel={t("submit")}
        destructive
        onSubmit={async () => {
          await liveRequest(
            `/biometrics/enrolments/${enrolmentId}/delete`,
            biometricEnrolmentResponseSchema,
            { method: "POST", body: { reason: "request" } },
          );
          announce({ modality, text: t("done") });
          router.refresh();
        }}
      >
        {null}
      </ActionDialog>
    </>
  );
}

/** Runs the retention deletions for the company now (biometrics.manage). */
export function RunBiometricRetention() {
  const t = useTranslations("biometrics.enrolmentList.run");
  const router = useRouter();
  const problem = useProblemMessage();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setOutcome(null);
          try {
            const { deleted } = await liveRequest(
              "/biometrics/retention/run",
              biometricRetentionRunResponseSchema,
              { method: "POST", body: {} },
            );
            setOutcome({ error: false, text: t("done", { count: deleted }) });
            router.refresh();
          } catch (error) {
            setOutcome({ error: true, text: problem(error) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCcw aria-hidden /> {t("button")}
      </Button>
      <p
        role={outcome?.error ? "alert" : "status"}
        className={outcome?.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {outcome?.text ?? ""}
      </p>
    </div>
  );
}
