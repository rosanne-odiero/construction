import { getTranslations } from "next-intl/server";
import { formatCalendarDate, formatKESCompact } from "@/lib/format";
import { curveGeometry, type CurvePointInput } from "@/lib/valuations";

const SERIES = {
  pv: { stroke: "stroke-muted-foreground", swatch: "bg-muted-foreground", dash: "6 4" },
  ev: { stroke: "stroke-primary", swatch: "bg-primary", dash: undefined },
  ac: { stroke: "stroke-warning", swatch: "bg-warning", dash: "2 3" },
} as const;

/**
 * The weekly S-curve as a plain SVG (no chart library): planned (dashed), earned and actual
 * cumulative values. The table beside it carries every figure, so the image is a summary with a
 * text alternative, never the only source.
 */
export async function SCurve({ points, label }: { points: CurvePointInput[]; label: string }) {
  const t = await getTranslations("valuations.evm.chart");
  const chart = curveGeometry(points);
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
          x1={20}
          x2={chart.width - 20}
          y1={chart.height - 20}
          y2={chart.height - 20}
          className="stroke-border"
          strokeWidth={1}
        />
        {chart.lines.map((line) =>
          line.points ? (
            <polyline
              key={line.key}
              points={line.points}
              fill="none"
              className={SERIES[line.key].stroke}
              strokeWidth={2}
              strokeDasharray={SERIES[line.key].dash}
            />
          ) : null,
        )}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(["pv", "ev", "ac"] as const).map((key) => (
          <span key={key} className="flex items-center gap-1">
            <span aria-hidden className={`inline-block h-0.5 w-4 ${SERIES[key].swatch}`} /> {t(key)}
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
