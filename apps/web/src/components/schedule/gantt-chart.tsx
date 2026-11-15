"use client";

import { useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ScheduleItem, ScheduleResponse } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import {
  barGeometry,
  dayX,
  dependencyPath,
  ganttRange,
  HEADER_HEIGHT,
  itemLabel,
  monthStarts,
  restDays,
  ROW_HEIGHT,
  weekStarts,
  ZOOMS,
  type Zoom,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { VarianceBadge } from "./variance-badge";

const keyOf = (item: Pick<ScheduleItem, "kind" | "id">) => `${item.kind}:${item.id}`;

/**
 * The Gantt chart (D6.2), drawn in SVG: planned (forecast) bars, the critical path in red, actual
 * dates as a thin dark bar, the baseline as a grey ghost, milestones as diamonds, dependency
 * arrows and today's line (Africa/Nairobi). The SVG is decorative for assistive technology: the
 * item list beside it is keyboard operable (arrow keys, Enter) and the schedule table below
 * carries the same data. The chart scrolls sideways inside its own labelled, focusable region,
 * so the page never scrolls sideways on a phone.
 */
export function GanttChart({
  schedule,
  onEdit,
}: {
  schedule: ScheduleResponse;
  onEdit?: (item: ScheduleItem) => void;
}) {
  const t = useTranslations("schedule.gantt");
  const tStatus = useTranslations("schedule.status");
  const locale = useLocale();
  const [zoom, setZoom] = useState<Zoom>("week");
  const [selected, setSelected] = useState<string | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const { items } = schedule;
  const range = useMemo(() => ganttRange(schedule), [schedule]);
  const dayWidth = ZOOMS[zoom];
  const width = range.days * dayWidth;
  const height = HEADER_HEIGHT + Math.max(items.length, 1) * ROW_HEIGHT;
  const monthLabel = new Intl.DateTimeFormat(locale === "sw" ? "sw-KE" : "en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  const geometry = items.map((item, index) => {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;
    if (item.kind === "milestone") {
      const cx = dayX(range, item.planned.finish, zoom) + dayWidth;
      return { y, x: cx - 7, width: 14, cx };
    }
    const bar = barGeometry(range, item.planned.start, item.planned.finish, zoom);
    return { y, ...bar, cx: bar.x };
  });
  const rowOf = new Map(items.map((item, index) => [keyOf(item), index]));
  const todayX = dayX(range, schedule.dataDate, zoom);
  const selectedIndex = selected === null ? -1 : (rowOf.get(selected) ?? -1);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  function choose(index: number) {
    const item = items[index];
    if (!item) return;
    setSelected(keyOf(item));
    const box = geometry[index]!;
    region.current?.scrollTo({ left: Math.max(0, box.x - 4 * dayWidth) });
  }

  function onKey(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next === null || next < 0 || next >= items.length) return;
    event.preventDefault();
    rows.current[next]?.focus();
    choose(next);
  }

  const barClass = (item: ScheduleItem) =>
    item.status === "complete"
      ? "fill-success"
      : item.critical
        ? "fill-destructive"
        : "fill-primary";

  return (
    <section aria-labelledby="gantt-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="gantt-title" className="text-base font-semibold">
          {t("title")}
        </h3>
        <div role="group" aria-label={t("zoom")} className="flex gap-1">
          {(["week", "month"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={zoom === option ? "default" : "outline"}
              aria-pressed={zoom === option}
              onClick={() => setZoom(option)}
            >
              {t(option)}
            </Button>
          ))}
        </div>
      </div>
      <p id="gantt-keys" className="text-xs text-muted-foreground">
        {t("keyboardHint")}
      </p>
      <div className="relative flex min-w-0 overflow-hidden rounded-md border">
        <div className="w-32 shrink-0 border-r bg-background sm:w-60">
          <div
            className="flex items-end border-b bg-muted px-2 pb-1 text-xs font-medium text-muted-foreground"
            style={{ height: HEADER_HEIGHT }}
          >
            {t("itemHeader")}
          </div>
          <ol aria-label={t("rowsLabel")} aria-describedby="gantt-keys">
            {items.map((item, index) => (
              <li
                key={keyOf(item)}
                style={{ height: ROW_HEIGHT }}
                className="border-b last:border-b-0"
              >
                <button
                  ref={(element) => {
                    rows.current[index] = element;
                  }}
                  type="button"
                  aria-current={selectedIndex === index ? "true" : undefined}
                  onClick={() => choose(index)}
                  onKeyDown={(event) => onKey(event, index)}
                  className={cn(
                    "flex h-full w-full items-center gap-1.5 px-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    selectedIndex === index && "bg-accent",
                  )}
                >
                  {item.kind === "milestone" ? (
                    <span aria-hidden className="size-2.5 shrink-0 rotate-45 bg-foreground" />
                  ) : null}
                  {item.code ? <span className="shrink-0 font-mono">{item.code}</span> : null}{" "}
                  <span className="truncate">{item.name}</span>
                  {item.critical ? <span className="sr-only">{t("criticalSuffix")}</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div
          ref={region}
          role="region"
          aria-label={t("region")}
          tabIndex={0}
          className="relative min-w-0 flex-1 overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            width={width}
            height={height}
            aria-hidden="true"
            focusable="false"
            className="block text-muted-foreground"
          >
            <defs>
              <marker
                id="gantt-arrow"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L6,3 L0,6 z" className="fill-muted-foreground" />
              </marker>
              <marker
                id="gantt-arrow-critical"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L6,3 L0,6 z" className="fill-destructive" />
              </marker>
            </defs>
            <rect x={0} y={0} width={width} height={HEADER_HEIGHT} className="fill-muted" />
            {zoom === "week"
              ? restDays(range, schedule.calendar.workingWeekdays).map((date) => (
                  <rect
                    key={date}
                    x={dayX(range, date, zoom)}
                    y={HEADER_HEIGHT}
                    width={dayWidth}
                    height={height - HEADER_HEIGHT}
                    className="fill-muted/70"
                  />
                ))
              : null}
            {selectedIndex >= 0 ? (
              <rect
                x={0}
                y={HEADER_HEIGHT + selectedIndex * ROW_HEIGHT}
                width={width}
                height={ROW_HEIGHT}
                className="fill-accent"
              />
            ) : null}
            {items.map((item, index) => (
              <line
                key={`row-${keyOf(item)}`}
                x1={0}
                x2={width}
                y1={HEADER_HEIGHT + (index + 1) * ROW_HEIGHT - 0.5}
                y2={HEADER_HEIGHT + (index + 1) * ROW_HEIGHT - 0.5}
                className="stroke-border"
              />
            ))}
            {weekStarts(range).map((date) => {
              const x = dayX(range, date, zoom);
              return (
                <g key={`week-${date}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={HEADER_HEIGHT - 12}
                    y2={height}
                    className="stroke-border"
                  />
                  {zoom === "week" ? (
                    <text
                      x={x + 3}
                      y={HEADER_HEIGHT - 4}
                      className="fill-muted-foreground text-[10px]"
                    >
                      {Number(date.slice(8))}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {monthStarts(range).map((date) => {
              const x = dayX(range, date, zoom);
              return (
                <g key={`month-${date}`}>
                  <line x1={x} x2={x} y1={0} y2={height} className="stroke-muted-foreground/40" />
                  <text x={x + 4} y={16} className="fill-foreground text-[11px] font-medium">
                    {monthLabel.format(new Date(`${date}T00:00:00Z`))}
                  </text>
                </g>
              );
            })}
            {schedule.dependencies.map((dependency) => {
              const from = rowOf.get(keyOf(dependency.predecessor));
              const to = rowOf.get(keyOf(dependency.successor));
              if (from === undefined || to === undefined) return null;
              const a = geometry[from]!;
              const b = geometry[to]!;
              return (
                <path
                  key={dependency.id}
                  data-kind="link"
                  data-critical={dependency.critical}
                  d={dependencyPath(
                    dependency.type,
                    { x: a.x, width: a.width, y: a.y + ROW_HEIGHT / 2 },
                    { x: b.x, width: b.width, y: b.y + ROW_HEIGHT / 2 },
                  )}
                  fill="none"
                  strokeWidth={dependency.critical ? 1.8 : 1}
                  className={dependency.critical ? "stroke-destructive" : "stroke-muted-foreground"}
                  markerEnd={
                    dependency.critical ? "url(#gantt-arrow-critical)" : "url(#gantt-arrow)"
                  }
                />
              );
            })}
            {items.map((item, index) => {
              const box = geometry[index]!;
              const midY = box.y + ROW_HEIGHT / 2;
              if (item.kind === "milestone") {
                const base = item.baseline
                  ? dayX(range, item.baseline.finish, zoom) + dayWidth
                  : null;
                return (
                  <g key={keyOf(item)}>
                    {base !== null ? (
                      <path
                        data-kind="baseline"
                        d={`M ${base} ${midY - 5} L ${base + 5} ${midY} L ${base} ${midY + 5} L ${base - 5} ${midY} Z`}
                        className="fill-none stroke-muted-foreground"
                        strokeDasharray="2 2"
                      />
                    ) : null}
                    <path
                      data-kind="milestone"
                      data-critical={item.critical}
                      d={`M ${box.cx} ${midY - 7} L ${box.cx + 7} ${midY} L ${box.cx} ${midY + 7} L ${box.cx - 7} ${midY} Z`}
                      className={barClass(item)}
                    />
                  </g>
                );
              }
              const baseline = item.baseline
                ? barGeometry(range, item.baseline.start, item.baseline.finish, zoom)
                : null;
              const actual = item.actualStart
                ? barGeometry(range, item.actualStart, item.actualFinish ?? schedule.dataDate, zoom)
                : null;
              return (
                <g key={keyOf(item)}>
                  {baseline ? (
                    <rect
                      data-kind="baseline"
                      x={baseline.x}
                      y={box.y + 27}
                      width={baseline.width}
                      height={5}
                      rx={1}
                      className="fill-muted-foreground/35 stroke-muted-foreground/60"
                    />
                  ) : null}
                  <rect
                    data-kind="bar"
                    data-critical={item.critical}
                    x={box.x}
                    y={box.y + 11}
                    width={box.width}
                    height={14}
                    rx={3}
                    className={barClass(item)}
                  />
                  {actual ? (
                    <rect
                      data-kind="actual"
                      x={actual.x}
                      y={box.y + 4}
                      width={actual.width}
                      height={4}
                      rx={1}
                      className="fill-foreground"
                    />
                  ) : null}
                </g>
              );
            })}
            <line
              data-kind="today"
              x1={todayX}
              x2={todayX}
              y1={HEADER_HEIGHT - 10}
              y2={height}
              strokeDasharray="4 3"
              strokeWidth={1.5}
              className="stroke-warning"
            />
            <text
              x={todayX + 3}
              y={HEADER_HEIGHT - 16}
              className="fill-warning text-[10px] font-semibold"
            >
              {t("today")}
            </text>
          </svg>
        </div>
      </div>
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label={t("legendLabel")}
      >
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-5 rounded-sm bg-primary" />
          {t("legend.planned")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-5 rounded-sm bg-destructive" />
          {t("legend.critical")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-5 rounded-sm bg-success" />
          {t("legend.complete")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-1 w-5 rounded-sm bg-foreground" />
          {t("legend.actual")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-5 rounded-sm bg-muted-foreground/40" />
          {t("legend.baseline")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rotate-45 bg-primary" />
          {t("legend.milestone")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0 border-l-2 border-dashed border-warning" />
          {t("legend.today", { date: formatCalendarDate(schedule.dataDate) })}
        </li>
      </ul>
      <div aria-live="polite" className="min-h-6">
        {selectedItem ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <span className="font-medium">{itemLabel(selectedItem)}</span>
            <StatusBadge tone="neutral">{tStatus(selectedItem.status)}</StatusBadge>
            {selectedItem.critical ? (
              <StatusBadge tone="danger">{t("critical")}</StatusBadge>
            ) : null}
            <span>
              {t("plannedRange", {
                start: formatCalendarDate(selectedItem.planned.start),
                finish: formatCalendarDate(selectedItem.planned.finish),
              })}
            </span>
            <VarianceBadge
              days={selectedItem.variance.finishDays}
              inBaseline={!schedule.baseline || selectedItem.baseline !== null}
            />
            {onEdit && selectedItem.permissions.canEdit ? (
              <Button size="sm" variant="outline" onClick={() => onEdit(selectedItem)}>
                {t("edit")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
