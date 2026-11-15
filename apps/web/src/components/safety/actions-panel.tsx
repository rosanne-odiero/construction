"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { CORRECTIVE_ACTION_STATUSES } from "@pm-buddy/types";
import type { CorrectiveActionsResponse, SafetyOptionsResponse } from "@pm-buddy/validation";
import { selectClass } from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { safetyHref } from "@/lib/safety";
import { ActionCard, RaiseActionDialog } from "./action-card";
import { checkboxClass, Pager } from "./common";

export type ActionFilters = { status?: string; mine?: string; search?: string; cursor?: string };

/** Corrective actions across the project, overdue first, with server filters and paging. */
export function ActionsPanel({
  projectId,
  data,
  staff,
  filters,
}: {
  projectId: string;
  data: CorrectiveActionsResponse;
  staff: SafetyOptionsResponse["staff"];
  filters: ActionFilters;
}) {
  const t = useTranslations("safety");
  const [raising, setRaising] = useState(false);
  const { counts } = data;
  const kept = { status: filters.status, mine: filters.mine, search: filters.search };
  return (
    <section aria-labelledby="actions-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h3 id="actions-heading" className="text-base font-semibold">
            {t("actionsList.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("actionsList.hint")}</p>
        </div>
        {data.permissions.canCreate ? (
          <Button onClick={() => setRaising(true)}>
            <Plus className="size-4" aria-hidden />
            {t("actionsList.raise")}
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={t("actionsList.countsLabel")}>
        <li>
          <StatusBadge
            tone={counts.overdue ? "danger" : "neutral"}
            className="h-auto whitespace-normal"
          >
            {t("actionsList.countOverdue", { count: counts.overdue })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="warning" className="h-auto whitespace-normal">
            {t("actionsList.countOpen", { count: counts.open })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="info" className="h-auto whitespace-normal">
            {t("actionsList.countDone", { count: counts.done })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="success" className="h-auto whitespace-normal">
            {t("actionsList.countVerified", { count: counts.verified })}
          </StatusBadge>
        </li>
      </ul>
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_2fr_auto_auto] lg:items-end"
      >
        <input type="hidden" name="tab" value="safety" />
        <input type="hidden" name="view" value="actions" />
        <Field>
          <FieldLabel htmlFor="action-status">{t("filters.status")}</FieldLabel>
          <select
            id="action-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            <option value="active">{t("actionsList.active")}</option>
            <option value="overdue">{t("actionsList.overdueFilter")}</option>
            {CORRECTIVE_ACTION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`actionStatus.${status}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="action-search">{t("filters.search")}</FieldLabel>
          <Input
            id="action-search"
            name="search"
            type="search"
            maxLength={100}
            defaultValue={filters.search ?? ""}
            placeholder={t("actionsList.searchPlaceholder")}
          />
        </Field>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="mine"
            value="true"
            defaultChecked={filters.mine === "true"}
            className={checkboxClass}
          />
          {t("actionsList.mine")}
        </label>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {data.actions.length ? (
        <ul className="space-y-3">
          {data.actions.map((action) => (
            <li key={action.id}>
              <ActionCard projectId={projectId} action={action} staff={staff} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("actionsList.empty")}</p>
      )}
      <Pager
        label={t("actionsList.pages")}
        offset
        firstHref={filters.cursor ? safetyHref(projectId, "actions", kept) : null}
        nextHref={
          data.nextCursor !== null
            ? safetyHref(projectId, "actions", { ...kept, cursor: String(data.nextCursor) })
            : null
        }
      />
      <RaiseActionDialog
        projectId={projectId}
        staff={staff}
        source={null}
        open={raising}
        onOpenChange={setRaising}
      />
    </section>
  );
}
