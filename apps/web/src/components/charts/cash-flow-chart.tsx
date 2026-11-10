"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export function CashFlowChart({
  data,
  labels,
}: {
  data: { week: string; inflow: number; outflow: number }[];
  labels: { inflow: string; outflow: string; weekOf: string };
}) {
  const config = {
    inflow: { label: labels.inflow, color: "var(--chart-2)" },
    outflow: { label: labels.outflow, color: "var(--chart-4)" },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="week" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={(v: number) => `${v}M`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => `${labels.weekOf} ${String(value)}`}
              formatter={(value, name) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {config[name as keyof typeof config]?.label}
                  </span>
                  <span className="font-mono font-medium tabular-nums">{`KES ${Number(value).toFixed(2)}M`}</span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="inflow" fill="var(--color-inflow)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="outflow" fill="var(--color-outflow)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
