"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { invitationResponseSchema } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { normalizeKenyanPhone } from "@/lib/format";
import { liveRequest, LiveApiError } from "@/lib/live-api";
import { useProblemMessage } from "./use-problem-message";

/**
 * A project manager (labour.manage) invites a labourer by phone: the SMS links to the PIN
 * set-up page, and the labourer then sees this project's sites in their portal.
 */
export function InviteLabourer({ projectId }: { projectId: string }) {
  const t = useTranslations("portals.invite");
  const problem = useProblemMessage();
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const normalised = normalizeKenyanPhone(phone);

  async function invite() {
    if (!normalised) {
      setMessage({ error: true, text: t("invalidPhone") });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await liveRequest(`/projects/${projectId}/labourers/invitations`, invitationResponseSchema, {
        method: "POST",
        body: { identifier: normalised },
      });
      setMessage({ error: false, text: t("sent", { phone: normalised }) });
      setPhone("");
    } catch (error) {
      setMessage({
        error: true,
        text:
          error instanceof LiveApiError && error.code === "already-member"
            ? t("alreadyMember")
            : problem(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{t("title")}</h3>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <Field className="min-w-0 flex-1 sm:max-w-xs">
            <FieldLabel htmlFor="labourer-phone">{t("phone")}</FieldLabel>
            <Input
              id="labourer-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              aria-describedby="labourer-phone-hint"
              disabled={busy}
            />
            <FieldDescription id="labourer-phone-hint">
              {normalised ? t("normalised", { phone: normalised }) : t("phoneHint")}
            </FieldDescription>
          </Field>
          <Button type="submit" disabled={busy}>
            {t("submit")}
          </Button>
        </form>
        <p
          aria-live="polite"
          role={message?.error ? "alert" : "status"}
          className={`mt-3 text-sm ${message?.error ? "text-destructive" : ""}`}
        >
          {message?.text}
        </p>
      </CardContent>
    </Card>
  );
}
