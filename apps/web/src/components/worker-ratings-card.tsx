import { useLocale, useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { RATING_CRITERIA } from "@pm-buddy/types";
import type { WorkerRatingsResponse } from "@pm-buddy/validation";
import { RatingStars } from "@/components/labour/rating-stars";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate } from "@/lib/format";
import { formatAverage } from "@/lib/ratings";

/** The labourer portal's "My ratings" (D3.5): scores and comments, never who gave them. */
export function WorkerRatingsCard({ ratings }: { ratings: WorkerRatingsResponse }) {
  const t = useTranslations("portals.worker");
  const tRatings = useTranslations("labourLive.ratings");
  const locale = useLocale();
  const average = (value: number) => formatAverage(value, locale);
  const { summary } = ratings;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Star className="size-5 text-muted-foreground" aria-hidden />
          <h2>{t("ratingsTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!ratings.linked ? (
          <p className="text-muted-foreground">{t("ratingsUnlinked")}</p>
        ) : summary.average === null ? (
          <p className="text-muted-foreground">{t("ratingsNone")}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{t("ratingsIntro")}</p>
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <RatingStars
                value={summary.average}
                label={tRatings("average", { average: average(summary.average) })}
              />
              {t("ratingsSummary", { average: average(summary.average), count: summary.count })}
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
            <ul className="space-y-2">
              {ratings.ratings.map((rating) => (
                <li key={rating.id} className="space-y-1 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {formatCalendarDate(rating.workDate)} · {rating.project.name}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <RatingStars
                        value={rating.average}
                        label={tRatings("average", { average: average(rating.average) })}
                      />
                      <span className="tabular-nums">{average(rating.average)}</span>
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {RATING_CRITERIA.map(
                      (criterion) =>
                        `${tRatings(`criteria.${criterion}`)} ${rating.scores[criterion]}`,
                    ).join(" · ")}
                  </p>
                  {rating.comment ? <p>“{rating.comment}”</p> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
