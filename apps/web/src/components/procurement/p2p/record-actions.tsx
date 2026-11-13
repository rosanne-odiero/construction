"use client";

import { useState } from "react";
import type { z } from "zod";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ban, CheckCircle2, RefreshCw, Send, Undo2, XCircle } from "lucide-react";
import { REASON_LIMITS } from "@pm-buddy/domain";
import {
  grnResponseSchema,
  invoiceDetailResponseSchema,
  lpoDetailResponseSchema,
  requisitionDetailResponseSchema,
  rfqDetailResponseSchema,
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
import { useP2pProblem } from "./use-p2p-problem";

const SCHEMAS: Record<"requisition" | "rfq" | "lpo" | "grn" | "invoice", z.ZodType<unknown>> = {
  requisition: requisitionDetailResponseSchema,
  rfq: rfqDetailResponseSchema,
  lpo: lpoDetailResponseSchema,
  grn: grnResponseSchema,
  invoice: invoiceDetailResponseSchema,
};
const ICONS: Record<string, React.ReactNode> = {
  submit: <Send aria-hidden />,
  approve: <CheckCircle2 aria-hidden />,
  reject: <XCircle aria-hidden />,
  reopen: <Undo2 aria-hidden />,
  return: <Undo2 aria-hidden />,
  cancel: <Ban aria-hidden />,
  void: <Ban aria-hidden />,
  rematch: <RefreshCw aria-hidden />,
  withdraw: <Undo2 aria-hidden />,
};

export type RecordAction = {
  /** The last path segment of the command (`submit`, `approve`, `cancel`, `void`...). */
  action: string;
  /** Optional explicit text; defaults to p2p.actions.<action>. */
  text?: { button: string; title: string; description: string; confirm: string };
  reason?: boolean;
  stepUp?: boolean;
  /** Commands that take no version (GRN void, quotation withdrawal). */
  unversioned?: boolean;
  primary?: boolean;
  destructive?: boolean;
  /** Overrides the command path (relative to /api/v1), e.g. a quotation withdrawal. */
  path?: string;
};

const DEFAULT_TEXT = new Set(["submit", "approve", "reject", "reopen", "return", "cancel"]);

/**
 * The commands a procure-to-pay record offers this caller. Each opens a confirmation (with a
 * reason where the workflow needs one); approvals ask for a fresh step-up when the API wants
 * one. The API decides: refusals (maker-checker, version conflicts, stale matches) are shown in
 * the dialog in EN/SW.
 */
export function RecordActions({
  entity,
  basePath,
  number,
  version,
  actions,
}: {
  entity: keyof typeof SCHEMAS;
  basePath: string;
  number: string;
  version: number;
  actions: RecordAction[];
}) {
  const t = useTranslations("p2p.actions");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState<RecordAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!actions.length) return null;

  const textOf = (entry: RecordAction) => {
    if (entry.text) return entry.text;
    const key = (DEFAULT_TEXT.has(entry.action) ? entry.action : "submit") as
      "submit" | "approve" | "reject" | "reopen" | "return" | "cancel";
    return {
      button: t(`${key}.button`),
      title: t(`${key}.title`, { number }),
      description: t(`${key}.description`),
      confirm: t(`${key}.confirm`),
    };
  };

  async function run(entry: RecordAction) {
    setBusy(true);
    setFailure(null);
    const body: Record<string, unknown> = entry.unversioned ? {} : { version };
    if (entry.reason) body["reason"] = reason.trim();
    try {
      const request = () =>
        liveRequest(entry.path ?? `${basePath}/${entry.action}`, SCHEMAS[entity], {
          method: "POST",
          body,
        });
      await (entry.stepUp ? stepUp.run(request) : request());
      setOpen(null);
      setReason("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const text = open ? textOf(open) : null;
  return (
    <>
      {actions.map((entry) => (
        <Button
          key={entry.path ?? entry.action}
          variant={entry.primary ? "default" : "outline"}
          onClick={() => {
            setFailure(null);
            setReason("");
            setOpen(entry);
          }}
        >
          {ICONS[entry.action]} {textOf(entry).button}
        </Button>
      ))}
      <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : setOpen(null))}>
        <DialogContent showCloseButton={false}>
          {open && text ? (
            <>
              <DialogHeader>
                <DialogTitle>{text.title}</DialogTitle>
                <DialogDescription>{text.description}</DialogDescription>
              </DialogHeader>
              {failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              ) : null}
              {open.reason ? (
                <Field>
                  <FieldLabel htmlFor="record-action-reason">{tCommon("reason")}</FieldLabel>
                  <Textarea
                    id="record-action-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={REASON_LIMITS.max}
                    rows={3}
                    required
                  />
                  <FieldDescription>{tCommon("reasonHint")}</FieldDescription>
                </Field>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                  {tCommon("close")}
                </Button>
                <Button
                  type="button"
                  variant={open.destructive ? "destructive" : "default"}
                  disabled={busy || (open.reason && reason.trim().length < REASON_LIMITS.min)}
                  onClick={() => void run(open)}
                >
                  {text.confirm}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
