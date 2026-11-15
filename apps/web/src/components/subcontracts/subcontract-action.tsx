"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { REASON_LIMITS } from "@pm-buddy/domain";
import {
  outputResponseSchema,
  pieceRateJobResponseSchema,
  subcontractCertificateResponseSchema,
  subcontractResponseSchema,
} from "@pm-buddy/validation";
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
import { useSubcontractProblem } from "./use-subcontract-problem";

export type SubcontractActionText = {
  button: string;
  title: string;
  description: string;
  confirm: string;
};

type Entity = "subcontract" | "certificate" | "job" | "output";

/** The command, parsed with the response contract of its entity. */
function send(
  path: string,
  entity: Entity,
  init: { method: "POST"; body: Record<string, unknown> },
) {
  switch (entity) {
    case "subcontract":
      return liveRequest(path, subcontractResponseSchema, init);
    case "certificate":
      return liveRequest(path, subcontractCertificateResponseSchema, init);
    case "job":
      return liveRequest(path, pieceRateJobResponseSchema, init);
    default:
      return liveRequest(path, outputResponseSchema, init);
  }
}

/**
 * One subcontract, certificate, piece-rate job or output command behind a confirmation dialog (optionally
 * with a reason). Approval, certification and payment ask for step-up when the API needs it; the
 * API decides, and refusals (maker-checker, a stale digest, a cap) show in the dialog in EN/SW.
 * Props are serialisable for server pages.
 */
export function SubcontractAction({
  path,
  entity,
  body = {},
  reason = false,
  reasonKey = "reason",
  text,
  primary = false,
  destructive = false,
}: {
  path: string;
  entity: Entity;
  body?: Record<string, unknown>;
  reason?: boolean;
  /** The body field the reason goes in (D4.1 output decisions call it `note`). */
  reasonKey?: "reason" | "note";
  text: SubcontractActionText;
  primary?: boolean;
  destructive?: boolean;
}) {
  const t = useTranslations("subcontracts.common");
  const problem = useSubcontractProblem();
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
        method: "POST" as const,
        body: { ...body, ...(reason ? { [reasonKey]: why.trim() } : {}) },
      };
      await stepUp.run<unknown>(() => send(path, entity, init));
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
