"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { nairobiDate } from "@pm-buddy/domain";
import { QUALITY_SETTINGS_LIMITS, type CompletionKind } from "@pm-buddy/types";
import {
  completionActionRequestSchema,
  completionResponseSchema,
  proposeCompletionRequestSchema,
  type CompletionCertificate,
  type CompletionResponse,
} from "@pm-buddy/validation";
import { FormError, useScheduleMutation } from "@/components/schedule/use-schedule-mutation";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput } from "@/lib/project-input";
import { parseWhole, qualityHref } from "@/lib/quality";

const statusTone: Record<CompletionCertificate["status"], Tone> = {
  proposed: "info",
  certified: "success",
  withdrawn: "neutral",
};
type DialogState =
  | { kind: "propose"; certificate: CompletionKind }
  | { kind: "certify" | "withdraw"; certificate: CompletionCertificate };

/**
 * Practical completion, the defects liability period and final completion (D6.1). Certificates are
 * proposed (projects.manage) and certified by someone else holding quality.manage; the readiness
 * card shows what blocks them today. D6.3 releases retention against the certified certificates.
 */
export function CompletionPanel({
  projectId,
  data,
}: {
  projectId: string;
  data: CompletionResponse;
}) {
  const t = useTranslations("quality");
  const { busy, error, setError, run } = useScheduleMutation();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const show = (next: DialogState) => {
    setError(null);
    setDialog(next);
  };

  function submit(form: FormData) {
    if (!dialog) return;
    const text = (name: string) => String(form.get(name) ?? "");
    if (dialog.kind === "propose") {
      const months = text("dlpMonths").trim();
      const parsed = proposeCompletionRequestSchema.safeParse({
        kind: dialog.certificate,
        completionDate: parseCalendarInput(text("completionDate")),
        ...(dialog.certificate === "practical" && months
          ? {
              dlpMonths: parseWhole(
                months,
                QUALITY_SETTINGS_LIMITS.dlpMonths.min,
                QUALITY_SETTINGS_LIMITS.dlpMonths.max,
              ),
            }
          : {}),
        exceptionReason: text("exceptionReason"),
        notes: text("notes"),
      });
      if (!parsed.success) {
        setError(t("completion.invalid"));
        return;
      }
      void run(
        () =>
          liveRequest(`/projects/${projectId}/quality/completion`, completionResponseSchema, {
            method: "POST",
            body: parsed.data,
          }),
        () => setDialog(null),
      );
      return;
    }
    const parsed = completionActionRequestSchema.safeParse({
      version: dialog.certificate.version,
      action: dialog.kind,
      ...(dialog.kind === "withdraw" ? { reason: text("reason") } : {}),
    });
    if (!parsed.success) {
      setError(t("checklist.reasonInvalid"));
      return;
    }
    void run(
      () =>
        liveRequest(
          `/projects/${projectId}/quality/completion/${dialog.certificate.id}/actions`,
          completionResponseSchema,
          { method: "POST", body: parsed.data },
        ),
      () => setDialog(null),
    );
  }

  const certificate = (kind: CompletionKind, value: CompletionCertificate | null) => (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{t(`completion.${kind}Title`)}</h3>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t(`completion.${kind}Hint`)}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {value ? (
          <>
            <StatusBadge
              tone={statusTone[value.status]}
              className="h-auto whitespace-normal text-left"
            >
              {t(`completionStatus.${value.status}`)}
            </StatusBadge>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("completion.date")}</dt>
                <dd>{formatCalendarDate(value.completionDate)}</dd>
              </div>
              {value.dlpMonths !== null && value.dlpEndsOn ? (
                <div>
                  <dt className="text-muted-foreground">{t("completion.dlp")}</dt>
                  <dd>
                    {t("completion.dlpValue", {
                      months: value.dlpMonths,
                      end: formatCalendarDate(value.dlpEndsOn),
                    })}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-muted-foreground">{t("completion.proposedBy")}</dt>
                <dd>
                  {value.proposedBy.displayName}, {formatDateTime(value.proposedAt)}
                </dd>
              </div>
              {value.certifiedBy && value.certifiedAt ? (
                <div>
                  <dt className="text-muted-foreground">{t("completion.certifiedBy")}</dt>
                  <dd>
                    {value.certifiedBy.displayName}, {formatDateTime(value.certifiedAt)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-muted-foreground">{t("completion.snagsAtCheck")}</dt>
                <dd>
                  {t("completion.snagCounts", {
                    open: value.openSnags,
                    critical: value.openCriticalSnags,
                  })}
                </dd>
              </div>
            </dl>
            {value.exceptionReason ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 break-words">
                {t("completion.exception", { reason: value.exceptionReason })}
              </p>
            ) : null}
            {value.notes ? <p className="break-words whitespace-pre-wrap">{value.notes}</p> : null}
            {value.status === "certified" ? (
              <p className="text-muted-foreground">{t("completion.locked")}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {value.permissions.canCertify ? (
                <Button
                  disabled={busy}
                  onClick={() => show({ kind: "certify", certificate: value })}
                >
                  {t(`completion.certify.${kind}`)}
                </Button>
              ) : null}
              {value.permissions.canWithdraw ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => show({ kind: "withdraw", certificate: value })}
                >
                  {t("completion.withdraw")}
                </Button>
              ) : null}
            </div>
            {value.status === "proposed" && !value.permissions.canCertify ? (
              <p className="text-muted-foreground">{t("completion.awaitingCertifier")}</p>
            ) : null}
          </>
        ) : (
          <>
            <p>{t("completion.none")}</p>
            {data.permissions.canPropose &&
            (kind === "practical" || data.practical?.status === "certified") ? (
              <Button disabled={busy} onClick={() => show({ kind: "propose", certificate: kind })}>
                {t(`completion.propose.${kind}`)}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );

  const { readiness, dlp } = data;
  const blockers =
    dialog?.kind === "propose"
      ? dialog.certificate === "practical"
        ? readiness.practicalBlockers
        : readiness.finalBlockers
      : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>{t("completion.readinessTitle")}</h3>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            {t("completion.readiness", {
              open: readiness.openSnags,
              critical: readiness.openCriticalSnags,
            })}{" "}
            <Link
              className="underline"
              href={qualityHref(projectId, "snags", { status: "active" })}
            >
              {t("completion.viewSnags")}
            </Link>
          </p>
          {readiness.practicalBlockers.includes("open_critical_snags") ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
              {t("completion.blocked")}
            </p>
          ) : null}
          <p className="text-muted-foreground">{t("completion.retentionNote")}</p>
        </CardContent>
      </Card>
      {certificate("practical", data.practical)}
      {dlp ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>{t("completion.dlpTitle")}</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <StatusBadge
              tone={dlp.state === "running" ? "info" : "neutral"}
              className="h-auto whitespace-normal text-left"
            >
              {dlp.state === "running"
                ? t("completion.dlpRunning", { days: dlp.daysRemaining })
                : t("completion.dlpEnded")}
            </StatusBadge>
            <p>
              {t("completion.dlpDates", {
                start: formatCalendarDate(dlp.startsOn),
                end: formatCalendarDate(dlp.endsOn),
                months: dlp.months,
              })}
            </p>
            <p>
              {t("completion.dlpDefects", {
                open: dlp.defects.open,
                fixed: dlp.defects.fixed,
                closed: dlp.defects.closed,
              })}{" "}
              <Link className="underline" href={qualityHref(projectId, "snags", { phase: "dlp" })}>
                {t("completion.viewDefects")}
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : null}
      {certificate("final", data.final)}
      {data.history.some((entry) => entry.status === "withdrawn") ? (
        <section aria-labelledby="completion-history" className="space-y-2 text-sm">
          <h3 id="completion-history" className="font-semibold">
            {t("completion.history")}
          </h3>
          <ul className="space-y-2">
            {data.history
              .filter((entry) => entry.status === "withdrawn")
              .map((entry) => (
                <li key={entry.id} className="rounded-md border p-3 break-words">
                  {t("completion.withdrawnEntry", {
                    kind: t(`completion.${entry.kind}Title`),
                    date: formatCalendarDate(entry.completionDate),
                    reason: entry.withdrawReason ?? "",
                  })}
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setDialog(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "propose"
                ? t(`completion.propose.${dialog.certificate}`)
                : dialog?.kind === "certify"
                  ? t(`completion.certify.${dialog.certificate.kind}`)
                  : t("completion.withdraw")}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "certify"
                ? t("completion.certifyHint")
                : dialog?.kind === "withdraw"
                  ? t("completion.withdrawHint")
                  : t("completion.proposeHint")}
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit(new FormData(event.currentTarget));
            }}
          >
            <FormError message={error} />
            {dialog?.kind === "propose" ? (
              <>
                {blockers.length ? (
                  <ul className="list-disc space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 pl-6 text-sm">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{t(`completion.blocker.${blocker}`)}</li>
                    ))}
                  </ul>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="completion-date">{t("completion.date")}</FieldLabel>
                  <Input
                    id="completion-date"
                    name="completionDate"
                    placeholder="DD/MM/YYYY"
                    defaultValue={calendarInput(nairobiDate())}
                  />
                </Field>
                {dialog.certificate === "practical" ? (
                  <Field>
                    <FieldLabel htmlFor="completion-dlp">{t("completion.dlpMonths")}</FieldLabel>
                    <Input
                      id="completion-dlp"
                      name="dlpMonths"
                      inputMode="numeric"
                      defaultValue={String(data.defaultDlpMonths)}
                      aria-describedby="completion-dlp-hint"
                    />
                    <FieldDescription id="completion-dlp-hint">
                      {t("completion.dlpMonthsHint", { months: data.defaultDlpMonths })}
                    </FieldDescription>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="completion-exception">
                    {t("completion.exceptionReason")}
                  </FieldLabel>
                  <Textarea
                    id="completion-exception"
                    name="exceptionReason"
                    maxLength={500}
                    aria-describedby="completion-exception-hint"
                  />
                  <FieldDescription id="completion-exception-hint">
                    {t("completion.exceptionHint")}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="completion-notes">{t("fields.notes")}</FieldLabel>
                  <Textarea id="completion-notes" name="notes" maxLength={1000} />
                </Field>
              </>
            ) : null}
            {dialog?.kind === "withdraw" ? (
              <Field>
                <FieldLabel htmlFor="completion-reason">{t("fields.reason")}</FieldLabel>
                <Textarea
                  id="completion-reason"
                  name="reason"
                  minLength={3}
                  maxLength={500}
                  required
                />
              </Field>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
