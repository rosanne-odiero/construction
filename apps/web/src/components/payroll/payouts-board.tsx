"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { OBLIGATION_PROGRESS_STATUSES } from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate, formatDateTime, formatKES, formatTime } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { batchTone, payrollCommand } from "@/lib/payroll";
import {
  displayTone,
  payoutsInFlight,
  payslipTone,
  pollDelay,
  progressTone,
} from "@/lib/payouts";
import { CommandDialog, useCommandKey } from "./command-dialog";
import { FlagRow, latestPayout, nextAction, ObligationSheet, type StepUpRun } from "./obligation-sheet";
import { usePayoutProblem } from "./payout-problem";
import { WaiverBanner } from "./waiver-banner";

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};

/**
 * Live payouts of an approved batch (D4.3 §4–§9): float check, manual start with step-up,
 * per-worker status joined from D4.2, flags, carry-forwards, cash and bank records, payslip SMS.
 * While a payout or a first SMS is on its way the board polls every 5 s (one request at a time,
 * backing off on errors, paused while the tab is hidden or when the user pauses it) and stops when
 * nothing is in flight.
 */
export function PayoutsBoard({
  initial,
  userId,
  canDispute,
}: {
  initial: wire.BatchPayoutsResponse;
  userId: string;
  canDispute: boolean;
}) {
  const t = useTranslations("payouts.board");
  const tStatus = useTranslations("payrollLive.values");
  const tv = useTranslations("payouts.values");
  const stepUp = useStepUp();
  const path = `/payroll/batches/${initial.batch.id}/payouts`;
  const [data, setData] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [paused, setPaused] = useState(false);
  const [floatWait, setFloatWait] = useState<{ id: string; polls: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const hidden = useSyncExternalStore(
    subscribeVisibility,
    () => document.hidden,
    () => false,
  );
  const reload = useCallback(async () => {
    const next = await liveRequest(path, wire.batchPayoutsResponseSchema);
    setData(next);
    setUpdatedAt(new Date().toISOString());
    setFailures(0);
    setFloatWait((wait) =>
      wait && next.float.latest?.id !== wait.id && wait.polls < 24
        ? { ...wait, polls: wait.polls + 1 }
        : null,
    );
    return next;
  }, [path]);
  const inFlight = payoutsInFlight(data) || floatWait !== null;
  useEffect(() => {
    if (!inFlight || paused || hidden) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      reload().catch(() => {
        if (!cancelled) setFailures((count) => count + 1);
      });
    }, pollDelay(failures));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inFlight, paused, hidden, failures, data, reload]);

  const { batch, totals } = data;
  const obligation = data.obligations.find((entry) => entry.id === selected) ?? null;
  const counts = OBLIGATION_PROGRESS_STATUSES.filter((status) => totals.byProgress[status] > 0)
    .map((status) => `${tv(`progress.${status}`)}: ${totals.byProgress[status]}`)
    .join(" · ");
  const refresh = () => reload().catch(() => setFailures((count) => count + 1));

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-2">
        <p>
          <Link className="underline" href={`/payroll/batches/${batch.id}`}>
            {t("backToBatch")}
          </Link>
        </p>
        <h2 className="text-lg font-semibold">
          {data.project.code} · {data.project.name}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {formatCalendarDate(batch.periodStart)} – {formatCalendarDate(batch.periodEnd)} ·{" "}
          {t("payDate", { date: formatCalendarDate(batch.payDate) })}
          <StatusBadge tone={batchTone[batch.status]}>{tStatus(batch.status)}</StatusBadge>
        </p>
      </div>
      <WaiverBanner waiver={null} approvedUnderWaiver={data.approvedUnderWaiver} />
      {!data.payoutsEnabled ? (
        <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("paused")}
        </p>
      ) : null}
      <p className="text-sm">
        {t(data.businessHours.open ? "hoursOpen" : "hoursClosed", {
          start: data.businessHours.start,
          end: data.businessHours.end,
        })}
      </p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ["total", formatKES(totals.amountMinor)],
            ["paidTotal", formatKES(totals.paidMinor)],
            ["outstandingTotal", formatKES(totals.outstandingMinor)],
            ["settledCount", `${totals.settled} / ${totals.obligations}`],
            ["chargesBooked", formatKES(totals.chargesMinor)],
            ["carryForwardTotal", formatKES(totals.carryForwardMinor)],
            ["broughtForwardTotal", formatKES(totals.broughtForwardMinor)],
            ["eligibleNow", `${totals.eligible} · ${formatKES(totals.eligibleMinor)}`],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-lg border p-3">
            <dt className="text-muted-foreground">{t(key)}</dt>
            <dd className="font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              inFlight && !paused
                ? "size-2 rounded-full bg-success motion-safe:animate-pulse"
                : "size-2 rounded-full bg-muted-foreground"
            }
          />
          {inFlight ? (paused ? t("livePaused") : t("liveOn")) : t("liveIdle")}
        </span>
        {updatedAt ? (
          <span className="text-muted-foreground">
            {t("updatedAt", { time: formatTime(updatedAt) })}
          </span>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw aria-hidden /> {t("refresh")}
        </Button>
        {inFlight ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {t(paused ? "resumeLive" : "pauseLive")}
          </Button>
        ) : null}
        {failures > 0 ? (
          <span role="alert" className="text-destructive">
            {t("pollFailed")}
          </span>
        ) : null}
      </div>
      <p role="status" className="text-sm">
        {counts || t("nothingYet")}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <FloatCard
          data={data}
          waiting={floatWait !== null}
          onRequested={(check) => {
            if (check.status === "answered") void refresh();
            else setFloatWait({ id: check.id, polls: 0 });
          }}
        />
        <StartCard data={data} stepUp={stepUp.run} onStarted={refresh} />
      </div>

      <section aria-labelledby="workers-heading" className="space-y-2">
        <h2 id="workers-heading" className="text-lg font-semibold">
          {t("workers")}
        </h2>
        <Table aria-label={t("workers")}>
          <TableHeader>
            <TableRow>
              {(
                [
                  "worker",
                  "amount",
                  "paid",
                  "outstanding",
                  "carryForward",
                  "status",
                  "receipt",
                  "nameCheck",
                  "payslipSms",
                  "next",
                ] as const
              ).map((key) => (
                <TableHead key={key}>{t(`columns.${key}`)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.obligations.map((entry) => {
              const latest = latestPayout(entry);
              const next = nextAction(entry);
              return (
                <TableRow key={entry.id}>
                  <TableCell>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-left whitespace-normal"
                      onClick={() => setSelected(entry.id)}
                    >
                      {entry.labourer.fullName} · {entry.labourer.workerNo}
                    </Button>
                  </TableCell>
                  <TableCell>{formatKES(entry.amountMinor)}</TableCell>
                  <TableCell>{formatKES(entry.paidMinor)}</TableCell>
                  <TableCell>{formatKES(entry.outstandingMinor)}</TableCell>
                  <TableCell>
                    {entry.carryForwardMinor ? formatKES(entry.carryForwardMinor) : "—"}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-col items-start gap-1">
                      <StatusBadge tone={progressTone[entry.progress]}>
                        {tv(`progress.${entry.progress}`)}
                      </StatusBadge>
                      {latest ? (
                        <StatusBadge tone={displayTone[latest.displayStatus]}>
                          {tv(`methods.${latest.method}`)}: {tv(`display.${latest.displayStatus}`)}
                        </StatusBadge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {latest?.receipt ?? latest?.reference ?? "—"}
                  </TableCell>
                  <TableCell>
                    {latest?.nameCheck ? (
                      <StatusBadge
                        tone={
                          latest.nameCheck.result === "match"
                            ? "success"
                            : latest.nameCheck.result === "mismatch"
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {tv(`nameCheck.${latest.nameCheck.result}`)}
                      </StatusBadge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={payslipTone[entry.payslip.state]}>
                      {tv(`payslip.${entry.payslip.state}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="min-w-48 text-xs">
                    {next === "none" ? "—" : t(`nextShort.${next}`)}
                  </TableCell>
                </TableRow>
              );
            })}
            {!data.obligations.length ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  {t("noObligations")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">{t("openWorkerHint")}</p>
      </section>

      <FlagsSection data={data} stepUp={stepUp.run} onChanged={refresh} />
      <CarryForwards data={data} />

      {obligation ? (
        <ObligationSheet
          key={obligation.id}
          obligation={obligation}
          data={data}
          userId={userId}
          canDispute={canDispute}
          stepUp={stepUp.run}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      ) : null}
      {stepUp.dialog}
    </div>
  );
}

/**
 * The latest answered float (Account Balance) check, its age and what paying every eligible
 * obligation would need. A balance is a snapshot, not a reservation.
 */
function FloatCard({
  data,
  waiting,
  onRequested,
}: {
  data: wire.BatchPayoutsResponse;
  waiting: boolean;
  onRequested: (check: wire.FloatCheckResponse["check"]) => void;
}) {
  const t = useTranslations("payouts.board");
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { float, totals } = data;
  const required = totals.eligibleMinor + totals.eligibleChargesMinor;
  const headroom =
    float.utilityAvailableMinor === null
      ? null
      : float.utilityAvailableMinor - float.inFlightMinor - required;
  return (
    <section aria-labelledby="float-heading" className="min-w-0 space-y-3 rounded-xl border p-4">
      <h2 id="float-heading" className="text-lg font-semibold">
        {t("floatTitle")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("floatHint")}</p>
      {float.latest ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("utilityBalance")}</dt>
          <dd className="font-semibold">
            {float.utilityAvailableMinor === null ? "—" : formatKES(float.utilityAvailableMinor)}
          </dd>
          <dt className="text-muted-foreground">{t("answeredAt")}</dt>
          <dd>
            {float.latest.answeredAt ? formatDateTime(float.latest.answeredAt) : "—"}
            {float.ageMinutes !== null ? (
              <span className="block text-xs">
                {t("age", { age: float.ageMinutes, max: float.maxAgeMinutes })}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{t("freshness")}</dt>
          <dd>
            <StatusBadge tone={float.fresh ? "success" : "warning"}>
              {t(float.fresh ? "fresh" : "stale")}
            </StatusBadge>
          </dd>
          <dt className="text-muted-foreground">{t("inFlight")}</dt>
          <dd>{formatKES(float.inFlightMinor)}</dd>
          <dt className="text-muted-foreground">{t("required")}</dt>
          <dd>
            {formatKES(required)}
            <span className="block text-xs">
              {t("requiredParts", {
                amount: formatKES(totals.eligibleMinor),
                charges: formatKES(totals.eligibleChargesMinor),
              })}
            </span>
          </dd>
          {headroom !== null ? (
            <>
              <dt className="text-muted-foreground">{t("headroom")}</dt>
              <dd className={headroom < 0 ? "font-semibold text-destructive" : "font-semibold"}>
                {headroom < 0
                  ? t("shortBy", { amount: formatKES(-headroom) })
                  : formatKES(headroom)}
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="text-sm">{t("noFloat")}</p>
      )}
      {waiting ? (
        <p role="status" className="text-sm">
          {t("floatWaiting")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {data.permissions.canFloatCheck ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy || waiting}
          onClick={() => {
            setBusy(true);
            setError(null);
            key.renew();
            payrollCommand(
              `/payroll/batches/${data.batch.id}/float-check`,
              wire.floatCheckResponseSchema,
              {},
              "POST",
              key.value(),
            )
              .then((result) => onRequested(result.check))
              .catch((failure: unknown) => setError(problem(failure)))
              .finally(() => setBusy(false));
          }}
        >
          {t("requestFloat")}
        </Button>
      ) : null}
    </section>
  );
}

/** Starting payouts is manual (owner decision 4): payments.disburse, a fresh float, step-up. */
function StartCard({
  data,
  stepUp,
  onStarted,
}: {
  data: wire.BatchPayoutsResponse;
  stepUp: StepUpRun;
  onStarted: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const eligible = data.obligations.filter(
    (entry) => entry.blockReasons.length === 0 && entry.outstandingMinor > 0,
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<wire.StartPayoutsResponse | null>(null);
  const all = chosen.length === eligible.length;
  const chosenMinor = eligible
    .filter((entry) => chosen.includes(entry.id))
    .reduce((sum, entry) => sum + entry.outstandingMinor, 0);
  const names = new Map(
    data.obligations.map((entry) => [
      entry.id,
      `${entry.labourer.fullName} · ${entry.labourer.workerNo}`,
    ]),
  );
  return (
    <section aria-labelledby="start-heading" className="min-w-0 space-y-3 rounded-xl border p-4">
      <h2 id="start-heading" className="text-lg font-semibold">
        {t("startTitle")}
      </h2>
      <p className="text-sm">
        {t("eligibleSummary", {
          count: data.totals.eligible,
          amount: formatKES(data.totals.eligibleMinor),
          charges: formatKES(data.totals.eligibleChargesMinor),
        })}
      </p>
      {!data.float.fresh ? <p className="text-sm">{t("floatFirst")}</p> : null}
      {!data.businessHours.open ? <p className="text-sm">{t("outsideHoursNote")}</p> : null}
      {data.permissions.canStart ? (
        <CommandDialog
          label={t("start")}
          variant="default"
          disabled={!data.payoutsEnabled || eligible.length === 0}
          title={t("startDialogTitle")}
          description={t("startDialogHint")}
          submitLabel={t("startSubmit")}
          submitDisabled={chosen.length === 0}
          problem={problem}
          onOpen={() => {
            key.renew();
            setChosen(eligible.map((entry) => entry.id));
          }}
          onSubmit={async () => {
            const started = await stepUp(() =>
              payrollCommand(
                `/payroll/batches/${data.batch.id}/payouts`,
                wire.startPayoutsResponseSchema,
                all ? {} : { obligationIds: chosen },
                "POST",
                key.value(),
              ),
            );
            setResult(started);
            await onStarted();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("chooseWorkers")}</legend>
            {eligible.map((entry) => (
              <label key={entry.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={chosen.includes(entry.id)}
                  onChange={(event) => {
                    key.renew();
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, entry.id]
                        : current.filter((value) => value !== entry.id),
                    );
                  }}
                />
                <span>
                  {names.get(entry.id)} · {formatKES(entry.outstandingMinor)}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-sm font-medium">
            {all
              ? t("startTotals", {
                  count: chosen.length,
                  amount: formatKES(data.totals.eligibleMinor),
                  charges: formatKES(data.totals.eligibleChargesMinor),
                })
              : t("startSubset", { count: chosen.length, amount: formatKES(chosenMinor) })}
          </p>
          <p className="text-sm">{t("startWarning")}</p>
        </CommandDialog>
      ) : null}
      {result ? (
        <div role="status" className="space-y-1 rounded-lg border p-3 text-sm">
          {result.outcome === "submitted" ? (
            <p className="font-medium">
              {t("startedSummary", {
                count: result.totals.payouts,
                amount: formatKES(result.totals.amountMinor),
                charges: formatKES(result.totals.chargesMinor),
              })}
            </p>
          ) : (
            <p className="font-medium">{t("flaggedSummary", { count: result.flagged.length })}</p>
          )}
          {result.ineligible.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {result.ineligible.map((entry) => (
                <li key={entry.obligationId}>
                  {names.get(entry.obligationId) ?? entry.obligationId}:{" "}
                  {entry.reasons.map((reason) => tv(`blockReasons.${reason}`)).join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FlagsSection({
  data,
  stepUp,
  onChanged,
}: {
  data: wire.BatchPayoutsResponse;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const flags = data.obligations
    .flatMap((entry) =>
      entry.flags.map((flag) => ({
        flag,
        worker: `${entry.labourer.fullName} · ${entry.labourer.workerNo}`,
      })),
    )
    .sort(
      (a, b) =>
        Number(b.flag.status === "open") - Number(a.flag.status === "open") ||
        b.flag.createdAt.localeCompare(a.flag.createdAt),
    );
  return (
    <section aria-labelledby="flags-heading" className="space-y-2">
      <h2 id="flags-heading" className="text-lg font-semibold">
        {t("flags")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("flagsHint")}</p>
      {flags.length ? (
        <ul className="grid gap-2 md:grid-cols-2">
          {flags.map(({ flag, worker }) => (
            <li key={flag.id}>
              <FlagRow
                flag={flag}
                worker={worker}
                canClear={data.permissions.canClearFlags}
                stepUp={stepUp}
                onChanged={onChanged}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">{t("noFlags")}</p>
      )}
    </section>
  );
}

function CarryForwards({ data }: { data: wire.BatchPayoutsResponse }) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  return (
    <section aria-labelledby="carry-heading" className="space-y-2">
      <h2 id="carry-heading" className="text-lg font-semibold">
        {t("carryForwards")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("carryHint")}</p>
      {data.carryForwards.length ? (
        <ul className="space-y-1 text-sm">
          {data.carryForwards.map((carry) => (
            <li key={carry.id} className="flex flex-wrap items-center gap-2">
              <span>
                {carry.labourer.fullName} · {carry.labourer.workerNo}: {formatKES(carry.amountMinor)}
              </span>
              <StatusBadge tone={carry.status === "open" ? "info" : "neutral"}>
                {tv(`carryForward.${carry.status}`)}
              </StatusBadge>
              {carry.consumedBy ? (
                <span className="text-xs text-muted-foreground">
                  {t("broughtInto", {
                    start: formatCalendarDate(carry.consumedBy.periodStart),
                    end: formatCalendarDate(carry.consumedBy.periodEnd),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">{t("noCarryForwards")}</p>
      )}
    </section>
  );
}
