"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { REASON_LIMITS } from "@pm-buddy/domain";
import { measurementResponseSchema, valuationResponseSchema } from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import { useValuationProblem } from "./use-valuation-problem";

export type ValuationActionText = {
  button: string;
  title: string;
  description: string;
  confirm: string;
};

/**
 * One measurement or valuation command behind a confirmation dialog (optionally with a reason).
 * Certification asks for step-up when the API needs it. The API decides: refusals such as
 * maker-checker, a stale digest or missing evidence are shown in the dialog in EN/SW; on success
 * the page refreshes (or opens the result). Props are serialisable for server pages.
 */
export function ValuationAction({
  path,
  entity,
  body = {},
  reason = false,
  text,
  primary = false,
  destructive = false,
  method = "POST",
}: {
  path: string;
  entity: "valuation" | "measurement";
  body?: Record<string, unknown>;
  reason?: boolean;
  text: ValuationActionText;
  primary?: boolean;
  destructive?: boolean;
  method?: "POST" | "DELETE";
}) {
  const t = useTranslations("valuations.common");
  const problem = useValuationProblem();
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = `action-${path.replace(/[^a-z0-9]/gi, "-")}`;

  async function run() {
    if (reason && Array.from(why.trim()).length < REASON_LIMITS.min) {
      setFailure(t("reasonShort"));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const init = {
        method,
        ...(method === "DELETE"
          ? {}
          : { body: { ...body, ...(reason ? { reason: why.trim() } : {}) } }),
      };
      await stepUp.run<unknown>(() =>
        entity === "valuation"
          ? liveRequest(path, valuationResponseSchema, init)
          : liveRequest(path, measurementResponseSchema, init),
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={primary ? "default" : "outline"}
        onClick={() => {
          setFailure(null);
          setWhy("");
          setOpen(true);
        }}
      >
        {text.button}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.description}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {reason ? (
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>{t("reason")}</FieldLabel>
              <Textarea
                id={`${id}-reason`}
                value={why}
                onChange={(event) => setWhy(event.target.value)}
                maxLength={REASON_LIMITS.max}
                rows={3}
                required
              />
              <FieldDescription>{t("reasonHint")}</FieldDescription>
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("close")}
            </Button>
            <Button
              type="button"
              variant={destructive ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void run()}
            >
              {text.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
