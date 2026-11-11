"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/**
 * Net price per base unit over time, one line per supplier (corrected prices left out). Values
 * are shillings for plotting only; the table beside it shows the exact amounts.
 */
export function PriceHistoryChart({
  points,
  suppliers,
  title,
  unitLabel,
}: {
  points: { date: string; label: string; supplierId: string; shillings: number }[];
  suppliers: { id: string; name: string }[];
  title: string;
  unitLabel: string;
}) {
  const keys = suppliers.map((supplier, index) => ({ ...supplier, key: `s${index}` }));
  const config = Object.fromEntries(
    keys.map((entry, index) => [
      entry.key,
      { label: entry.name, color: COLORS[index % COLORS.length]! },
    ]),
  ) satisfies ChartConfig;
  const dates = [...new Set(points.map((point) => point.date))].sort();
  const data = dates.map((date) => {
    const row: Record<string, string | number> = {
      date: points.find((point) => point.date === date)!.label,
    };
    for (const entry of keys) {
      const point = points.findLast(
        (candidate) => candidate.date === date && candidate.supplierId === entry.id,
      );
      if (point) row[entry.key] = point.shillings;
    }
    return row;
  });

  return (
    <figure aria-label={title}>
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <LineChart data={data} margin={{ left: 0, right: 12, top: 8 }} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={56} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => (
                  <div className="flex w-full items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      {config[name as keyof typeof config]?.label}
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {`KES ${Number(value).toFixed(2)} / ${unitLabel}`}
                    </span>
                  </div>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {keys.map((entry) => (
            <Line
              key={entry.key}
              dataKey={entry.key}
              type="stepAfter"
              stroke={`var(--color-${entry.key})`}
              strokeWidth={2}
              dot
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </figure>
  );
}
