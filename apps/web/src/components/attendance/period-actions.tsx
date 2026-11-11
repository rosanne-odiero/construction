"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2, RotateCcw, Send, XCircle } from "lucide-react";
import { addCalendarDays } from "@pm-buddy/domain";
import {
  adjustmentResponseSchema,
  periodDetailResponseSchema,
  type Adjustment,
  type PeriodDetailResponse,
} from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { attendanceCommand, draftOf, entryOf, hours, type EntryDraft } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { DecisionBadge } from "./attendance-badges";
import { EntryFields, RejectDialog, valuesText } from "./muster-roll";

type Dialog =
  | { kind: "reject-period" }
  | { kind: "request" }
  | { kind: "reject-adjustment"; adjustment: Adjustment }
  | null;

/**
 * Period commands (submit, approve, reject, reopen) and adjustments. The API enforces every rule
 * (cut-off, confirmed days, open anomalies, distinct approver, digest of the submitted lines);
 * buttons only follow the permissions the API reports.
 */
export function PeriodActions({
  period: data,
  sites,
}: {
  period: PeriodDetailResponse;
  sites: { id: string; name: string }[];
}) {
  const t = useTranslations("attendanceLive.period");
  const tl = useTranslations("attendanceLive");
  const router = useRouter();
  const problem = useProblemMessage();
  const stepUp = useStepUp();
  const { period, permissions, adjustments } = data;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      setNotice({ error: false, text: success });
      router.refresh();
    } catch (error) {
      setNotice({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  };
  const command = (action: "submit" | "approve" | "reopen") =>
    run(
      () =>
        attendanceCommand(
          `/attendance/periods/${period.id}/${action}`,
          periodDetailResponseSchema,
          {
            version: period.version,
          },
        ),
      t(`done.${action}`),
    );
  const approveAdjustment = (adjustment: Adjustment) =>
    run(
      () =>
        attendanceCommand(
          `/attendance/adjustments/${adjustment.id}/approve`,
          adjustmentResponseSchema,
          {
            version: adjustment.version,
          },
        ),
      t("adjustments.approved"),
    );

  return (
    <section aria-label={t("actions")} className="space-y-4">
      {stepUp.dialog}
      <div className="flex flex-wrap gap-2">
        {permissions.canSubmit ? (
          <Button onClick={() => void command("submit")} disabled={busy}>
            <Send aria-hidden /> {t("submit")}
          </Button>
        ) : null}
        {permissions.canApprove ? (
          <>
            <Button onClick={() => void command("approve")} disabled={busy}>
              <CheckCircle2 aria-hidden /> {t("approve")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog({ kind: "reject-period" })}
              disabled={busy}
            >
              <XCircle aria-hidden /> {t("reject")}
            </Button>
          </>
        ) : null}
        {permissions.canReopen ? (
          <Button variant="outline" onClick={() => void command("reopen")} disabled={busy}>
            <RotateCcw aria-hidden /> {t("reopen")}
          </Button>
        ) : null}
        {permissions.canRequestAdjustment ? (
          <Button variant="outline" onClick={() => setDialog({ kind: "request" })} disabled={busy}>
            {t("adjustments.request")}
          </Button>
        ) : null}
      </div>
      {period.status === "submitted" && !permissions.canApprove ? (
        <p className="text-sm text-muted-foreground">{t("awaitingOther")}</p>
      ) : null}
      {period.status === "approved" ? (
        <p className="text-sm text-muted-foreground">{t("lockedNote")}</p>
      ) : null}
      <p
        role={notice?.error ? "alert" : "status"}
        className={notice?.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {notice?.text ?? ""}
      </p>

      {adjustments.requested.length > 0 || adjustments.landed.length > 0 ? (
        <section aria-labelledby="adjustments-heading" className="space-y-2">
          <h2 id="adjustments-heading" className="text-base font-semibold">
            {t("adjustments.title")}
          </h2>
          <ul className="space-y-2">
            {[...adjustments.requested, ...adjustments.landed]
              .filter(
                (entry, index, all) => all.findIndex((other) => other.id === entry.id) === index,
              )
              .map((adjustment) => (
                <li key={adjustment.id} className="space-y-1 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{adjustment.fullName}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {adjustment.workerNo}
                    </span>
                    <DecisionBadge status={adjustment.status} />
                  </div>
                  <p>
                    {t("adjustments.change", {
                      date: formatCalendarDate(adjustment.date),
                      site: adjustment.siteName,
                      from: adjustment.previous ? valuesText(adjustment.previous, tl) : "—",
                      to: valuesText(adjustment.proposed, tl),
                    })}
                  </p>
                  <p className="text-muted-foreground">
                    {t("adjustments.requested", {
                      name: adjustment.requestedBy.displayName,
                      at: formatDateTime(adjustment.requestedAt),
                      reason: adjustment.reason,
                    })}
                  </p>
                  {adjustment.delta ? (
                    <p className="text-muted-foreground">
                      {t("adjustments.delta", {
                        days: adjustment.delta.days,
                        worked: hours(adjustment.delta.workedMinutes),
                      })}
                    </p>
                  ) : null}
                  {adjustment.targetPeriodId && adjustment.targetPeriodId !== period.id ? (
                    <Link
                      href={`/attendance/periods/${adjustment.targetPeriodId}`}
                      className="text-sm underline underline-offset-4"
                    >
                      {t("adjustments.target")}
                    </Link>
                  ) : null}
                  {adjustment.targetPeriodId === period.id &&
                  adjustment.originalPeriodId !== period.id ? (
                    <Link
                      href={`/attendance/periods/${adjustment.originalPeriodId}`}
                      className="text-sm underline underline-offset-4"
                    >
                      {t("adjustments.original")}
                    </Link>
                  ) : null}
                  {adjustment.status === "pending" && permissions.canDecideAdjustments ? (
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() => void approveAdjustment(adjustment)}
                        disabled={busy}
                      >
                        {t("adjustments.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog({ kind: "reject-adjustment", adjustment })}
                        disabled={busy}
                      >
                        {t("adjustments.reject")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <RejectDialog
        open={dialog?.kind === "reject-period"}
        title={t("rejectTitle")}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        onSubmit={async (reason) => {
          await attendanceCommand(
            `/attendance/periods/${period.id}/reject`,
            periodDetailResponseSchema,
            { version: period.version, reason },
          );
          setNotice({ error: false, text: t("done.reject") });
          router.refresh();
        }}
      />
      <RejectDialog
        open={dialog?.kind === "reject-adjustment"}
        title={t("adjustments.rejectTitle")}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        onSubmit={async (note) => {
          if (dialog?.kind !== "reject-adjustment") return;
          await attendanceCommand(
            `/attendance/adjustments/${dialog.adjustment.id}/reject`,
            adjustmentResponseSchema,
            { version: dialog.adjustment.version, note },
          );
          setNotice({ error: false, text: t("adjustments.rejected") });
          router.refresh();
        }}
      />
      {dialog?.kind === "request" ? (
        <AdjustmentDialog
          data={data}
          sites={sites}
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          onSubmit={async (body) => {
            await stepUp.run(() =>
              attendanceCommand(
                `/attendance/periods/${period.id}/adjustments`,
                adjustmentResponseSchema,
                body,
              ),
            );
            setNotice({ error: false, text: t("adjustments.sent") });
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function AdjustmentDialog({
  data,
  sites,
  onOpenChange,
  onSubmit,
}: {
  data: PeriodDetailResponse;
  sites: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("attendanceLive");
  const workers = data.lines
    .filter((line) => line.kind === "attendance")
    .map((line) => ({ id: line.labourerId, name: `${line.fullName} (${line.workerNo})` }));
  const dates: string[] = [];
  for (
    let date = data.period.startDate;
    date <= data.period.endDate;
    date = addCalendarDays(date, 1)
  )
    dates.push(date);
  const [labourerId, setLabourerId] = useState(workers[0]?.id ?? "");
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [date, setDate] = useState(dates[0] ?? "");
  const [draft, setDraft] = useState<EntryDraft>({
    ...draftOf(null),
    status: "present",
    checkIn: "07:00",
    checkOut: "16:00",
  });
  const [reason, setReason] = useState("");
  const entry = entryOf(draft);
  return (
    <ActionDialog
      id="request-adjustment"
      open
      onOpenChange={onOpenChange}
      title={t("period.adjustments.requestTitle")}
      description={t("period.adjustments.requestDescription")}
      submitLabel={t("period.adjustments.requestSubmit")}
      submitDisabled={!entry || !labourerId || !siteId || !date || reason.trim().length < 10}
      onSubmit={() => onSubmit({ labourerId, siteId, date, ...entry!, reason: reason.trim() })}
    >
      <Field>
        <FieldLabel htmlFor="adjustment-worker">{t("period.lines.worker")}</FieldLabel>
        <select
          id="adjustment-worker"
          value={labourerId}
          onChange={(event) => setLabourerId(event.target.value)}
          className={selectClass}
        >
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="adjustment-site">{t("common.site")}</FieldLabel>
          <select
            id="adjustment-site"
            value={siteId}
            onChange={(event) => setSiteId(event.target.value)}
            className={selectClass}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="adjustment-date">{t("common.date")}</FieldLabel>
          <select
            id="adjustment-date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={selectClass}
          >
            {dates.map((entry) => (
              <option key={entry} value={entry}>
                {formatCalendarDate(entry)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <EntryFields
        idPrefix="adjustment"
        draft={draft}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
      <Field>
        <FieldLabel htmlFor="adjustment-reason">{t("common.reason")}</FieldLabel>
        <Textarea
          id="adjustment-reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby="adjustment-reason-hint"
        />
        <FieldDescription id="adjustment-reason-hint">{t("common.reasonHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}
