"use client";

import { useTranslations } from "next-intl";
import type { ScheduleItem, ScheduleResponse, WbsNode } from "@pm-buddy/validation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import { VarianceBadge } from "./variance-badge";

const statusTones: Record<ScheduleItem["status"], Tone> = {
  not_started: "neutral",
  in_progress: "info",
  complete: "success",
};

/**
 * The schedule as a table: the accessible alternative to the Gantt chart (every date, float,
 * the critical flag, progress and variance), with the row actions the record's permissions allow.
 */
export function ScheduleTable({
  schedule,
  nodes,
  onEdit,
  onProgress,
  onDelete,
}: {
  schedule: ScheduleResponse;
  nodes: WbsNode[];
  onEdit: (item: ScheduleItem) => void;
  onProgress: (item: ScheduleItem) => void;
  onDelete: (item: ScheduleItem) => void;
}) {
  const t = useTranslations("schedule.table");
  const tStatus = useTranslations("schedule.status");
  const tMilestone = useTranslations("milestoneStatus");
  const code = (id: string | null) => nodes.find((node) => node.id === id)?.code ?? "—";
  const anyActions = schedule.items.some(
    (item) => item.permissions.canEdit || item.permissions.canRecordProgress,
  );

  const progress = (item: ScheduleItem) => {
    if (!item.progress) return "—";
    if (item.progress.percentComplete === null) return t("progressUnreported");
    const percent = t("percent", { value: item.progress.percentComplete });
    return item.progress.basis === "quantity"
      ? t("quantityProgress", {
          percent,
          done: item.progress.quantityDone ?? "0",
          total: item.progress.quantityTotal ?? "0",
          unit: item.progress.quantityUnit ?? "",
        })
      : t("physicalProgress", { percent });
  };

  return (
    <section aria-labelledby="schedule-table-title" className="space-y-2">
      <h3 id="schedule-table-title" className="text-base font-semibold">
        {t("title")}
      </h3>
      <div
        role="region"
        aria-label={t("region")}
        tabIndex={0}
        className="relative overflow-x-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full min-w-[68rem] text-sm">
          <caption className="sr-only">{t("caption")}</caption>
          <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="p-2 font-medium">
                {t("item")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("wbs")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("duration")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("planned")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("baseline")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("finishVariance")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("float")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("actual")}
              </th>
              <th scope="col" className="p-2 font-medium">
                {t("progress")}
              </th>
              {anyActions ? (
                <th scope="col" className="p-2 font-medium">
                  <span className="sr-only">{t("actions")}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y">
            {schedule.items.map((item) => (
              <tr key={`${item.kind}:${item.id}`} className="align-top">
                <th scope="row" className="p-2 text-left font-normal">
                  <span className="flex flex-wrap items-center gap-1">
                    {item.code ? <span className="font-mono text-xs">{item.code}</span> : null}{" "}
                    <span className="font-medium">{item.name}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {item.kind === "milestone" ? (
                      <StatusBadge tone="info">{t("milestone")}</StatusBadge>
                    ) : null}
                    <StatusBadge tone={statusTones[item.status]}>
                      {tStatus(item.status)}
                    </StatusBadge>
                    {item.critical ? (
                      <StatusBadge tone="danger">{t("critical")}</StatusBadge>
                    ) : null}
                  </span>
                  {item.bqItem ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t("bqItem", {
                        ref: item.bqItem.ref ?? "—",
                        description: item.bqItem.description,
                      })}
                    </span>
                  ) : null}
                  {item.milestoneStatus ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t("milestoneDue", {
                        date: formatCalendarDate(item.dueDate ?? item.planned.finish),
                        status: tMilestone(item.milestoneStatus),
                      })}
                    </span>
                  ) : null}
                </th>
                <td className="p-2 font-mono text-xs">{code(item.wbsNodeId)}</td>
                <td className="whitespace-nowrap p-2 tabular-nums">
                  {item.kind === "task" ? t("days", { days: item.durationDays }) : "—"}
                </td>
                <td className="whitespace-nowrap p-2 tabular-nums">
                  {item.kind === "milestone"
                    ? formatCalendarDate(item.planned.finish)
                    : t("range", {
                        start: formatCalendarDate(item.planned.start),
                        finish: formatCalendarDate(item.planned.finish),
                      })}
                  {item.startNoEarlierThan ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("notBefore", { date: formatCalendarDate(item.startNoEarlierThan) })}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap p-2 tabular-nums">
                  {item.baseline
                    ? item.kind === "milestone"
                      ? formatCalendarDate(item.baseline.finish)
                      : t("range", {
                          start: formatCalendarDate(item.baseline.start),
                          finish: formatCalendarDate(item.baseline.finish),
                        })
                    : "—"}
                </td>
                <td className="p-2">
                  <VarianceBadge
                    days={item.variance.finishDays}
                    inBaseline={!schedule.baseline || item.baseline !== null}
                  />
                </td>
                <td className="whitespace-nowrap p-2 tabular-nums">
                  {item.totalFloatDays === null ? "—" : t("days", { days: item.totalFloatDays })}
                </td>
                <td className="whitespace-nowrap p-2 tabular-nums">
                  {item.kind === "milestone"
                    ? item.actualFinish
                      ? formatCalendarDate(item.actualFinish)
                      : "—"
                    : item.actualStart
                      ? t("range", {
                          start: formatCalendarDate(item.actualStart),
                          finish: item.actualFinish
                            ? formatCalendarDate(item.actualFinish)
                            : t("ongoing"),
                        })
                      : "—"}
                </td>
                <td className="p-2">{progress(item)}</td>
                {anyActions ? (
                  <td className="p-2">
                    <div className="flex gap-1">
                      {item.permissions.canEdit ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={t("editNamed", { name: item.name })}
                          onClick={() => onEdit(item)}
                        >
                          {t("edit")}
                        </Button>
                      ) : null}
                      {item.permissions.canRecordProgress ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={t("progressNamed", { name: item.name })}
                          onClick={() => onProgress(item)}
                        >
                          {t("recordProgress")}
                        </Button>
                      ) : null}
                      {item.permissions.canDelete ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("deleteNamed", { name: item.name })}
                          onClick={() => onDelete(item)}
                        >
                          {t("delete")}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
