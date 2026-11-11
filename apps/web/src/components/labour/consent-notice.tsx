"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CONSENT_METHODS, LOCALES, type ConsentMethod, type Locale } from "@pm-buddy/types";
import type { Messages } from "@pm-buddy/i18n";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export type ConsentNoticeText = Messages["labourConsentNotices"]["registrationV1"];
export type ConsentNotices = Record<Locale, ConsentNoticeText>;

const SECTIONS = ["who", "what", "why", "protect", "share", "keep", "rights", "withdraw"] as const;

/**
 * The versioned consent notice in the language the worker chose (which may differ from the
 * interface language). The text is the pinned catalogue text; only {company} is filled in.
 */
export function ConsentNotice({
  notice,
  language,
  company,
}: {
  notice: ConsentNoticeText;
  language: Locale;
  company: string;
}) {
  const fill = (text: string) => text.replaceAll("{company}", company);
  return (
    <article
      lang={language}
      aria-labelledby="consent-notice-title"
      className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed"
    >
      <h3 id="consent-notice-title" className="text-base font-semibold">
        {fill(notice.title)}
      </h3>
      <p>{fill(notice.intro)}</p>
      {SECTIONS.map((section) => (
        <section key={section} className="space-y-1">
          <h4 className="font-medium">{fill(notice[`${section}Title`])}</h4>
          <p>{fill(notice[section])}</p>
        </section>
      ))}
      <p className="text-muted-foreground">{fill(notice.biometrics)}</p>
      <p className="font-medium">{fill(notice.question)}</p>
    </article>
  );
}

export type ConsentCaptureValue = {
  language: Locale;
  method: ConsentMethod;
  witnessName: string;
  agreed: boolean;
};

export function useConsentCapture(initialLanguage: Locale) {
  return useState<ConsentCaptureValue>({
    language: initialLanguage,
    method: "signed",
    witnessName: "",
    agreed: false,
  });
}

export const consentComplete = (value: ConsentCaptureValue) =>
  value.agreed && (value.method === "signed" || value.witnessName.trim().length >= 3);

/** Notice language, how the worker agreed (signed or read aloud with a witness) and the answer. */
export function ConsentCapture({
  value,
  onChange,
  notices,
  company,
  noticeVersion,
  idPrefix = "consent",
}: {
  value: ConsentCaptureValue;
  onChange: (value: ConsentCaptureValue) => void;
  notices: ConsentNotices;
  company: string;
  noticeVersion: string;
  idPrefix?: string;
}) {
  const t = useTranslations("labourLive.consent");
  const set = (patch: Partial<ConsentCaptureValue>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("language")}</legend>
        <div className="flex flex-wrap gap-4">
          {LOCALES.map((language) => (
            <label key={language} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${idPrefix}-language`}
                value={language}
                checked={value.language === language}
                onChange={() => set({ language, agreed: false })}
                className="size-4 accent-primary"
              />
              {t(`languages.${language}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <ConsentNotice notice={notices[value.language]} language={value.language} company={company} />
      <p className="text-xs text-muted-foreground">
        {t("version", { version: noticeVersion })} · {t("complianceReview")}
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("method")}</legend>
        {CONSENT_METHODS.map((method) => (
          <label key={method} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-method`}
              value={method}
              checked={value.method === method}
              onChange={() => set({ method })}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              {t(`methods.${method}`)}
              <span className="block text-xs text-muted-foreground">
                {t(`methodHints.${method}`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {value.method === "witnessed_verbal" ? (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-witness`}>{t("witness")}</FieldLabel>
          <Input
            id={`${idPrefix}-witness`}
            value={value.witnessName}
            onChange={(event) => set({ witnessName: event.target.value })}
            maxLength={120}
            autoComplete="off"
            required
            aria-describedby={`${idPrefix}-witness-hint`}
          />
          <FieldDescription id={`${idPrefix}-witness-hint`}>{t("witnessHint")}</FieldDescription>
        </Field>
      ) : null}
      <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
        <input
          type="checkbox"
          checked={value.agreed}
          onChange={(event) => set({ agreed: event.target.checked })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>{t("agreed", { language: t(`languages.${value.language}`) })}</span>
      </label>
    </div>
  );
}
