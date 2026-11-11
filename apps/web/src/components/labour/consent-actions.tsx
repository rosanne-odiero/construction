"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CONSENT_METHODS, type ConsentMethod, type Locale } from "@pm-buddy/types";
import { labourerResponseSchema } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { ActionDialog } from "./action-dialog";
import {
  ConsentCapture,
  consentComplete,
  useConsentCapture,
  type ConsentNotices,
} from "./consent-notice";

/** Records consent to the current notice, or the worker's withdrawal (labour.consent). */
export function ConsentActions({
  labourerId,
  mode,
  canWithdraw,
  notices,
  noticeVersion,
  company,
  initialLanguage,
}: {
  labourerId: string;
  mode: "record" | "withdraw";
  canWithdraw: boolean;
  notices: ConsentNotices;
  noticeVersion: string;
  company: string;
  initialLanguage: Locale;
}) {
  const t = useTranslations("labourLive.consentPage");
  const router = useRouter();
  const problem = useProblemMessage();
  const [consent, setConsent] = useConsentCapture(initialLanguage);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function record() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/labour/labourers/${labourerId}/consents`, labourerResponseSchema, {
        method: "POST",
        body: {
          noticeVersion,
          language: consent.language,
          method: consent.method,
          ...(consent.method === "witnessed_verbal"
            ? { witnessName: consent.witnessName.trim() }
            : {}),
          granted: true,
        },
      });
      setSaved(t("recorded"));
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <p role="status" className="text-sm text-success empty:hidden">
        {saved}
      </p>
      {mode === "record" ? (
        <section aria-labelledby="record-consent" className="space-y-4">
          <h2 id="record-consent" className="text-base font-semibold">
            {t("recordTitle")}
          </h2>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <ConsentCapture
            value={consent}
            onChange={setConsent}
            notices={notices}
            company={company}
            noticeVersion={noticeVersion}
          />
          <Button disabled={busy || !consentComplete(consent)} onClick={() => void record()}>
            {t("record")}
          </Button>
        </section>
      ) : null}
      {canWithdraw ? (
        <WithdrawConsent
          labourerId={labourerId}
          onDone={() => {
            setSaved(t("withdrawn"));
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function WithdrawConsent({ labourerId, onDone }: { labourerId: string; onDone: () => void }) {
  const t = useTranslations("labourLive.consentPage");
  const tConsent = useTranslations("labourLive.consent");
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<ConsentMethod>("signed");
  const [witness, setWitness] = useState("");
  return (
    <section aria-labelledby="withdraw-consent" className="space-y-2 rounded-lg border p-4">
      <h2 id="withdraw-consent" className="text-base font-semibold">
        {t("withdrawTitle")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("withdrawHint")}</p>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        {t("withdraw")}
      </Button>
      <ActionDialog
        id="withdraw-form"
        open={open}
        onOpenChange={setOpen}
        title={t("withdrawTitle")}
        description={t("withdrawConfirm")}
        submitLabel={t("withdraw")}
        destructive
        submitDisabled={method === "witnessed_verbal" && witness.trim().length < 3}
        onSubmit={async () => {
          await liveRequest(
            `/labour/labourers/${labourerId}/consents/withdraw`,
            labourerResponseSchema,
            {
              method: "POST",
              body: {
                method,
                ...(method === "witnessed_verbal" ? { witnessName: witness.trim() } : {}),
              },
            },
          );
          onDone();
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("withdrawMethod")}</legend>
          {CONSENT_METHODS.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="withdraw-method"
                value={value}
                checked={method === value}
                onChange={() => setMethod(value)}
                className="size-4 accent-primary"
              />
              {tConsent(`methods.${value}`)}
            </label>
          ))}
        </fieldset>
        {method === "witnessed_verbal" ? (
          <Field>
            <FieldLabel htmlFor="withdraw-witness">{tConsent("witness")}</FieldLabel>
            <Input
              id="withdraw-witness"
              value={witness}
              onChange={(event) => setWitness(event.target.value)}
              maxLength={120}
              required
            />
          </Field>
        ) : null}
      </ActionDialog>
    </section>
  );
}
