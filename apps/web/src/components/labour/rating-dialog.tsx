"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { RATING_COMMENT_MAX_LENGTH, RATING_CRITERIA, type RatingCriterion } from "@pm-buddy/types";
import { ratingResponseSchema, type LabourerRating } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { RATING_SCALE, scaleKey } from "@/lib/ratings";
import { cn } from "@/lib/utils";
import { ActionDialog } from "./action-dialog";

type Scores = Partial<Record<RatingCriterion, number>>;

/**
 * Rates a worker's day (or corrects the caller's own rating of today): a 1–5 star choice per
 * criterion and an optional comment. Saved only by the API; the page is then refreshed from it.
 */
export function RateWorkerButton({
  projectId,
  projectName,
  date,
  worker,
  rating,
}: {
  projectId: string;
  projectName: string;
  date: string;
  worker: { id: string; fullName: string };
  rating: LabourerRating | null;
}) {
  const t = useTranslations("labourLive.ratings");
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState<Scores>({});
  const [comment, setComment] = useState("");
  const complete = RATING_CRITERIA.every((criterion) => scores[criterion] !== undefined);
  const name = worker.fullName;

  const start = () => {
    setScores(rating ? { ...rating.scores } : {});
    setComment(rating?.comment ?? "");
    setOpen(true);
  };
  const save = async () => {
    const body = { scores, comment: comment.trim() || null };
    if (rating)
      await liveRequest(`/labour/ratings/${rating.id}`, ratingResponseSchema, {
        method: "PATCH",
        body: { version: rating.version, ...body },
      });
    else
      await liveRequest(`/labour/projects/${projectId}/ratings`, ratingResponseSchema, {
        method: "POST",
        body: { labourerId: worker.id, workDate: date, ...body },
      });
    router.refresh();
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={rating ? "outline" : "default"}
        aria-label={
          rating ? t("actions.changeWorker", { name }) : t("actions.rateWorker", { name })
        }
        onClick={start}
      >
        {rating ? t("actions.change") : t("actions.rate")}
      </Button>
      <ActionDialog
        id={`rate-${id}`}
        open={open}
        onOpenChange={setOpen}
        title={rating ? t("dialog.changeTitle", { name }) : t("dialog.rateTitle", { name })}
        description={t("dialog.description", {
          date: formatCalendarDate(date),
          project: projectName,
        })}
        submitLabel={rating ? t("dialog.saveChange") : t("dialog.save")}
        submitDisabled={!complete}
        onSubmit={save}
      >
        {RATING_CRITERIA.map((criterion) => (
          <StarField
            key={criterion}
            criterion={criterion}
            value={scores[criterion]}
            onChange={(value) => setScores((current) => ({ ...current, [criterion]: value }))}
          />
        ))}
        {complete ? null : <p className="text-sm text-muted-foreground">{t("dialog.required")}</p>}
        <Field>
          <FieldLabel htmlFor={`rate-${id}-comment`}>{t("dialog.comment")}</FieldLabel>
          <Textarea
            id={`rate-${id}-comment`}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={RATING_COMMENT_MAX_LENGTH}
            rows={3}
            aria-describedby={`rate-${id}-comment-hint`}
          />
          <FieldDescription id={`rate-${id}-comment-hint`}>
            {t("dialog.commentHint")} {rating ? null : t("dialog.changeNote")}
          </FieldDescription>
        </Field>
      </ActionDialog>
    </>
  );
}

/** One criterion as a radio group of five stars (arrow keys move between scores). */
function StarField({
  criterion,
  value,
  onChange,
}: {
  criterion: RatingCriterion;
  value: number | undefined;
  onChange: (value: number) => void;
}) {
  const t = useTranslations("labourLive.ratings");
  const labelId = useId();
  const label = (score: number) => t("score", { score, label: t(`scale.${scaleKey(score)}`) });
  return (
    <div className="space-y-1.5">
      <p id={labelId} className="text-sm font-medium">
        {t(`criteria.${criterion}`)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <RadioGroupPrimitive.Root
          aria-labelledby={labelId}
          value={value === undefined ? "" : String(value)}
          onValueChange={(next) => onChange(Number(next))}
          orientation="horizontal"
          className="flex gap-1"
        >
          {RATING_SCALE.map((key, index) => {
            const score = index + 1;
            return (
              <RadioGroupPrimitive.Item
                key={key}
                value={String(score)}
                aria-label={label(score)}
                className="rounded-md p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Star
                  aria-hidden
                  className={cn(
                    "size-6",
                    value !== undefined && score <= value
                      ? "fill-warning text-warning"
                      : "text-muted-foreground",
                  )}
                />
              </RadioGroupPrimitive.Item>
            );
          })}
        </RadioGroupPrimitive.Root>
        <span aria-hidden className="text-sm text-muted-foreground">
          {value === undefined ? t("scale.none") : label(value)}
        </span>
      </div>
    </div>
  );
}
