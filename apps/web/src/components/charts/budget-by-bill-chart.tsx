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

export interface BillBudgetPoint {
  bill: string;
  title: string;
  budget: number;
  earned: number;
  actual: number;
}

export function BudgetByBillChart({
  data,
  labels,
}: {
  data: BillBudgetPoint[];
  labels: { budget: string; earned: string; actual: string; bill: string };
}) {
  const config = {
    budget: { label: labels.budget, color: "var(--chart-planned)" },
    earned: { label: labels.earned, color: "var(--chart-1)" },
    actual: { label: labels.actual, color: "var(--chart-4)" },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} barGap={2} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bill"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: string) => `${labels.bill} ${v}`}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v: number) => `${v}M`}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const point = payload?.[0]?.payload as BillBudgetPoint | undefined;
                return point ? `${labels.bill} ${point.bill}: ${point.title}` : "";
              }}
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
        <Bar dataKey="budget" fill="var(--color-budget)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="earned" fill="var(--color-earned)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="actual" fill="var(--color-actual)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
