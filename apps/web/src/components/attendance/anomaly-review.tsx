"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ANOMALY_DECISIONS, type AnomalyDecision } from "@pm-buddy/types";
import { anomalyResponseSchema, type Anomaly } from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { attendanceCommand } from "@/lib/attendance";

/**
 * Resolve (the attendance was checked and is right, or was corrected) or dismiss (not a problem)
 * an open anomaly with a note. Someone who recorded the attendance cannot review it (API rule).
 */
export function AnomalyReview({ anomaly }: { anomaly: Anomaly }) {
  const t = useTranslations("attendanceLive.anomalies");
  const tl = useTranslations("attendanceLive");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<AnomalyDecision>("resolve");
  const [note, setNote] = useState("");
  const id = `review-${anomaly.id}`;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label={t("reviewFor", {
          name: anomaly.fullName,
          kind: tl(`anomalyKind.${anomaly.kind}`),
        })}
      >
        {t("review")}
      </Button>
      <ActionDialog
        id={id}
        open={open}
        onOpenChange={(next) => {
          if (!next) setNote("");
          setOpen(next);
        }}
        title={t("reviewTitle", { name: anomaly.fullName })}
        description={tl(`anomalyKind.${anomaly.kind}`)}
        submitLabel={t(`decisions.${decision}`)}
        submitDisabled={note.trim().length < 10}
        onSubmit={async () => {
          await attendanceCommand(
            `/attendance/anomalies/${anomaly.id}/review`,
            anomalyResponseSchema,
            {
              decision,
              note: note.trim(),
              version: anomaly.version,
            },
          );
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-decision`}>{t("decision")}</FieldLabel>
          <select
            id={`${id}-decision`}
            value={decision}
            onChange={(event) => setDecision(event.target.value as AnomalyDecision)}
            className={selectClass}
          >
            {ANOMALY_DECISIONS.map((value) => (
              <option key={value} value={value}>
                {t(`decisions.${value}`)}
              </option>
            ))}
          </select>
          <FieldDescription>{t(`decisionHints.${decision}`)}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-note`}>{tl("common.reason")}</FieldLabel>
          <Textarea
            id={`${id}-note`}
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            aria-describedby={`${id}-note-hint`}
          />
          <FieldDescription id={`${id}-note-hint`}>{tl("common.reasonHint")}</FieldDescription>
        </Field>
      </ActionDialog>
    </>
  );
}
