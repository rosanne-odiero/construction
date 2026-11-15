"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FormError } from "@/components/schedule/use-schedule-mutation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/** The text of a form field, trimmed. */
export const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export const checkboxClass =
  "size-4 shrink-0 rounded border-input accent-primary focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** A small dialog asking for a reason (void, cancel, send back, retire, remove). */
export function ReasonDialog({
  open,
  title,
  hint,
  busy,
  error,
  onOpenChange,
  onSubmit,
  confirmLabel,
}: {
  open: boolean;
  title: string;
  hint?: string;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
  confirmLabel?: string;
}) {
  const t = useTranslations("safety");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hint ? <DialogDescription>{hint}</DialogDescription> : null}
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(field(new FormData(event.currentTarget), "reason"));
          }}
        >
          <FormError message={error} />
          <Field>
            <FieldLabel htmlFor="safety-reason">{t("actions.reasonLabel")}</FieldLabel>
            <Textarea id="safety-reason" name="reason" maxLength={500} required />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {confirmLabel ?? t("actions.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Newest" / "Older" (or "First page" / "More") links for a server-paged list. */
export function Pager({
  label,
  firstHref,
  nextHref,
  offset = false,
}: {
  label: string;
  firstHref: string | null;
  nextHref: string | null;
  offset?: boolean;
}) {
  const t = useTranslations("safety.filters");
  if (!firstHref && !nextHref) return null;
  return (
    <nav aria-label={label} className="flex flex-wrap gap-4 text-sm">
      {firstHref ? (
        <Link className="underline" href={firstHref}>
          {offset ? t("first") : t("newest")}
        </Link>
      ) : null}
      {nextHref ? (
        <Link className="underline" href={nextHref}>
          {offset ? t("next") : t("older")}
        </Link>
      ) : null}
    </nav>
  );
}
