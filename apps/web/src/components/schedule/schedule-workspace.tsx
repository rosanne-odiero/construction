"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import type { ScheduleItem, ScheduleResponse, WbsNode } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import { ActivityDialog, DeleteActivityDialog, ProgressDialog } from "./activity-dialogs";
import { CalendarPanel } from "./calendar-panel";
import { DependenciesPanel } from "./dependencies-panel";
import { GanttChart } from "./gantt-chart";
import { ScheduleTable } from "./schedule-table";
import { VarianceBadge } from "./variance-badge";

/** Headline figures: finish against the baseline, progress (with its basis), the critical path. */
export function ScheduleSummary({ schedule }: { schedule: ScheduleResponse }) {
  const t = useTranslations("schedule.summary");
  const critical = schedule.items.filter((item) => item.critical).length;
  const unavailable = <span className="text-muted-foreground">{t("unavailable")}</span>;
  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-md border p-3">
        <dt className="text-xs text-muted-foreground">{t("finish")}</dt>
        <dd className="text-lg font-semibold tabular-nums">
          {schedule.finish ? formatCalendarDate(schedule.finish) : unavailable}
        </dd>
        <dd className="text-xs text-muted-foreground">
          {schedule.start.source === "today"
            ? t("startToday")
            : t("start", { date: formatCalendarDate(schedule.start.date) })}
        </dd>
      </div>
      <div className="rounded-md border p-3">
        <dt className="text-xs text-muted-foreground">{t("baselineFinish")}</dt>
        <dd className="text-lg font-semibold tabular-nums">
          {schedule.projectVariance.baselineFinish
            ? formatCalendarDate(schedule.projectVariance.baselineFinish)
            : unavailable}
        </dd>
        <dd className="text-xs text-muted-foreground">
          {schedule.baseline
            ? t("baselineName", { number: schedule.baseline.number, name: schedule.baseline.name })
            : t("noBaseline")}
        </dd>
      </div>
      <div className="rounded-md border p-3">
        <dt className="text-xs text-muted-foreground">{t("variance")}</dt>
        <dd className="pt-1">
          <VarianceBadge days={schedule.projectVariance.finishDays} />
        </dd>
        <dd className="pt-1 text-xs text-muted-foreground">
          {t("dataDate", { date: formatCalendarDate(schedule.dataDate) })}
        </dd>
      </div>
      <div className="rounded-md border p-3">
        <dt className="text-xs text-muted-foreground">{t("progress")}</dt>
        <dd className="text-lg font-semibold tabular-nums">
          {schedule.progress.ratio === null
            ? unavailable
            : t("percent", { value: Math.floor(schedule.progress.ratio * 1000) / 10 })}
        </dd>
        <dd className="text-xs text-muted-foreground">{t("progressHint")}</dd>
        <dd className="text-xs text-muted-foreground">{t("critical", { count: critical })}</dd>
      </div>
    </dl>
  );
}

/** The Gantt view: summary, chart, table alternative, activity editor, links and calendar. */
export function ScheduleWorkspace({
  projectId,
  schedule,
  nodes,
  canPickBq,
}: {
  projectId: string;
  schedule: ScheduleResponse;
  nodes: WbsNode[];
  canPickBq: boolean;
}) {
  const t = useTranslations("schedule");
  const [editor, setEditor] = useState<{ item: ScheduleItem | null } | null>(null);
  const [progress, setProgress] = useState<ScheduleItem | null>(null);
  const [removing, setRemoving] = useState<ScheduleItem | null>(null);
  const canEdit = schedule.permissions.canEdit;

  return (
    <div className="space-y-6">
      <ScheduleSummary schedule={schedule} />
      {!canEdit ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("readOnly")}
        </p>
      ) : (
        <Button onClick={() => setEditor({ item: null })}>
          <Plus aria-hidden className="size-4" />
          {t("activity.add")}
        </Button>
      )}
      {schedule.items.length ? (
        <>
          <GanttChart
            schedule={schedule}
            onEdit={(item) => (item.kind === "task" ? setEditor({ item }) : undefined)}
          />
          <ScheduleTable
            schedule={schedule}
            nodes={nodes}
            onEdit={(item) => setEditor({ item })}
            onProgress={setProgress}
            onDelete={setRemoving}
          />
        </>
      ) : (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("gantt.empty")}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <DependenciesPanel projectId={projectId} schedule={schedule} />
        <CalendarPanel projectId={projectId} calendar={schedule.calendar} canEdit={canEdit} />
      </div>
      {editor ? (
        <ActivityDialog
          key={editor.item?.id ?? "new"}
          projectId={projectId}
          item={editor.item}
          open
          nodes={nodes}
          canPickBq={canPickBq}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {progress ? (
        <ProgressDialog
          key={progress.id}
          projectId={projectId}
          item={progress}
          onClose={() => setProgress(null)}
        />
      ) : null}
      {removing ? (
        <DeleteActivityDialog
          key={removing.id}
          projectId={projectId}
          item={removing}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}
