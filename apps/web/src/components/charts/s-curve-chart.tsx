"use client";

import { useLocale } from "next-intl";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface SCurvePoint {
  month: string;
  planned: number;
  actual: number | null;
}

export function SCurveChart({
  data,
  labels,
}: {
  data: SCurvePoint[];
  labels: { planned: string; actual: string };
}) {
  const locale = useLocale();
  const monthFmt = new Intl.DateTimeFormat(locale === "sw" ? "sw-KE" : "en-GB", {
    month: "short",
    year: "2-digit",
    timeZone: "Africa/Nairobi",
  });
  const config = {
    planned: { label: labels.planned, color: "var(--chart-planned)" },
    actual: { label: labels.actual, color: "var(--chart-1)" },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <LineChart data={data} margin={{ left: 0, right: 12, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          tickFormatter={(value: string) => monthFmt.format(new Date(`${value}-15T12:00:00+03:00`))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(value) =>
                monthFmt.format(new Date(`${String(value)}-15T12:00:00+03:00`))
              }
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {config[name as keyof typeof config]?.label}
                  </span>
                  <span className="font-mono font-medium tabular-nums">{`${value}%`}</span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="planned"
          type="monotone"
          stroke="var(--color-planned)"
          strokeWidth={2}
          strokeDasharray="6 4"
          dot={false}
        />
        <Line
          dataKey="actual"
          type="monotone"
          stroke="var(--color-actual)"
          strokeWidth={2.5}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ChartContainer>
  );
}
