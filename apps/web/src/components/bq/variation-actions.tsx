"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2, GitBranch, Send, Undo2, XCircle, Ban } from "lucide-react";
import { REASON_LIMITS } from "@pm-buddy/domain";
import type { VariationAction } from "@pm-buddy/types";
import { variationResponseSchema, type VariationDetail } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
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
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";

const ICONS: Record<VariationAction, React.ReactNode> = {
  submit: <Send aria-hidden />,
  approve: <CheckCircle2 aria-hidden />,
  reject: <XCircle aria-hidden />,
  reopen: <Undo2 aria-hidden />,
  cancel: <Ban aria-hidden />,
  rebase: <GitBranch aria-hidden />,
};
const WITH_REASON = new Set<VariationAction>(["reject", "cancel"]);
const WITH_DIGEST = new Set<VariationAction>(["approve", "reject"]);

/**
 * The commands the API offers for this variation and caller (permissions.actions). Each opens a
 * confirmation; approval and rejection quote the snapshot digest the user is looking at, so a
 * proposal that changed in the meantime is refused (variation-stale); approval asks for a fresh
 * step-up when needed.
 */
export function VariationActions({
  projectId,
  variation,
  dirty,
}: {
  projectId: string;
  variation: VariationDetail;
  /** Unsaved line edits: submitting is blocked until they are saved or discarded. */
  dirty: boolean;
}) {
  const t = useTranslations("variationDetail.actions");
  const problem = useProblemMessage();
  const router = useRouter();
  const stepUp = useStepUp();
  const [action, setAction] = useState<VariationAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const actions = variation.permissions.actions;
  if (!actions.length) return null;

  async function run(chosen: VariationAction) {
    setBusy(true);
    setFailure(null);
    const body: Record<string, unknown> = { version: variation.version };
    if (WITH_DIGEST.has(chosen)) body["snapshotDigest"] = variation.snapshot?.digest ?? "";
    if (WITH_REASON.has(chosen)) body["reason"] = reason.trim();
    try {
      const request = () =>
        liveRequest(
          `/projects/${projectId}/bq/variations/${variation.id}/${chosen}`,
          variationResponseSchema,
          { method: "POST", body },
        );
      await (chosen === "approve" ? stepUp.run(request) : request());
      setAction(null);
      setReason("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const needsReason = action !== null && WITH_REASON.has(action);
  return (
    <>
      {actions.map((entry) => (
        <Button
          key={entry}
          variant={entry === "approve" || entry === "submit" ? "default" : "outline"}
          disabled={entry === "submit" && dirty}
          onClick={() => {
            setFailure(null);
            setAction(entry);
          }}
        >
          {ICONS[entry]} {t(`${entry}.button`)}
        </Button>
      ))}
      <Dialog open={action !== null} onOpenChange={(next) => (next ? undefined : setAction(null))}>
        <DialogContent showCloseButton={false}>
          {action ? (
            <>
              <DialogHeader>
                <DialogTitle>{t(`${action}.title`, { number: variation.number })}</DialogTitle>
                <DialogDescription>
                  {t(`${action}.description`, {
                    net: formatKES(variation.totals.netMinor),
                    effect: formatKES(variation.grandTotalEffectMinor),
                    version: variation.latestVersion.versionNo,
                    next: variation.baseVersion.versionNo + 1,
                  })}
                </DialogDescription>
              </DialogHeader>
              {failure ? (
                <p role="alert" className="text-sm text-destructive">
                  {failure}
                </p>
              ) : null}
              {WITH_DIGEST.has(action) && variation.snapshot ? (
                <p className="text-xs text-muted-foreground">
                  {t("snapshot", { digest: variation.snapshot.digest.slice(0, 12) })}
                </p>
              ) : null}
              {needsReason ? (
                <Field>
                  <FieldLabel htmlFor="variation-reason">{t("reason")}</FieldLabel>
                  <Textarea
                    id="variation-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={REASON_LIMITS.max}
                    rows={3}
                    required
                  />
                  <FieldDescription>{t("reasonHint")}</FieldDescription>
                </Field>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAction(null)}>
                  {t("close")}
                </Button>
                <Button
                  type="button"
                  variant={action === "reject" || action === "cancel" ? "destructive" : "default"}
                  disabled={busy || (needsReason && reason.trim().length < REASON_LIMITS.min)}
                  onClick={() => void run(action)}
                >
                  {t(`${action}.confirm`, {
                    version: variation.latestVersion.versionNo,
                    next: variation.baseVersion.versionNo + 1,
                  })}
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
