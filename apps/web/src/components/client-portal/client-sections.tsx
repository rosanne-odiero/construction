import { getLocale, getTranslations } from "next-intl/server";
import type { MilestoneStatus } from "@pm-buddy/types";
import type { z } from "zod";
import type { clientDiaryEntrySchema, clientMilestoneEntrySchema } from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { formatCalendarDate } from "@/lib/format";

const milestoneTones: Record<MilestoneStatus, Tone> = {
  planned: "neutral",
  in_progress: "info",
  achieved: "success",
  cancelled: "danger",
};

/** The project's milestones with their status (due or achieved dates). */
export async function MilestoneList({
  milestones,
}: {
  milestones: z.infer<typeof clientMilestoneEntrySchema>[];
}) {
  const t = await getTranslations("clientPortal.overview");
  const tStatus = await getTranslations("milestoneStatus");
  if (!milestones.length)
    return <p className="text-sm text-muted-foreground">{t("noMilestones")}</p>;
  return (
    <ol className="space-y-3">
      {milestones.map((milestone) => (
        <li key={milestone.id} className="flex items-start justify-between gap-3 text-sm">
          <span>
            <span className="block font-medium">{milestone.name}</span>
            <span className="text-muted-foreground">
              {milestone.actualDate
                ? t("achievedOn", { date: formatCalendarDate(milestone.actualDate) })
                : t("dueOn", { date: formatCalendarDate(milestone.dueDate) })}
            </span>
          </span>
          <StatusBadge tone={milestoneTones[milestone.status] ?? "neutral"}>
            {tStatus(milestone.status)}
          </StatusBadge>
        </li>
      ))}
    </ol>
  );
}

/**
 * One approved site diary: the work done, weather, delays and the workforce as a count (by trade
 * when attendance supplied it) — never workers' names or records (Kenya DPA).
 */
export async function DiaryEntry({ diary }: { diary: z.infer<typeof clientDiaryEntrySchema> }) {
  const t = await getTranslations("clientPortal.diaries");
  const locale = await getLocale();
  return (
    <article
      aria-label={`${diary.siteName} ${formatCalendarDate(diary.date)}`}
      className="space-y-2 rounded-md border bg-background p-3"
    >
      <h3 className="text-sm font-semibold">
        {formatCalendarDate(diary.date)} · {diary.siteName}
      </h3>
      <p className="text-sm break-words whitespace-pre-wrap">{diary.workPerformed}</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("workforce")}</dt>
          <dd>
            {diary.workforceCount ?? t("notRecorded")}
            {diary.workforce?.trades.length ? (
              <span className="block text-muted-foreground">
                {diary.workforce.trades
                  .map(
                    (trade) =>
                      `${locale === "sw" ? trade.nameSw : trade.nameEn} ${trade.headcount}`,
                  )
                  .join(" · ")}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("weather")}</dt>
          <dd className="break-words">{diary.weather || t("notRecorded")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("delays")}</dt>
          <dd className="break-words whitespace-pre-wrap">{diary.delays || t("notRecorded")}</dd>
        </div>
      </dl>
    </article>
  );
}
