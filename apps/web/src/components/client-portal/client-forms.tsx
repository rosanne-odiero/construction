"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, X } from "lucide-react";
import {
  clientDecisionRequestSchema,
  clientPreferencesResponseSchema,
  clientVariationDetailResponseSchema,
} from "@pm-buddy/validation";
import type { DisplayCurrency } from "@pm-buddy/types";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DISPLAY_CHOICES } from "@/lib/client-portal";
import { liveRequest } from "@/lib/live-api";

/**
 * The client's decision on a variation sent to them: approve or reject (a rejection needs a
 * comment), once, on the digest of the figures shown (rule D-134). The page reloads with the
 * recorded decision.
 */
export function DecisionForm({
  projectId,
  requestId,
  clientDigest,
}: {
  projectId: string;
  requestId: string;
  clientDigest: string;
}) {
  const t = useTranslations("clientPortal.variations.decide");
  const problem = useProblemMessage();
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const decide = async (decision: "approved" | "rejected") => {
    setFailure(null);
    const body = { decision, clientDigest, ...(comment.trim() ? { comment: comment.trim() } : {}) };
    if (!clientDecisionRequestSchema.safeParse(body).success) {
      setFailure(t("commentRequired"));
      return;
    }
    setBusy(decision);
    try {
      await liveRequest(
        `/portal/client/projects/${projectId}/variations/${requestId}/decision`,
        clientVariationDetailResponseSchema,
        { method: "POST", body },
      );
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="decision-comment" className="block text-sm font-medium">
          {t("comment")}
        </label>
        <Textarea
          id="decision-comment"
          value={comment}
          maxLength={1000}
          onChange={(event) => setComment(event.target.value)}
          aria-describedby="decision-comment-hint"
        />
        <p id="decision-comment-hint" className="text-xs text-muted-foreground">
          {t("commentHint")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy !== null} onClick={() => decide("approved")}>
          <Check aria-hidden /> {busy === "approved" ? t("sending") : t("approve")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() => decide("rejected")}
        >
          <X aria-hidden /> {busy === "rejected" ? t("sending") : t("reject")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("once")}</p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** Chooses the display currency (stored for the signed-in client; indicative only). */
export function CurrencyForm({ current }: { current: DisplayCurrency }) {
  const t = useTranslations("clientPortal.settings");
  const problem = useProblemMessage();
  const router = useRouter();
  const [value, setValue] = useState<DisplayCurrency>(current);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setMessage(null);
        try {
          await liveRequest("/portal/client/preferences", clientPreferencesResponseSchema, {
            method: "PUT",
            body: { displayCurrency: value },
          });
          setMessage({ ok: true, text: t("saved") });
          router.refresh();
        } catch (error) {
          setMessage({ ok: false, text: problem(error) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("currency")}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DISPLAY_CHOICES.map((choice) => (
            <label
              key={choice}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 has-[:checked]:border-primary"
            >
              <input
                type="radio"
                name="currency"
                value={choice}
                checked={value === choice}
                onChange={() => setValue(choice)}
              />
              <span>{t(`choices.${choice}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={busy}>
        {busy ? t("saving") : t("save")}
      </Button>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
