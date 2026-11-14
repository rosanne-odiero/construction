import { getTranslations } from "next-intl/server";
import { formatCalendarDate, formatKESCompact } from "@/lib/format";
import { forecastGeometry, type ChartWeek } from "@/lib/spending";

/**
 * The weekly forecast as a plain SVG (no chart library): money in above the line, money out below
 * it and the closing balance as a line. Decorative summary only — the table beside it carries the
 * exact amounts, so the image has a text alternative and is not the only source.
 */
export async function ForecastChart({ weeks, label }: { weeks: ChartWeek[]; label: string }) {
  const t = await getTranslations("spending.forecast.chart");
  const chart = forecastGeometry(weeks);
  const first = weeks[0];
  const last = weeks.at(-1);
  return (
    <figure className="space-y-2">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="h-auto w-full max-w-full rounded-xl border bg-card"
        preserveAspectRatio="none"
      >
        <title>{label}</title>
        <line
          x1={0}
          x2={chart.width}
          y1={chart.zeroY}
          y2={chart.zeroY}
          className="stroke-border"
          strokeWidth={1}
        />
        {chart.bars.map((bar) => (
          <g key={bar.start}>
            {bar.inHeight > 0 ? (
              <rect
                x={bar.x}
                y={bar.inY}
                width={bar.width}
                height={bar.inHeight}
                className="fill-success/70"
              />
            ) : null}
            {bar.outHeight > 0 ? (
              <rect
                x={bar.x}
                y={bar.outY}
                width={bar.width}
                height={bar.outHeight}
                className="fill-destructive/60"
              />
            ) : null}
          </g>
        ))}
        {chart.line ? (
          <polyline points={chart.line} fill="none" className="stroke-primary" strokeWidth={2} />
        ) : null}
        {chart.points.map((point) => (
          <circle key={point.start} cx={point.x} cy={point.y} r={3} className="fill-primary" />
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-sm bg-success/70" /> {t("in")}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-sm bg-destructive/60" />{" "}
          {t("out")}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-primary" /> {t("closing")}
        </span>
        {first && last ? (
          <span>
            {t("range", {
              from: formatCalendarDate(first.start),
              to: formatCalendarDate(last.start),
            })}
          </span>
        ) : null}
        {weeks.some((week) => week.closingMinor !== null) ? (
          <span>
            {t("lowest", {
              amount: formatKESCompact(
                Math.min(
                  ...weeks.flatMap((week) =>
                    week.closingMinor === null ? [] : [week.closingMinor],
                  ),
                ),
              ),
            })}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
