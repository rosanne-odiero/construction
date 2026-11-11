"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { allowedProjectTransitions, REASON_LIMITS } from "@pm-buddy/domain";
import { projectResponseSchema, type Project } from "@pm-buddy/validation";
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
import { useProblemMessage } from "./use-problem-message";

/**
 * Lifecycle changes offered from the shared transition table (packages/domain). The API checks
 * the same table, the activation preconditions and the record version again.
 */
export function StatusChangeButton({ project }: { project: Project }) {
  const t = useTranslations("projectDetail.statusDialog");
  const tActions = useTranslations("projectDetail.actions");
  const tStatus = useTranslations("projectStatus");
  const problem = useProblemMessage();
  const router = useRouter();
  const transitions = allowedProjectTransitions(project.status);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(transitions[0]?.to ?? null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!transitions.length) return null;
  const chosen = transitions.find((transition) => transition.to === target) ?? transitions[0]!;

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/projects/${project.id}/status`, projectResponseSchema, {
        method: "POST",
        body: {
          to: chosen.to,
          version: project.version,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", { status: tStatus(project.status) })}
            </DialogDescription>
          </DialogHeader>
          <form
            id="status-form"
            className="space-y-4"
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
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">{t("to")}</legend>
              {transitions.map((transition) => (
                <label key={transition.to} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="status"
                    value={transition.to}
                    checked={chosen.to === transition.to}
                    onChange={() => setTarget(transition.to)}
                    className="size-4 accent-primary"
                  />
                  {tActions(transition.action)} ({tStatus(transition.to)})
                </label>
              ))}
            </fieldset>
            <Field>
              <FieldLabel htmlFor="status-reason">{t("reason")}</FieldLabel>
              <Textarea
                id="status-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={REASON_LIMITS.max}
                required={chosen.reasonRequired}
                aria-describedby="status-reason-hint"
                rows={3}
              />
              <FieldDescription id="status-reason-hint">
                {chosen.reasonRequired ? t("reasonRequired") : t("reasonOptional")}
              </FieldDescription>
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              form="status-form"
              disabled={
                busy ||
                ((chosen.reasonRequired || reason.trim().length > 0) &&
                  reason.trim().length < REASON_LIMITS.min)
              }
            >
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
