"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { DEPENDENCY_TYPES, SCHEDULE_LIMITS, type DependencyType } from "@pm-buddy/types";
import {
  createDependencyRequestSchema,
  messageResponseSchema,
  scheduleDependencyResponseSchema,
  updateDependencyRequestSchema,
  type ScheduleDependency,
  type ScheduleResponse,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { itemLabel } from "@/lib/schedule";
import { FormError, selectClass, useScheduleMutation } from "./use-schedule-mutation";

const refValue = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;
const parseRef = (value: string) => {
  const [kind, id] = value.split(":");
  return { kind, id };
};

/**
 * Dependencies between tasks and milestones: FS, SS, FF or SF with a lag in working days (a
 * negative lag is a lead). The API and the database refuse a link that would close a loop.
 */
export function DependenciesPanel({
  projectId,
  schedule,
}: {
  projectId: string;
  schedule: ScheduleResponse;
}) {
  const t = useTranslations("schedule.dependencies");
  const { busy, error, setError, run } = useScheduleMutation();
  const [editing, setEditing] = useState<ScheduleDependency | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canEdit = schedule.permissions.canEdit;
  const labels = new Map(schedule.items.map((item) => [refValue(item), itemLabel(item)]));
  const label = (ref: { kind: string; id: string }) =>
    labels.get(refValue(ref)) ?? t("cancelledMilestone");

  function add(form: FormData) {
    const parsed = createDependencyRequestSchema.safeParse({
      predecessor: parseRef(String(form.get("predecessor") ?? "")),
      successor: parseRef(String(form.get("successor") ?? "")),
      type: form.get("type"),
      lagDays: Number(String(form.get("lagDays") ?? "0").trim() || "0"),
    });
    if (!parsed.success) {
      setError(t("invalid"));
      return;
    }
    setNotice(null);
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/schedule/dependencies`,
          scheduleDependencyResponseSchema,
          {
            method: "POST",
            body: parsed.data,
          },
        ),
      () => setNotice(t("added")),
    );
  }

  function update(form: FormData) {
    if (!editing) return;
    const parsed = updateDependencyRequestSchema.safeParse({
      type: form.get("type"),
      lagDays: Number(String(form.get("lagDays") ?? "0").trim() || "0"),
      version: editing.version,
    });
    if (!parsed.success) {
      setError(t("invalid"));
      return;
    }
    setNotice(null);
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/schedule/dependencies/${editing.id}`,
          scheduleDependencyResponseSchema,
          { method: "PATCH", body: parsed.data },
        ),
      () => {
        setEditing(null);
        setNotice(t("saved"));
      },
    );
  }

  function remove(dependency: ScheduleDependency) {
    setNotice(null);
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/schedule/dependencies/${dependency.id}?version=${dependency.version}`,
          messageResponseSchema,
          { method: "DELETE" },
        ),
      () => setNotice(t("removed")),
    );
  }

  const typeSelect = (id: string, value: DependencyType) => (
    <select id={id} name="type" defaultValue={value} className={selectClass} disabled={busy}>
      {DEPENDENCY_TYPES.map((type) => (
        <option key={type} value={type}>
          {t(`types.${type}`)}
        </option>
      ))}
    </select>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{t("title")}</h3>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormError message={editing ? null : error} />
        {notice ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        {schedule.dependencies.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {schedule.dependencies.map((dependency) => (
              <li key={dependency.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words">
                    {t("link", {
                      from: label(dependency.predecessor),
                      to: label(dependency.successor),
                    })}
                  </span>
                  <StatusBadge tone="neutral">
                    {t("typeAndLag", { type: dependency.type, lag: dependency.lagDays })}
                  </StatusBadge>
                  {dependency.critical ? (
                    <StatusBadge tone="danger">{t("critical")}</StatusBadge>
                  ) : dependency.driving ? (
                    <StatusBadge tone="info">{t("driving")}</StatusBadge>
                  ) : null}
                </div>
                {editing?.id === dependency.id ? (
                  <form
                    className="grid gap-3 rounded-md border bg-muted/40 p-3 sm:grid-cols-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      update(new FormData(event.currentTarget));
                    }}
                  >
                    <div className="sm:col-span-3">
                      <FormError message={error} />
                    </div>
                    <Field>
                      <FieldLabel htmlFor={`dependency-type-${dependency.id}`}>
                        {t("type")}
                      </FieldLabel>
                      {typeSelect(`dependency-type-${dependency.id}`, dependency.type)}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`dependency-lag-${dependency.id}`}>
                        {t("lag")}
                      </FieldLabel>
                      <Input
                        id={`dependency-lag-${dependency.id}`}
                        name="lagDays"
                        type="number"
                        min={SCHEDULE_LIMITS.minLagDays}
                        max={SCHEDULE_LIMITS.maxLagDays}
                        step={1}
                        defaultValue={dependency.lagDays}
                        disabled={busy}
                      />
                    </Field>
                    <div className="flex items-end gap-2">
                      <Button type="submit" size="sm" disabled={busy}>
                        {t("save")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setEditing(null);
                        }}
                      >
                        {t("cancel")}
                      </Button>
                    </div>
                  </form>
                ) : canEdit ? (
                  <div className="flex flex-wrap gap-1">
                    {dependency.permissions.canEdit ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setEditing(dependency);
                        }}
                      >
                        {t("edit")}
                      </Button>
                    ) : null}
                    {dependency.permissions.canDelete ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => remove(dependency)}
                      >
                        {t("remove")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {canEdit && schedule.items.length >= 2 ? (
          <form
            className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              add(new FormData(event.currentTarget));
            }}
          >
            <p className="text-sm font-medium sm:col-span-2 lg:col-span-4">{t("addTitle")}</p>
            <Field>
              <FieldLabel htmlFor="dependency-predecessor">{t("predecessor")}</FieldLabel>
              <select
                id="dependency-predecessor"
                name="predecessor"
                className={selectClass}
                disabled={busy}
              >
                {schedule.items.map((item) => (
                  <option key={refValue(item)} value={refValue(item)}>
                    {itemLabel(item)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="dependency-successor">{t("successor")}</FieldLabel>
              <select
                id="dependency-successor"
                name="successor"
                className={selectClass}
                defaultValue={refValue(schedule.items[1]!)}
                disabled={busy}
              >
                {schedule.items.map((item) => (
                  <option key={refValue(item)} value={refValue(item)}>
                    {itemLabel(item)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="dependency-type">{t("type")}</FieldLabel>
              {typeSelect("dependency-type", "FS")}
            </Field>
            <Field>
              <FieldLabel htmlFor="dependency-lag">{t("lag")}</FieldLabel>
              <Input
                id="dependency-lag"
                name="lagDays"
                type="number"
                min={SCHEDULE_LIMITS.minLagDays}
                max={SCHEDULE_LIMITS.maxLagDays}
                step={1}
                defaultValue={0}
                disabled={busy}
                aria-describedby="dependency-lag-hint"
              />
              <FieldDescription id="dependency-lag-hint">{t("lagHint")}</FieldDescription>
            </Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={busy}>
                {t("add")}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
