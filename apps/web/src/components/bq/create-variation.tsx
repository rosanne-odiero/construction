"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { variationResponseSchema, type Instruction } from "@pm-buddy/validation";
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
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";

/** Raises a draft variation against an open instruction (the base is the newest approved BQ). */
export function CreateVariationButton({
  projectId,
  instructions,
  baseVersionNo,
}: {
  projectId: string;
  instructions: Instruction[];
  /** The newest approved version, which a new variation is based on. */
  baseVersionNo: number | null;
}) {
  const t = useTranslations("variations.create");
  const problem = useProblemMessage();
  const router = useRouter();
  const open = instructions.filter((entry) => entry.status === "open");
  const [show, setShow] = useState(false);
  const [instructionId, setInstructionId] = useState(open[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      const { variation } = await liveRequest(
        `/projects/${projectId}/bq/variations`,
        variationResponseSchema,
        {
          method: "POST",
          body: { instructionId, title: title.trim(), description: description.trim() },
        },
      );
      router.push(`/projects/${projectId}/bq/variations/${variation.id}`);
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setShow(true)}>
        <Plus aria-hidden /> {t("open")}
      </Button>
      <Dialog open={show} onOpenChange={setShow}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {baseVersionNo !== null ? (
            <p className="text-sm">{t("baseVersion", { version: baseVersionNo })}</p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {open.length ? (
            <form
              id="create-variation"
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Field>
                <FieldLabel htmlFor="variation-instruction">{t("instruction")}</FieldLabel>
                <select
                  id="variation-instruction"
                  value={instructionId}
                  onChange={(event) => setInstructionId(event.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  required
                >
                  {open.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.number} · {entry.subject}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="variation-title">{t("titleLabel")}</FieldLabel>
                <Input
                  id="variation-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  minLength={3}
                  maxLength={200}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="variation-description">{t("descriptionLabel")}</FieldLabel>
                <Textarea
                  id="variation-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={4000}
                  rows={3}
                />
                <FieldDescription>{t("baseNote")}</FieldDescription>
              </Field>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noInstructions")}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShow(false)}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              form="create-variation"
              disabled={busy || !open.length || title.trim().length < 3}
            >
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
