"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CheckCheck, Save, Send, ShieldCheck, Undo2 } from "lucide-react";
import { ATTENDANCE_STATUSES } from "@pm-buddy/types";
import {
  correctionResponseSchema,
  musterResponseSchema,
  saveMusterRequestSchema,
  type AttendanceEntryValues,
  type Correction,
  type MusterResponse,
  type MusterRow,
} from "@pm-buddy/validation";
import { ActionDialog, selectClass } from "@/components/labour/action-dialog";
import { DoNotRehireBadge, LabourerStatusBadge } from "@/components/labour/labour-badges";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  attendanceCommand,
  defaultShift,
  draftOf,
  entryOf,
  hours,
  sameEntry,
  WORKED,
  type EntryDraft,
} from "@/lib/attendance";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import {
  AnomalyBadge,
  AttendanceStatusBadge,
  DayStatusBadge,
  DecisionBadge,
  PeriodStatusBadge,
} from "./attendance-badges";

type Dialog =
  | { kind: "return" }
  | { kind: "correct"; row: MusterRow }
  | { kind: "reject"; correction: Correction }
  | null;

const timeClass = "h-8 w-[5.5rem] px-2 tabular-nums";

/**
 * The editable muster roll of one site and day (brief §5.5): status, check-in/out, overnight
 * shifts, breaks and notes per engaged labourer, saved in one request with the versions read.
 * A recorder submits the day; a different person confirms or returns it. After submission,
 * changes are corrections with a reason, a fresh step-up and a distinct approver.
 */
export function MusterRoll({ muster }: { muster: MusterResponse }) {
  const t = useTranslations("attendanceLive.muster");
  const tl = useTranslations("attendanceLive");
  const locale = useLocale();
  const router = useRouter();
  const problem = useProblemMessage();
  const stepUp = useStepUp();
  const { rows, day, permissions, rule } = muster;
  const initial = useMemo(
    () => new Map(rows.map((row) => [row.labourer.id, draftOf(row.record)])),
    [rows],
  );
  const [drafts, setDrafts] = useState(initial);
  // Fresh data from the API (after a save or a refresh) replaces the drafts.
  const [source, setSource] = useState(initial);
  if (source !== initial) {
    setSource(initial);
    setDrafts(initial);
  }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const editable = muster.editable && permissions.canRecord;
  const draftFor = (id: string) => drafts.get(id) ?? draftOf(null);
  const changed = rows.filter(
    (row) =>
      row.labourer.engaged &&
      draftFor(row.labourer.id).status !== "" &&
      !sameEntry(draftFor(row.labourer.id), initial.get(row.labourer.id) ?? draftOf(null)),
  );
  const unrecorded = rows.filter(
    (row) => row.labourer.engaged && draftFor(row.labourer.id).status === "",
  );
  const correctable =
    permissions.canOverride &&
    day !== null &&
    (muster.locked === "day-submitted" || muster.locked === "day-confirmed");
  const pendingCorrections = muster.corrections.filter((entry) => entry.status === "pending");
  const name = (row: MusterRow) => row.labourer.fullName;

  const update = (id: string, patch: Partial<EntryDraft>) =>
    setDrafts((current) => {
      const next = new Map(current);
      const draft = { ...(next.get(id) ?? draftOf(null)), ...patch };
      // A worked status gets the rule's default shift when no times are entered yet.
      if (patch.status && WORKED.has(patch.status) && !draft.checkIn && !draft.checkOut) {
        const shift = defaultShift(rule);
        draft.checkIn = shift.checkIn;
        draft.checkOut = patch.status === "half_day" ? halfDayEnd(shift.checkIn) : shift.checkOut;
      }
      next.set(id, draft);
      return next;
    });

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

  const save = () => {
    if (!changed.length || busy) return;
    const body = {
      siteId: muster.site.id,
      date: muster.date,
      dayVersion: day?.version ?? 0,
      entries: changed.map((row) => ({
        labourerId: row.labourer.id,
        ...entryOf(draftFor(row.labourer.id))!,
        version: row.record?.version ?? 0,
      })),
    };
    const parsed = saveMusterRequestSchema.safeParse(body);
    if (!parsed.success) {
      const bad = new Set<string>();
      for (const issue of parsed.error.issues) {
        const index = issue.path[1];
        if (issue.path[0] === "entries" && typeof index === "number")
          bad.add(body.entries[index]!.labourerId);
      }
      setInvalid(bad);
      const first = rows.find((row) => bad.has(row.labourer.id));
      setNotice({
        error: true,
        text: first ? t("invalidRow", { name: name(first) }) : t("invalid"),
      });
      return;
    }
    setInvalid(new Set());
    void run(
      () =>
        attendanceCommand(
          `/attendance/projects/${muster.project.id}/muster`,
          musterResponseSchema,
          body,
          "PUT",
        ),
      t("saved", { count: changed.length }),
    );
  };

  const markPresent = () => {
    const shift = defaultShift(rule);
    setDrafts((current) => {
      const next = new Map(current);
      for (const row of unrecorded)
        next.set(row.labourer.id, {
          ...draftOf(null),
          status: "present",
          checkIn: shift.checkIn,
          checkOut: shift.checkOut,
        });
      return next;
    });
  };

  const dayAction = (action: "submit" | "confirm") =>
    run(
      () =>
        attendanceCommand(`/attendance/days/${day!.id}/${action}`, musterResponseSchema, {
          version: day!.version,
        }),
      t(action === "submit" ? "submitted" : "confirmed"),
    );

  const decide = (correction: Correction) =>
    run(
      () =>
        attendanceCommand(
          `/attendance/corrections/${correction.id}/approve`,
          correctionResponseSchema,
          {
            version: correction.version,
          },
        ),
      t("corrections.approved"),
    );

  return (
    <div className="space-y-4">
      {stepUp.dialog}
      <section
        aria-label={t("summary")}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3 text-sm"
      >
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("day")}</span>
          <DayStatusBadge status={day?.status ?? null} />
        </span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("period")}</span>
          <span className="tabular-nums">
            {formatCalendarDate(muster.period.startDate)} –{" "}
            {formatCalendarDate(muster.period.endDate)}
          </span>
          <PeriodStatusBadge status={muster.period.status} />
        </span>
        {muster.dayType ? (
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">{t("dayType")}</span>
            <StatusBadge tone={muster.dayType === "weekday" ? "neutral" : "info"}>
              {tl(`dayType.${muster.dayType}`)}
            </StatusBadge>
            {muster.holiday ? (
              <span>{locale === "sw" ? muster.holiday.nameSw : muster.holiday.nameEn}</span>
            ) : null}
          </span>
        ) : null}
        {rule ? (
          <span className="text-muted-foreground">
            {t("ruleSummary", {
              normal: hours(rule.normalMinutes),
              start: defaultShift(rule).checkIn,
              grace: rule.lateGraceMinutes,
            })}
          </span>
        ) : (
          <span role="note" className="text-warning-foreground dark:text-warning">
            {t("noRule")}{" "}
            <Link href="/attendance/settings" className="underline underline-offset-4">
              {t("noRuleLink")}
            </Link>
          </span>
        )}
      </section>

      {day?.submittedBy ? (
        <p className="text-sm text-muted-foreground">
          {t("submittedBy", {
            name: day.submittedBy.displayName,
            at: formatDateTime(day.submittedAt ?? ""),
          })}
          {day.confirmedBy
            ? ` · ${t("confirmedBy", {
                name: day.confirmedBy.displayName,
                at: formatDateTime(day.confirmedAt ?? ""),
              })}`
            : null}
        </p>
      ) : null}
      {day?.returnReason && day.status === "draft" ? (
        <p role="note" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("returned", {
            name: day.returnedBy?.displayName ?? "—",
            reason: day.returnReason,
          })}
        </p>
      ) : null}
      {muster.locked ? (
        <p role="note" className="rounded-md border bg-muted/40 p-3 text-sm">
          {t(`locked.${muster.locked}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <>
            <Button
              onClick={save}
              disabled={busy || changed.length === 0}
              className="h-auto min-h-9 whitespace-normal"
            >
              <Save aria-hidden /> {t("save", { count: changed.length })}
            </Button>
            <Button
              variant="outline"
              onClick={markPresent}
              disabled={busy || unrecorded.length === 0}
              className="h-auto min-h-9 whitespace-normal text-left"
            >
              <CheckCheck aria-hidden /> {t("markPresent", { count: unrecorded.length })}
            </Button>
          </>
        ) : null}
        {day && day.status === "draft" && permissions.canRecord && !muster.locked ? (
          <Button
            variant="outline"
            onClick={() => void dayAction("submit")}
            disabled={busy || changed.length > 0}
          >
            <Send aria-hidden /> {t("submit")}
          </Button>
        ) : null}
        {day && day.status === "submitted" && permissions.canConfirm ? (
          <>
            <Button onClick={() => void dayAction("confirm")} disabled={busy}>
              <ShieldCheck aria-hidden /> {t("confirm")}
            </Button>
            <Button variant="outline" onClick={() => setDialog({ kind: "return" })} disabled={busy}>
              <Undo2 aria-hidden /> {t("return")}
            </Button>
          </>
        ) : null}
      </div>
      {editable ? <p className="text-xs text-muted-foreground">{t("keyboardHint")}</p> : null}
      <p
        role={notice?.error ? "alert" : "status"}
        className={notice?.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
      >
        {notice?.text ?? ""}
      </p>

      <form
        aria-label={t("tableLabel")}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        onKeyDown={(event) => {
          const enter = event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT";
          if (enter || (event.key === "s" && (event.ctrlKey || event.metaKey))) {
            event.preventDefault();
            save();
          }
        }}
      >
        <div className="relative overflow-x-auto rounded-lg border">
          <table className="w-full caption-bottom text-sm">
            <caption className="sr-only">{t("tableLabel")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.worker")}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t("columns.status")}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t("columns.in")}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t("columns.out")}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t("columns.overnight")}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t("columns.break")}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t("columns.notes")}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {t("columns.hours")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("columns.flags")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <MusterLine
                  key={row.labourer.id}
                  row={row}
                  draft={draftFor(row.labourer.id)}
                  editable={editable && row.labourer.engaged}
                  invalid={invalid.has(row.labourer.id)}
                  onChange={(patch) => update(row.labourer.id, patch)}
                  onCorrect={
                    correctable && row.labourer.engaged
                      ? () => setDialog({ kind: "correct", row })
                      : undefined
                  }
                />
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                    {t("empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </form>

      <section aria-labelledby="corrections-heading" className="space-y-2">
        <h2 id="corrections-heading" className="text-base font-semibold">
          {t("corrections.title")}
        </h2>
        {muster.corrections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("corrections.none")}</p>
        ) : (
          <ul className="space-y-2">
            {muster.corrections.map((correction) => (
              <li key={correction.id} className="space-y-1 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{correction.fullName}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {correction.workerNo}
                  </span>
                  <DecisionBadge status={correction.status} />
                </div>
                <p>
                  {t("corrections.change", {
                    from: correction.previous ? valuesText(correction.previous, tl) : "—",
                    to: valuesText(correction.proposed, tl),
                  })}
                </p>
                <p className="text-muted-foreground">
                  {t("corrections.requested", {
                    name: correction.requestedBy.displayName,
                    at: formatDateTime(correction.requestedAt),
                    reason: correction.reason,
                  })}
                </p>
                {correction.decidedBy ? (
                  <p className="text-muted-foreground">
                    {t("corrections.decided", {
                      name: correction.decidedBy.displayName,
                      at: formatDateTime(correction.decidedAt ?? ""),
                    })}
                    {correction.decisionNote ? ` — ${correction.decisionNote}` : null}
                  </p>
                ) : null}
                {correction.status === "pending" && permissions.canConfirm ? (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={() => void decide(correction)} disabled={busy}>
                      {t("corrections.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDialog({ kind: "reject", correction })}
                      disabled={busy}
                    >
                      {t("corrections.reject")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {pendingCorrections.length > 0 ? (
          <p className="text-xs text-muted-foreground">{t("corrections.distinct")}</p>
        ) : null}
      </section>

      <ReturnDialog
        open={dialog?.kind === "return"}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        onSubmit={async (reason) => {
          await attendanceCommand(`/attendance/days/${day!.id}/return`, musterResponseSchema, {
            version: day!.version,
            reason,
          });
          setNotice({ error: false, text: t("returnedDone") });
          router.refresh();
        }}
      />
      {dialog?.kind === "correct" ? (
        <CorrectionDialog
          row={dialog.row}
          rule={rule}
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          onSubmit={async (entry, reason) => {
            await stepUp.run(() =>
              attendanceCommand(
                `/attendance/days/${day!.id}/corrections`,
                correctionResponseSchema,
                {
                  labourerId: dialog.row.labourer.id,
                  ...entry,
                  reason,
                  recordVersion: dialog.row.record?.version ?? 0,
                },
              ),
            );
            setNotice({ error: false, text: t("corrections.sent") });
            router.refresh();
          }}
        />
      ) : null}
      <RejectDialog
        open={dialog?.kind === "reject"}
        title={t("corrections.rejectTitle")}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        onSubmit={async (note) => {
          if (dialog?.kind !== "reject") return;
          await attendanceCommand(
            `/attendance/corrections/${dialog.correction.id}/reject`,
            correctionResponseSchema,
            { version: dialog.correction.version, note },
          );
          setNotice({ error: false, text: t("corrections.rejected") });
          router.refresh();
        }}
      />
    </div>
  );
}

const halfDayEnd = (checkIn: string) => {
  const [h, m] = checkIn.split(":").map(Number);
  const end = Math.min((h ?? 7) * 60 + (m ?? 0) + 270, 23 * 60 + 59);
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
};

type T = ReturnType<typeof useTranslations<"attendanceLive">>;

/** "Present 07:00–16:00" style text for a correction or adjustment. */
export function valuesText(values: AttendanceEntryValues, t: T): string {
  const status = t(`status.${values.status}`);
  if (!values.checkIn || !values.checkOut) return status;
  return `${status} ${values.checkIn}–${values.checkOut}${values.overnight ? ` (${t("muster.overnightShort")})` : ""}`;
}

function MusterLine({
  row,
  draft,
  editable,
  invalid,
  onChange,
  onCorrect,
}: {
  row: MusterRow;
  draft: EntryDraft;
  editable: boolean;
  invalid: boolean;
  onChange: (patch: Partial<EntryDraft>) => void;
  onCorrect: (() => void) | undefined;
}) {
  const t = useTranslations("attendanceLive.muster");
  const tl = useTranslations("attendanceLive");
  const locale = useLocale();
  const { labourer, record } = row;
  const worked = draft.status !== "" && WORKED.has(draft.status);
  const label = (column: string) => `${column}: ${labourer.fullName}`;
  const computed = record?.computed ?? null;

  return (
    <tr className={`border-b align-top last:border-0 ${invalid ? "bg-destructive/5" : ""}`}>
      <th scope="row" className="px-3 py-2 text-left font-normal">
        <span className="block font-medium">{labourer.fullName}</span>
        <span className="block text-xs text-muted-foreground">
          <span className="font-mono">{labourer.workerNo}</span> ·{" "}
          {locale === "sw" ? labourer.tradeNameSw : labourer.tradeNameEn}
          {labourer.gangName ? ` · ${labourer.gangName}` : null}
        </span>
        <span className="mt-1 flex flex-wrap gap-1">
          {labourer.status !== "active" ? <LabourerStatusBadge status={labourer.status} /> : null}
          {labourer.doNotRehire ? <DoNotRehireBadge /> : null}
          {!labourer.engaged ? <StatusBadge tone="neutral">{t("notEngaged")}</StatusBadge> : null}
          {record?.corrected ? <StatusBadge tone="info">{t("corrected")}</StatusBadge> : null}
        </span>
      </th>
      {editable ? (
        <>
          <td className="px-2 py-2">
            <select
              aria-label={label(t("columns.status"))}
              aria-invalid={invalid || undefined}
              value={draft.status}
              onChange={(event) => onChange({ status: event.target.value as EntryDraft["status"] })}
              className={`${selectClass} h-8 w-32`}
            >
              {record ? null : <option value="">{t("notRecorded")}</option>}
              {ATTENDANCE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {tl(`status.${status}`)}
                </option>
              ))}
            </select>
          </td>
          <td className="px-2 py-2">
            <Input
              type="time"
              aria-label={label(t("columns.in"))}
              aria-invalid={invalid || undefined}
              value={draft.checkIn}
              disabled={!worked}
              onChange={(event) => onChange({ checkIn: event.target.value })}
              className={timeClass}
            />
          </td>
          <td className="px-2 py-2">
            <Input
              type="time"
              aria-label={label(t("columns.out"))}
              aria-invalid={invalid || undefined}
              value={draft.checkOut}
              disabled={!worked}
              onChange={(event) => onChange({ checkOut: event.target.value })}
              className={timeClass}
            />
          </td>
          <td className="px-2 py-2 text-center">
            <Checkbox
              aria-label={label(t("columns.overnight"))}
              checked={draft.overnight}
              disabled={!worked}
              onCheckedChange={(checked) => onChange({ overnight: checked === true })}
            />
          </td>
          <td className="px-2 py-2">
            <Input
              inputMode="numeric"
              aria-label={label(t("columns.break"))}
              placeholder={t("breakDefault")}
              value={draft.breakMinutes}
              disabled={!worked}
              onChange={(event) => onChange({ breakMinutes: event.target.value })}
              className="h-8 w-20 px-2 tabular-nums"
            />
          </td>
          <td className="px-2 py-2">
            <Input
              aria-label={label(t("columns.notes"))}
              value={draft.notes}
              maxLength={500}
              onChange={(event) => onChange({ notes: event.target.value })}
              className="h-8 w-40 px-2"
            />
          </td>
        </>
      ) : (
        <>
          <td className="px-2 py-2">
            {record ? (
              <AttendanceStatusBadge status={record.status} />
            ) : (
              <span className="text-muted-foreground">{t("notRecorded")}</span>
            )}
          </td>
          <td className="px-2 py-2 tabular-nums">{record?.checkIn ?? "—"}</td>
          <td className="px-2 py-2 tabular-nums">
            {record?.checkOut ?? "—"}
            {record?.overnight ? (
              <span className="block text-xs text-muted-foreground">{t("overnightShort")}</span>
            ) : null}
          </td>
          <td className="px-2 py-2">{record?.overnight ? t("yes") : "—"}</td>
          <td className="px-2 py-2 tabular-nums">
            {computed && worked ? computed.breakMinutes : "—"}
          </td>
          <td className="px-2 py-2 text-xs">{record?.notes ?? "—"}</td>
        </>
      )}
      <td className="px-2 py-2 text-right tabular-nums">
        {computed && record && WORKED.has(record.status) ? (
          <>
            <span className="block">{hours(computed.workedMinutes)}</span>
            {computed.overtimeMinutes > 0 ? (
              <span className="block text-xs text-muted-foreground">
                {t("overtime", { hours: hours(computed.overtimeMinutes) })}
              </span>
            ) : null}
            {computed.lateMinutes > 0 ? (
              <span className="block text-xs text-warning-foreground dark:text-warning">
                {t("late", { minutes: computed.lateMinutes })}
              </span>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">
        <span className="flex flex-wrap gap-1">
          {row.anomalies.map((anomaly) => (
            <AnomalyBadge key={anomaly.id} kind={anomaly.kind} status={anomaly.status} />
          ))}
        </span>
        {row.otherSites.map((other) => (
          <span key={other.siteId} className="block text-xs text-muted-foreground">
            {t("otherSite", {
              site: other.siteName,
              project: other.projectCode,
              status: tl(`status.${other.status}`),
            })}
          </span>
        ))}
        {onCorrect ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-1"
            onClick={onCorrect}
            aria-label={t("correctFor", { name: labourer.fullName })}
          >
            {t("correct")}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function ReturnDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const t = useTranslations("attendanceLive");
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      id="return-day"
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
      title={t("muster.returnTitle")}
      description={t("muster.returnDescription")}
      submitLabel={t("muster.return")}
      submitDisabled={reason.trim().length < 10}
      onSubmit={() => onSubmit(reason.trim())}
    >
      <Field>
        <FieldLabel htmlFor="return-reason">{t("common.reason")}</FieldLabel>
        <Textarea
          id="return-reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby="return-reason-hint"
        />
        <FieldDescription id="return-reason-hint">{t("common.reasonHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}

/** A reject or dismiss dialog with the required note (10–500 characters). */
export function RejectDialog({
  open,
  title,
  submitLabel,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (note: string) => Promise<void>;
}) {
  const t = useTranslations("attendanceLive.common");
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      id="reject-decision"
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote("");
        onOpenChange(next);
      }}
      title={title}
      submitLabel={submitLabel ?? t("reject")}
      destructive
      submitDisabled={note.trim().length < 10}
      onSubmit={() => onSubmit(note.trim())}
    >
      <Field>
        <FieldLabel htmlFor="reject-note">{t("reason")}</FieldLabel>
        <Textarea
          id="reject-note"
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          aria-describedby="reject-note-hint"
        />
        <FieldDescription id="reject-note-hint">{t("reasonHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}

/**
 * The values form shared by corrections (before approval) and adjustments (after approval): the
 * proposed status, times, break and notes with the required reason.
 */
export function EntryFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: EntryDraft;
  onChange: (patch: Partial<EntryDraft>) => void;
}) {
  const t = useTranslations("attendanceLive");
  const worked = draft.status !== "" && WORKED.has(draft.status);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-status`}>{t("muster.columns.status")}</FieldLabel>
        <select
          id={`${idPrefix}-status`}
          value={draft.status}
          onChange={(event) => onChange({ status: event.target.value as EntryDraft["status"] })}
          className={selectClass}
        >
          {ATTENDANCE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`status.${status}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-break`}>{t("muster.columns.break")}</FieldLabel>
        <Input
          id={`${idPrefix}-break`}
          inputMode="numeric"
          placeholder={t("muster.breakDefault")}
          value={draft.breakMinutes}
          disabled={!worked}
          onChange={(event) => onChange({ breakMinutes: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-in`}>{t("muster.columns.in")}</FieldLabel>
        <Input
          id={`${idPrefix}-in`}
          type="time"
          value={draft.checkIn}
          disabled={!worked}
          onChange={(event) => onChange({ checkIn: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-out`}>{t("muster.columns.out")}</FieldLabel>
        <Input
          id={`${idPrefix}-out`}
          type="time"
          value={draft.checkOut}
          disabled={!worked}
          onChange={(event) => onChange({ checkOut: event.target.value })}
        />
      </Field>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Checkbox
          id={`${idPrefix}-overnight`}
          checked={draft.overnight}
          disabled={!worked}
          onCheckedChange={(checked) => onChange({ overnight: checked === true })}
        />
        <label htmlFor={`${idPrefix}-overnight`} className="text-sm">
          {t("muster.overnightLabel")}
        </label>
      </div>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={`${idPrefix}-notes`}>{t("muster.columns.notes")}</FieldLabel>
        <Input
          id={`${idPrefix}-notes`}
          value={draft.notes}
          maxLength={500}
          onChange={(event) => onChange({ notes: event.target.value })}
        />
      </Field>
    </div>
  );
}

function CorrectionDialog({
  row,
  rule,
  onOpenChange,
  onSubmit,
}: {
  row: MusterRow;
  rule: MusterResponse["rule"];
  onOpenChange: (open: boolean) => void;
  onSubmit: (entry: NonNullable<ReturnType<typeof entryOf>>, reason: string) => Promise<void>;
}) {
  const t = useTranslations("attendanceLive");
  const [draft, setDraft] = useState<EntryDraft>(() =>
    row.record
      ? draftOf(row.record)
      : { ...draftOf(null), status: "present", ...defaultShift(rule) },
  );
  const [reason, setReason] = useState("");
  const entry = entryOf(draft);
  return (
    <ActionDialog
      id="correct-record"
      open
      onOpenChange={onOpenChange}
      title={t("muster.correctTitle", { name: row.labourer.fullName })}
      description={t("muster.correctDescription")}
      submitLabel={t("muster.correctSubmit")}
      submitDisabled={!entry || reason.trim().length < 10}
      onSubmit={() => onSubmit(entry!, reason.trim())}
    >
      <EntryFields
        idPrefix="correction"
        draft={draft}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
      <Field>
        <FieldLabel htmlFor="correction-reason">{t("common.reason")}</FieldLabel>
        <Textarea
          id="correction-reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby="correction-reason-hint"
        />
        <FieldDescription id="correction-reason-hint">{t("common.reasonHint")}</FieldDescription>
      </Field>
    </ActionDialog>
  );
}
