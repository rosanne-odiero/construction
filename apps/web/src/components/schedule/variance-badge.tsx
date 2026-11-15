"use client";

import { useTranslations } from "next-intl";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { varianceView } from "@/lib/schedule";

const tones = { unavailable: "neutral", on: "success", late: "danger", early: "info" } as const;

/**
 * Variance in working days against the baseline: "3 working days late", "On baseline", "2 working
 * days early" or "Unavailable" (no baseline, or the item was not in it). Sentence badges wrap.
 */
export function VarianceBadge({
  days,
  inBaseline = true,
}: {
  days: number | null;
  /** False when a baseline exists but this item was added after it. */
  inBaseline?: boolean;
}) {
  const t = useTranslations("schedule.variance");
  const view = varianceView(days);
  const tone: Tone = tones[view.kind];
  const text =
    view.kind === "unavailable"
      ? inBaseline
        ? t("unavailable")
        : t("notInBaseline")
      : view.kind === "on"
        ? t("on")
        : t(view.kind, { days: view.days });
  return (
    <StatusBadge tone={tone} className="h-auto whitespace-normal text-left">
      {text}
    </StatusBadge>
  );
}
