"use client";

import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const palette = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function SpendByCategoryChart({
  data,
}: {
  data: { key: string; label: string; amount: number }[];
}) {
  const config = Object.fromEntries(
    data.map((d, i) => [d.key, { label: d.label, color: palette[i % palette.length] }]),
  ) satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="aspect-auto h-72 w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16 }} accessibilityLayer>
        <CartesianGrid horizontal={false} />
        <YAxis
          dataKey="label"
          type="category"
          tickLine={false}
          axisLine={false}
          width={116}
          tick={{ fontSize: 12 }}
        />
        <XAxis
          type="number"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideIndicator
              formatter={(value) => (
                <span className="font-mono font-medium tabular-nums">{`KES ${Number(value).toLocaleString("en-KE")}`}</span>
              )}
            />
          }
        />
        <Bar dataKey="amount" radius={4}>
          {data.map((d, i) => (
            <Cell key={d.key} fill={palette[i % palette.length]} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
