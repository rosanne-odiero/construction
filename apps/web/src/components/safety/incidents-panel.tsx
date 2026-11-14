"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { INCIDENT_KINDS, INCIDENT_STATUSES } from "@pm-buddy/types";
import type { IncidentsResponse, Site } from "@pm-buddy/validation";
import { selectClass } from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDate, formatTime } from "@/lib/format";
import { incidentSeverityTone, incidentStatusTone, regulatorTone, safetyHref } from "@/lib/safety";
import { Pager } from "./common";

export type IncidentFilters = {
  status?: string;
  kind?: string;
  siteId?: string;
  search?: string;
  cursor?: string;
};

/** Incidents and near misses, newest first, with server filters and paging. */
export function IncidentsPanel({
  projectId,
  data,
  sites,
  filters,
}: {
  projectId: string;
  data: IncidentsResponse;
  sites: Site[];
  filters: IncidentFilters;
}) {
  const t = useTranslations("safety");
  const { counts } = data;
  const kept = {
    status: filters.status,
    kind: filters.kind,
    siteId: filters.siteId,
    search: filters.search,
  };
  return (
    <section aria-labelledby="incidents-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="incidents-heading" className="text-base font-semibold">
          {t("incidents.title")}
        </h3>
        {data.permissions.canReport && sites.length ? (
          <Button asChild>
            <Link href={`/projects/${projectId}/safety/incidents/new`}>
              <Plus className="size-4" aria-hidden />
              {t("incidents.report")}
            </Link>
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={t("incidents.countsLabel")}>
        <li>
          <StatusBadge tone="warning" className="h-auto whitespace-normal">
            {t("incidents.countReported", { count: counts.reported })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="info" className="h-auto whitespace-normal">
            {t("incidents.countInvestigated", { count: counts.investigated })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="success" className="h-auto whitespace-normal">
            {t("incidents.countClosed", { count: counts.closed })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge
            tone={counts.regulatorPending ? "danger" : "neutral"}
            className="h-auto max-w-full whitespace-normal text-left"
          >
            {t("incidents.countRegulator", { count: counts.regulatorPending })}
          </StatusBadge>
        </li>
      </ul>
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto] lg:items-end"
      >
        <input type="hidden" name="tab" value="safety" />
        <Field>
          <FieldLabel htmlFor="incident-status">{t("filters.status")}</FieldLabel>
          <select
            id="incident-status"
            name="status"
            defaultValue={filters.status ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            <option value="open">{t("incidents.openStatus")}</option>
            {INCIDENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`incidentStatus.${status}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="incident-kind">{t("filters.kind")}</FieldLabel>
          <select
            id="incident-kind"
            name="kind"
            defaultValue={filters.kind ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.all")}</option>
            {INCIDENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="incident-site">{t("filters.site")}</FieldLabel>
          <select
            id="incident-site"
            name="siteId"
            defaultValue={filters.siteId ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.allSites")}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="incident-search">{t("filters.search")}</FieldLabel>
          <Input
            id="incident-search"
            name="search"
            type="search"
            maxLength={100}
            defaultValue={filters.search ?? ""}
            placeholder={t("incidents.searchPlaceholder")}
          />
        </Field>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {data.incidents.length ? (
        <ul className="space-y-3">
          {data.incidents.map((incident) => (
            <li key={incident.id}>
              <Link
                href={`/projects/${projectId}/safety/incidents/${incident.id}`}
                className="block space-y-2 rounded-md border p-3 hover:bg-muted"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{incident.code}</span>
                  <StatusBadge
                    tone={incident.kind === "near_miss" ? "info" : "warning"}
                    className="h-auto whitespace-normal"
                  >
                    {t(`kind.${incident.kind}`)}
                  </StatusBadge>
                  <StatusBadge
                    tone={incidentSeverityTone[incident.severity]}
                    className="h-auto whitespace-normal"
                  >
                    {t(`severity.${incident.severity}`)}
                  </StatusBadge>
                  <StatusBadge
                    tone={incidentStatusTone[incident.status]}
                    className="h-auto whitespace-normal"
                  >
                    {t(`incidentStatus.${incident.status}`)}
                  </StatusBadge>
                  {incident.regulator.state === "required" ? (
                    <StatusBadge
                      tone={regulatorTone.required}
                      className="h-auto max-w-full whitespace-normal text-left"
                    >
                      {t("regulatorState.required")}
                    </StatusBadge>
                  ) : null}
                  {incident.actionCounts.overdue ? (
                    <StatusBadge tone="danger" className="h-auto whitespace-normal">
                      {t("incidents.overdueActions", { count: incident.actionCounts.overdue })}
                    </StatusBadge>
                  ) : null}
                </span>
                <span className="block text-sm font-medium break-words">{incident.location}</span>
                <span className="block text-sm break-words text-muted-foreground">
                  {incident.siteName} ·{" "}
                  {t("incidents.occurred", {
                    date: formatDate(incident.occurredAt),
                    time: formatTime(incident.occurredAt),
                  })}{" "}
                  ·{" "}
                  {t("incidents.actionsSummary", {
                    open: incident.actionCounts.open,
                    done: incident.actionCounts.done,
                    verified: incident.actionCounts.verified,
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("incidents.empty")}</p>
      )}
      <Pager
        label={t("incidents.pages")}
        firstHref={filters.cursor ? safetyHref(projectId, "incidents", kept) : null}
        nextHref={
          data.nextCursor
            ? safetyHref(projectId, "incidents", { ...kept, cursor: String(data.nextCursor) })
            : null
        }
      />
    </section>
  );
}
