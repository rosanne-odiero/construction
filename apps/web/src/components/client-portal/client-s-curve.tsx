import { getTranslations } from "next-intl/server";
import type { ClientCurvePoint } from "@pm-buddy/validation";
import { formatCalendarDate, formatKESCompact } from "@/lib/format";
import { curveGeometry } from "@/lib/valuations";

/**
 * The client's S-curve as a plain SVG: planned (dashed) and earned cumulative value at contract
 * rates, never actual cost. The table beside it carries every figure, so the image is a summary
 * with a text alternative, never the only source.
 */
export async function ClientSCurve({ points }: { points: ClientCurvePoint[] }) {
  const t = await getTranslations("clientPortal.progress.chart");
  const chart = curveGeometry(points.map((point) => ({ ...point, acMinor: null })));
  const series = [
    {
      key: "pv",
      label: t("planned"),
      stroke: "stroke-muted-foreground",
      swatch: "bg-muted-foreground",
      dash: "6 4",
    },
    {
      key: "ev",
      label: t("earned"),
      stroke: "stroke-primary",
      swatch: "bg-primary",
      dash: undefined,
    },
  ] as const;
  return (
    <figure className="space-y-2">
      <svg
        role="img"
        aria-label={t("label")}
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="h-auto w-full max-w-full rounded-xl border bg-card"
        preserveAspectRatio="none"
      >
        <title>{t("label")}</title>
        <line
          x1={20}
          x2={chart.width - 20}
          y1={chart.height - 20}
          y2={chart.height - 20}
          className="stroke-border"
          strokeWidth={1}
        />
        {series.map((entry) => {
          const line = chart.lines.find((candidate) => candidate.key === entry.key);
          return line?.points ? (
            <polyline
              key={entry.key}
              points={line.points}
              fill="none"
              className={entry.stroke}
              strokeWidth={2}
              strokeDasharray={entry.dash}
            />
          ) : null;
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((entry) => (
          <span key={entry.key} className="flex items-center gap-1">
            <span aria-hidden className={`inline-block h-0.5 w-4 ${entry.swatch}`} /> {entry.label}
          </span>
        ))}
        {points.length ? (
          <span>
            {t("range", {
              from: formatCalendarDate(points[0]!.weekEnd),
              to: formatCalendarDate(points.at(-1)!.weekEnd),
              top: formatKESCompact(chart.top),
            })}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
