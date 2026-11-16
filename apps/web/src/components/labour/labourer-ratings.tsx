"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { RATING_CRITERIA } from "@pm-buddy/types";
import type { LabourerRatingsResponse } from "@pm-buddy/validation";
import { formatCalendarDate } from "@/lib/format";
import { formatAverage } from "@/lib/ratings";
import { RatingStars } from "./rating-stars";

/**
 * A worker's ratings in the side panel (D3.5): averages and the newest ratings, counting only
 * projects where the caller can view workers.
 */
export function LabourerRatings({ ratings }: { ratings: LabourerRatingsResponse }) {
  const t = useTranslations("labourLive.panel.ratings");
  const tRatings = useTranslations("labourLive.ratings");
  const locale = useLocale();
  const average = (value: number) => formatAverage(value, locale);
  const { summary } = ratings;
  return (
    <section aria-labelledby="panel-ratings" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id="panel-ratings" className="font-semibold">
          {t("title")}
        </h3>
        {ratings.canRate ? (
          <Link href="/labour/ratings" className="text-sm underline underline-offset-4">
            {t("rate")}
          </Link>
        ) : null}
      </div>
      {summary.average === null ? (
        <p className="text-muted-foreground">{t("none")}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <RatingStars
              value={summary.average}
              label={tRatings("average", { average: average(summary.average) })}
            />
            <span>{t("summary", { average: average(summary.average), count: summary.count })}</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            {RATING_CRITERIA.map((criterion) => {
              const value = summary.criteria[criterion];
              return (
                <div key={criterion} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{tRatings(`criteria.${criterion}`)}</dt>
                  <dd className="tabular-nums">{value === null ? "—" : average(value)}</dd>
                </div>
              );
            })}
          </dl>
          <h4 className="pt-1 text-xs font-medium text-muted-foreground">{t("recent")}</h4>
          <ul className="space-y-2">
            {ratings.ratings.map((rating) => (
              <li key={rating.id} className="space-y-1 rounded-md border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {formatCalendarDate(rating.workDate)} ·{" "}
                    <span className="font-mono text-xs">{rating.project.code}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <RatingStars
                      value={rating.average}
                      label={tRatings("average", { average: average(rating.average) })}
                    />
                    <span className="tabular-nums">{average(rating.average)}</span>
                  </span>
                </div>
                {rating.comment ? <p className="text-xs">“{rating.comment}”</p> : null}
                <p className="text-xs text-muted-foreground">{rating.ratedBy.displayName}</p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("scope")}</p>
        </>
      )}
    </section>
  );
}
