"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BookmarkPlus, X } from "lucide-react";
import {
  labourViewResponseSchema,
  messageResponseSchema,
  type LabourViewFilters,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
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
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

/** Saves the current registry filters as a view for this user (labour_saved_views). */
export function SaveViewButton({ filters }: { filters: LabourViewFilters }) {
  const t = useTranslations("labourLive.views");
  const problem = useProblemMessage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest("/labour/views", labourViewResponseSchema, {
        method: "POST",
        body: { name: name.trim(), filters },
      });
      setOpen(false);
      setName("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BookmarkPlus aria-hidden /> {t("save")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("saveTitle")}</DialogTitle>
            <DialogDescription>{t("saveHint")}</DialogDescription>
          </DialogHeader>
          <form
            id="save-view-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="space-y-3"
          >
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
            <Field>
              <FieldLabel htmlFor="view-name">{t("name")}</FieldLabel>
              <Input
                id="view-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={60}
                required
                aria-describedby="view-name-hint"
              />
              <FieldDescription id="view-name-hint">{t("nameHint")}</FieldDescription>
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="save-view-form" disabled={busy || name.trim().length < 2}>
              {t("saveSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DeleteViewButton({ id, name }: { id: string; name: string }) {
  const t = useTranslations("labourLive.views");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="ml-0.5 size-8"
      disabled={busy}
      aria-label={t("delete", { name })}
      onClick={() => {
        setBusy(true);
        void liveRequest(`/labour/views/${id}`, messageResponseSchema, { method: "DELETE" })
          .then(() => router.refresh())
          .finally(() => setBusy(false));
      }}
    >
      <X aria-hidden />
    </Button>
  );
}
