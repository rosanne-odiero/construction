"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Flag, Plus } from "lucide-react";
import {
  INDUCTION_ACKNOWLEDGEMENTS,
  INDUCTION_PERSON_KINDS,
  type InductionPersonKind,
  type StarterInductionTopic,
} from "@pm-buddy/types";
import {
  createInductionRequestSchema,
  inductionResponseSchema,
  voidRequestSchema,
  type InductionsResponse,
  type InductionStatusResponse,
  type SafetyLabourer,
  type SafetyOptionsResponse,
  type Site,
} from "@pm-buddy/validation";
import {
  FormError,
  selectClass,
  useScheduleMutation,
} from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseCalendarInput } from "@/lib/project-input";
import { inductionStateTone, safetyHref } from "@/lib/safety";
import { checkboxClass, field, Pager, ReasonDialog } from "./common";
import { LabourerPicker } from "./labourer-picker";

export type InductionFilters = {
  siteId: string;
  filter?: string;
  search?: string;
  cursor?: string;
  recent?: string;
};

/**
 * Inductions at one site (D8.2): each labourer's status there, flags for anyone who worked there
 * without a valid induction (from attendance), recording an induction, and the recorded list.
 */
export function InductionsPanel({
  projectId,
  sites,
  status,
  inductions,
  options,
  filters,
  today,
  userId,
}: {
  projectId: string;
  sites: Site[];
  status: InductionStatusResponse;
  inductions: InductionsResponse;
  options: SafetyOptionsResponse;
  filters: InductionFilters;
  today: string;
  userId: string;
}) {
  const t = useTranslations("safety");
  const { busy, error, setError, run } = useScheduleMutation();
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<{ id: string; version: number } | null>(null);
  const [kind, setKind] = useState<InductionPersonKind>("labourer");
  const [labourer, setLabourer] = useState<SafetyLabourer | null>(null);
  const site = sites.find((entry) => entry.id === status.siteId);
  const inductors = options.staff.filter((member) => member.canRecord);
  const topicText = (topic: { key: string; label: string | null }) =>
    topic.label ?? t(`topics.${topic.key as StarterInductionTopic}`);
  const kept = { siteId: filters.siteId, filter: filters.filter, search: filters.search };

  function openRecord(preset: SafetyLabourer | null) {
    setError(null);
    setKind("labourer");
    setLabourer(preset);
    setRecording(true);
  }

  function record(form: FormData) {
    const inductedOn = parseCalendarInput(field(form, "inductedOn"));
    const parsed = createInductionRequestSchema.safeParse({
      siteId: status.siteId,
      personKind: kind,
      ...(kind === "labourer" && labourer ? { labourerId: labourer.id } : {}),
      ...(kind === "staff" ? { userId: field(form, "userId") || undefined } : {}),
      ...(kind === "visitor"
        ? {
            visitorName: field(form, "visitorName"),
            visitorOrganisation: field(form, "visitorOrganisation"),
          }
        : {}),
      inductedOn,
      inductorId: field(form, "inductorId"),
      topics: form.getAll("topics").map(String),
      acknowledgement: form.get("acknowledgement"),
      notes: field(form, "notes"),
    });
    if (!parsed.success || !inductedOn || inductedOn > parseCalendarInput(today)!) {
      setError(t("inductions.invalid"));
      return;
    }
    void run(
      () =>
        liveRequest(`/projects/${projectId}/safety/inductions`, inductionResponseSchema, {
          method: "POST",
          body: parsed.data,
        }),
      () => setRecording(false),
    );
  }

  return (
    <section aria-labelledby="inductions-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="inductions-heading" className="text-base font-semibold">
          {t("inductions.statusTitle", { site: site?.name ?? "" })}
        </h3>
        {inductions.permissions.canCreate ? (
          <Button onClick={() => openRecord(null)}>
            <Plus className="size-4" aria-hidden />
            {t("inductions.record")}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("inductions.statusHint", { days: status.lookbackDays })}
      </p>
      <ul className="flex flex-wrap gap-2" aria-label={t("inductions.countsLabel")}>
        <li>
          <StatusBadge
            tone={status.counts.flagged ? "danger" : "neutral"}
            className="h-auto whitespace-normal"
          >
            {t("inductions.countFlagged", { count: status.counts.flagged })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="success" className="h-auto whitespace-normal">
            {t("inductions.countValid", { count: status.counts.valid })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="warning" className="h-auto whitespace-normal">
            {t("inductions.countExpired", { count: status.counts.expired })}
          </StatusBadge>
        </li>
        <li>
          <StatusBadge tone="neutral" className="h-auto whitespace-normal">
            {t("inductions.countNone", { count: status.counts.none })}
          </StatusBadge>
        </li>
      </ul>
      <form
        method="get"
        action={`/projects/${projectId}`}
        className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_auto] lg:items-end"
      >
        <input type="hidden" name="tab" value="safety" />
        <input type="hidden" name="view" value="inductions" />
        <Field>
          <FieldLabel htmlFor="induction-site">{t("inductions.site")}</FieldLabel>
          <select
            id="induction-site"
            name="siteId"
            defaultValue={filters.siteId}
            className={selectClass}
          >
            {sites.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="induction-filter">{t("filters.status")}</FieldLabel>
          <select
            id="induction-filter"
            name="filter"
            defaultValue={filters.filter ?? "all"}
            className={selectClass}
          >
            <option value="all">{t("inductions.filterAll")}</option>
            <option value="not_inducted">{t("inductions.filterNot")}</option>
            <option value="flagged">{t("inductions.filterFlagged")}</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="induction-search">{t("filters.search")}</FieldLabel>
          <Input
            id="induction-search"
            name="search"
            type="search"
            maxLength={100}
            defaultValue={filters.search ?? ""}
            placeholder={t("inductions.searchPlaceholder")}
          />
        </Field>
        <Button type="submit" variant="outline">
          {t("filters.apply")}
        </Button>
      </form>
      {status.rows.length ? (
        <ul className="divide-y rounded-md border">
          {status.rows.map((row) => (
            <li key={row.labourer.id} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-0 flex-1 basis-56 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.labourer.workerNo}
                  </span>
                  <span className="font-medium break-words">{row.labourer.fullName}</span>
                  <StatusBadge
                    tone={inductionStateTone[row.state]}
                    className="h-auto whitespace-normal"
                  >
                    {t(`inductionState.${row.state}`)}
                  </StatusBadge>
                </p>
                {row.gang || row.inductedOn ? (
                  <p className="text-sm break-words text-muted-foreground">
                    {[
                      row.gang ? t("inductions.gang", { name: row.gang.name }) : null,
                      row.inductedOn
                        ? `${t("inductions.inductedOn", { date: formatCalendarDate(row.inductedOn) })}${
                            row.validUntil
                              ? `, ${t("inductions.validUntil", { date: formatCalendarDate(row.validUntil) })}`
                              : ""
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : null}
                {row.flagged ? (
                  <p className="flex items-start gap-1 text-sm break-words text-destructive">
                    <Flag className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {t("inductions.flagged", {
                      dates: row.uninductedDays.map(formatCalendarDate).join(", "),
                    })}
                  </p>
                ) : null}
              </div>
              {inductions.permissions.canCreate && row.state !== "valid" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-8 max-w-full whitespace-normal"
                  onClick={() => openRecord(row.labourer)}
                >
                  {t("inductions.recordFor", { name: row.labourer.fullName })}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("inductions.noRows")}</p>
      )}
      <Pager
        label={t("inductions.pages")}
        offset
        firstHref={filters.cursor ? safetyHref(projectId, "inductions", kept) : null}
        nextHref={
          status.nextCursor !== null
            ? safetyHref(projectId, "inductions", { ...kept, cursor: String(status.nextCursor) })
            : null
        }
      />

      <section aria-labelledby="inductions-recent" className="space-y-2">
        <h3 id="inductions-recent" className="text-base font-semibold">
          {t("inductions.recentTitle")}
        </h3>
        {inductions.inductions.length ? (
          <ul className="space-y-2">
            {inductions.inductions.map((induction) => (
              <li key={induction.id} className="space-y-1 rounded-md border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{induction.code}</span>
                  <span className="font-medium break-words">
                    {induction.labourer?.fullName ??
                      induction.staff?.displayName ??
                      induction.visitorName}
                  </span>
                  <StatusBadge tone="neutral" className="h-auto whitespace-normal">
                    {t(`personKind.${induction.personKind}`)}
                  </StatusBadge>
                  {induction.status === "voided" ? (
                    <StatusBadge tone="neutral" className="h-auto whitespace-normal">
                      {t("inductionStatus.voided")}
                    </StatusBadge>
                  ) : (
                    <StatusBadge
                      tone={inductionStateTone[induction.state]}
                      className="h-auto whitespace-normal"
                    >
                      {t(`inductionState.${induction.state}`)}
                    </StatusBadge>
                  )}
                </p>
                <p className="break-words text-muted-foreground">
                  {formatCalendarDate(induction.inductedOn)} · {t("inductions.inductor")}:{" "}
                  {induction.inductor.displayName} ·{" "}
                  {t(`acknowledgement.${induction.acknowledgement}`)} ·{" "}
                  {t("inductions.topicCount", {
                    covered: induction.topics.length,
                    total: induction.topicsTotal,
                  })}
                </p>
                {induction.voidReason ? (
                  <p className="break-words">
                    {t("inductions.voided", { reason: induction.voidReason })}
                  </p>
                ) : null}
                {induction.permissions.canVoid ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setError(null);
                      setVoiding({ id: induction.id, version: induction.version });
                    }}
                  >
                    {t("inductions.void", { code: induction.code })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("inductions.recentEmpty")}</p>
        )}
        <Pager
          label={t("inductions.recentPages")}
          firstHref={filters.recent ? safetyHref(projectId, "inductions", kept) : null}
          nextHref={
            inductions.nextCursor
              ? safetyHref(projectId, "inductions", {
                  ...kept,
                  recent: String(inductions.nextCursor),
                })
              : null
          }
        />
      </section>

      <ReasonDialog
        open={voiding !== null}
        title={t("inductions.voidTitle")}
        hint={t("inductions.voidHint")}
        busy={busy}
        error={error}
        onOpenChange={(next) => {
          if (!next) setVoiding(null);
        }}
        onSubmit={(reason) => {
          if (!voiding) return;
          const parsed = voidRequestSchema.safeParse({ version: voiding.version, reason });
          if (!parsed.success) return setError(t("actions.reasonInvalid"));
          void run(
            () =>
              liveRequest(
                `/projects/${projectId}/safety/inductions/${voiding.id}/void`,
                inductionResponseSchema,
                { method: "POST", body: parsed.data },
              ),
            () => setVoiding(null),
          );
        }}
      />
      <Dialog
        open={recording}
        onOpenChange={(next) => {
          if (!busy) setRecording(next);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("inductions.record")}</DialogTitle>
            <DialogDescription>{t("inductions.recordHint")}</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              record(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            <p className="text-sm">
              {t("inductions.site")}: {site?.name}
            </p>
            <Field>
              <FieldLabel htmlFor="induction-kind">{t("inductions.personKind")}</FieldLabel>
              <select
                id="induction-kind"
                value={kind}
                className={selectClass}
                onChange={(event) => setKind(event.currentTarget.value as InductionPersonKind)}
              >
                {INDUCTION_PERSON_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`personKind.${option}`)}
                  </option>
                ))}
              </select>
            </Field>
            {kind === "labourer" ? (
              <LabourerPicker
                projectId={projectId}
                siteId={status.siteId}
                value={labourer}
                onChange={setLabourer}
              />
            ) : kind === "staff" ? (
              <Field>
                <FieldLabel htmlFor="induction-staff">{t("inductions.staff")}</FieldLabel>
                <select id="induction-staff" name="userId" defaultValue="" className={selectClass}>
                  <option value="">—</option>
                  {options.staff.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="induction-visitor">{t("inductions.visitorName")}</FieldLabel>
                  <Input id="induction-visitor" name="visitorName" maxLength={120} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="induction-organisation">
                    {t("inductions.visitorOrganisation")}
                  </FieldLabel>
                  <Input id="induction-organisation" name="visitorOrganisation" maxLength={120} />
                </Field>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="induction-date">{t("inductions.inductedOnLabel")}</FieldLabel>
                <Input
                  id="induction-date"
                  name="inductedOn"
                  inputMode="numeric"
                  defaultValue={today}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="induction-inductor">{t("inductions.inductor")}</FieldLabel>
                <select
                  id="induction-inductor"
                  name="inductorId"
                  defaultValue={inductors.some((member) => member.id === userId) ? userId : ""}
                  className={selectClass}
                >
                  <option value="">—</option>
                  {inductors.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("inductions.topics")}</legend>
              {options.inductionTopics.map((topic) => (
                <label key={topic.key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="topics"
                    value={topic.key}
                    defaultChecked
                    className={`${checkboxClass} mt-0.5`}
                  />
                  <span className="break-words">{topicText(topic)}</span>
                </label>
              ))}
            </fieldset>
            <Field>
              <FieldLabel htmlFor="induction-ack">{t("inductions.acknowledgement")}</FieldLabel>
              <select
                id="induction-ack"
                name="acknowledgement"
                defaultValue="signed"
                className={selectClass}
              >
                {INDUCTION_ACKNOWLEDGEMENTS.map((option) => (
                  <option key={option} value={option}>
                    {t(`acknowledgement.${option}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="induction-notes">{t("inductions.notes")}</FieldLabel>
              <Textarea id="induction-notes" name="notes" maxLength={500} />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setRecording(false)}
              >
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("inductions.record")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
