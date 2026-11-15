"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { REPORT_DEFINITIONS, type ReportId } from "@pm-buddy/types";
import {
  reportOptionsResponseSchema,
  type ReportOptionsResponse,
  type ReportParams,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { spendingSelectClass } from "@/components/spending/spending-action";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { formatCalendarDate } from "@/lib/format";
import { reportQuery } from "@/lib/reports";

type ProjectOption = { id: string; code: string; name: string };
const EMPTY: ReportOptionsResponse = { sites: [], stores: [], batches: [], actors: [] };

/**
 * A report's parameter form (D8.1): only the fields the report takes, with the choices the caller
 * may use (projects from the reports list; sites, stores, payroll batches and people from the
 * options endpoint, re-checked by the API). Showing the report opens its link, so it can be
 * bookmarked or emailed.
 */
export function ReportForm({
  id,
  projects,
  acrossProjects,
  initial,
}: {
  id: ReportId;
  projects: ProjectOption[];
  acrossProjects: boolean;
  initial: ReportParams;
}) {
  const t = useTranslations("reports.form");
  const problem = useProblemMessage();
  const router = useRouter();
  const definition = REPORT_DEFINITIONS[id];
  const [values, setValues] = useState<ReportParams>(() => ({
    ...initial,
    projectId:
      initial.projectId ??
      (definition.project === "required" && projects.length === 1 ? projects[0]!.id : undefined),
  }));
  const [loaded, setLoaded] = useState<{ key: string; options: ReportOptionsResponse } | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const needsOptions = definition.site || definition.store || definition.batch || definition.actor;
  const projectId = values.projectId;
  const optionsKey =
    needsOptions && !((definition.site || definition.batch) && !projectId)
      ? `${id}:${projectId ?? ""}`
      : null;
  const options = loaded && loaded.key === optionsKey ? loaded.options : EMPTY;

  useEffect(() => {
    if (!optionsKey) return;
    let cancelled = false;
    liveRequest(
      `/reports/${id}/options${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      reportOptionsResponseSchema,
    )
      .then((result) => {
        if (!cancelled) setLoaded({ key: optionsKey, options: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(problem(error));
      });
    return () => {
      cancelled = true;
    };
    // `problem` is a fresh function each render; options depend on the report and project only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, projectId, optionsKey]);

  const set = (key: keyof ReportParams, value: string) =>
    setValues((current) => {
      const next = { ...current, [key]: value || undefined };
      if (key === "projectId") {
        next.siteId = undefined;
        next.batchId = undefined;
        next.storeId = undefined;
      }
      return next;
    });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = reportQuery(values, { run: "1" });
    startTransition(() => router.push(`/reports/${id}?${query}`));
  }

  const field = "space-y-1.5";
  return (
    <form
      onSubmit={submit}
      aria-label={t("label")}
      className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {definition.project !== "none" ? (
        <Field className={field}>
          <FieldLabel htmlFor="report-project">{t("project")}</FieldLabel>
          <select
            id="report-project"
            className={spendingSelectClass}
            value={values.projectId ?? ""}
            required={definition.project === "required"}
            onChange={(event) => set("projectId", event.target.value)}
          >
            {definition.project === "required" ? (
              <option value="">{t("chooseProject")}</option>
            ) : acrossProjects ? (
              <option value="">{t("allProjects")}</option>
            ) : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {definition.site ? (
        <Field className={field}>
          <FieldLabel htmlFor="report-site">{t("site")}</FieldLabel>
          <select
            id="report-site"
            className={spendingSelectClass}
            value={values.siteId ?? ""}
            required
            disabled={!projectId}
            onChange={(event) => set("siteId", event.target.value)}
          >
            <option value="">{t("chooseSite")}</option>
            {options.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {definition.store ? (
        <Field className={field}>
          <FieldLabel htmlFor="report-store">{t("store")}</FieldLabel>
          <select
            id="report-store"
            className={spendingSelectClass}
            value={values.storeId ?? ""}
            onChange={(event) => set("storeId", event.target.value)}
          >
            <option value="">{t("allStores")}</option>
            {options.stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name} · {store.project.code}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {definition.batch ? (
        <Field className={field}>
          <FieldLabel htmlFor="report-batch">{t("batch")}</FieldLabel>
          <select
            id="report-batch"
            className={spendingSelectClass}
            value={values.batchId ?? ""}
            required
            disabled={!projectId}
            onChange={(event) => set("batchId", event.target.value)}
          >
            <option value="">{t("chooseBatch")}</option>
            {options.batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {t("batchOption", {
                  from: formatCalendarDate(batch.periodStart),
                  to: formatCalendarDate(batch.periodEnd),
                  status: ["draft", "submitted", "cancelled"].includes(batch.status)
                    ? t(`batchStatuses.${batch.status as "draft" | "submitted" | "cancelled"}`)
                    : batch.status,
                })}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {definition.actor ? (
        <>
          <Field className={field}>
            <FieldLabel htmlFor="report-actor">{t("actor")}</FieldLabel>
            <select
              id="report-actor"
              className={spendingSelectClass}
              value={values.actorId ?? ""}
              onChange={(event) => set("actorId", event.target.value)}
            >
              <option value="">{t("anyone")}</option>
              {options.actors.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field className={field}>
            <FieldLabel htmlFor="report-action">{t("action")}</FieldLabel>
            <Input
              id="report-action"
              value={values.action ?? ""}
              maxLength={100}
              pattern="[a-z][a-z0-9_.]*"
              onChange={(event) => set("action", event.target.value.trim().toLowerCase())}
            />
            <FieldDescription>{t("actionHint")}</FieldDescription>
          </Field>
        </>
      ) : null}
      {definition.period === "range" ? (
        <>
          <Field className={field}>
            <FieldLabel htmlFor="report-from">{t("from")}</FieldLabel>
            <Input
              id="report-from"
              type="date"
              required
              value={values.from ?? ""}
              onChange={(event) => set("from", event.target.value)}
            />
            <FieldDescription>
              {t("periodHint", { days: definition.maxPeriodDays })}
            </FieldDescription>
          </Field>
          <Field className={field}>
            <FieldLabel htmlFor="report-to">{t("to")}</FieldLabel>
            <Input
              id="report-to"
              type="date"
              required
              value={values.to ?? ""}
              onChange={(event) => set("to", event.target.value)}
            />
          </Field>
        </>
      ) : null}
      {definition.period === "as-at" ? (
        <Field className={field}>
          <FieldLabel htmlFor="report-as-at">{t("asAt")}</FieldLabel>
          <Input
            id="report-as-at"
            type="date"
            required
            value={values.asAt ?? ""}
            onChange={(event) => set("asAt", event.target.value)}
          />
        </Field>
      ) : null}
      <div className="flex flex-col justify-end gap-2 sm:col-span-2 lg:col-span-3">
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <Button type="submit" disabled={busy} className="w-full sm:w-auto sm:self-start">
          {busy ? t("loading") : t("show")}
        </Button>
      </div>
    </form>
  );
}
