"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { addCalendarDays, nairobiDate } from "@pm-buddy/domain";
import { MANUAL_PAYMENT_LIMITS, type PayoutBlockReason } from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { liveRequest, liveUpload } from "@/lib/live-api";
import { payrollCommand } from "@/lib/payroll";
import {
  displayTone,
  payslipTone,
  progressTone,
  wholeShillingsToMinor,
  workerHref,
} from "@/lib/payouts";
import { FlagText } from "./batch-approval";
import { CommandDialog, ReasonField, useCommandKey, validReason } from "./command-dialog";
import { usePayoutProblem } from "./payout-problem";

export type StepUpRun = <T>(operation: () => Promise<T>) => Promise<T>;

export type NextAction =
  | "none"
  | "confirm"
  | "wait"
  | "uncertain"
  | "retry"
  | "ready"
  | Exclude<PayoutBlockReason, "settled">;

/** What a worker's row needs next, from the API's block reasons and progress (never recomputed). */
export function nextAction(obligation: wire.Obligation): NextAction {
  if (obligation.progress === "settled") return "none";
  if (obligation.payouts.some((payout) => payout.status === "pending_confirmation"))
    return "confirm";
  if (obligation.progress === "in_flight") return "wait";
  if (obligation.progress === "uncertain") return "uncertain";
  const reason = obligation.blockReasons.find(
    (value): value is Exclude<PayoutBlockReason, "settled"> => value !== "settled",
  );
  if (reason) return reason;
  if (obligation.progress === "failed" || obligation.progress === "reversed") return "retry";
  return "ready";
}

/** The newest payout first (the API lists them oldest first). */
export const latestPayout = (obligation: wire.Obligation) =>
  [...obligation.payouts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

/** One worker's obligation: payouts, flags, blocks and every action the caller may take. */
export function ObligationSheet({
  obligation,
  data,
  userId,
  canDispute,
  stepUp,
  onClose,
  onChanged,
}: {
  obligation: wire.Obligation;
  data: wire.BatchPayoutsResponse;
  userId: string;
  canDispute: boolean;
  stepUp: StepUpRun;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  const { permissions } = data;
  const live = obligation.payouts.some(
    (payout) =>
      payout.status === "active" ||
      payout.status === "pending_confirmation" ||
      payout.requestStatus === "uncertain" ||
      payout.requestStatus === "reversal_pending",
  );
  const flags = data.obligations.flatMap((entry) =>
    entry.id === obligation.id ? entry.flags : [],
  );
  // An uncertain payout is also still "live": its uncertainty is the reason that matters.
  const reasons = obligation.blockReasons.filter(
    (reason) =>
      reason !== "settled" &&
      !(reason === "in-flight" && obligation.blockReasons.includes("uncertain")),
  );
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{obligation.labourer.fullName}</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{obligation.labourer.workerNo}</span> ·{" "}
            {obligation.channel === "mpesa"
              ? t("mpesaTo", { phone: obligation.destinationMasked ?? "—" })
              : `${tv("channels.manual")} · ${tv(`manualReasons.${obligation.manualReason ?? "no_number"}`)}`}
          </SheetDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <StatusBadge tone={progressTone[obligation.progress]}>
              {tv(`progress.${obligation.progress}`)}
            </StatusBadge>
          </div>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-8 text-sm">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("lineNet")}</dt>
            <dd>{formatKES(obligation.lineNetMinor)}</dd>
            {obligation.broughtForwardMinor ? (
              <>
                <dt className="text-muted-foreground">{t("broughtForward")}</dt>
                <dd>{formatKES(obligation.broughtForwardMinor)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t("amount")}</dt>
            <dd className="font-semibold">{formatKES(obligation.amountMinor)}</dd>
            <dt className="text-muted-foreground">{t("carryForward")}</dt>
            <dd>{obligation.carryForwardMinor ? formatKES(obligation.carryForwardMinor) : "—"}</dd>
            <dt className="text-muted-foreground">{t("paid")}</dt>
            <dd>{formatKES(obligation.paidMinor)}</dd>
            <dt className="text-muted-foreground">{t("outstanding")}</dt>
            <dd className="font-semibold">{formatKES(obligation.outstandingMinor)}</dd>
            {obligation.currentPhoneMasked !== obligation.destinationMasked ? (
              <>
                <dt className="text-muted-foreground">{t("currentNumber")}</dt>
                <dd>{obligation.currentPhoneMasked ?? "—"}</dd>
              </>
            ) : null}
            {obligation.destinationApprovedBy && obligation.destinationApprovedAt ? (
              <>
                <dt className="text-muted-foreground">{t("destinationApproved")}</dt>
                <dd>
                  {obligation.destinationApprovedBy.displayName} ·{" "}
                  {formatDateTime(obligation.destinationApprovedAt)}
                </dd>
              </>
            ) : null}
          </dl>

          {reasons.length ? (
            <section aria-labelledby="blocks-heading" className="space-y-2">
              <h3 id="blocks-heading" className="font-semibold">
                {t("blocks")}
              </h3>
              <ul className="space-y-2">
                {reasons.map((reason) => (
                  <li key={reason} className="space-y-1 rounded-lg border p-2">
                    <p className="font-medium">{tv(`blockReasons.${reason}`)}</p>
                    <BlockNext
                      reason={reason}
                      obligation={obligation}
                      data={data}
                      stepUp={stepUp}
                      onChanged={onChanged}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {flags.length ? (
            <section aria-labelledby="sheet-flags-heading" className="space-y-2">
              <h3 id="sheet-flags-heading" className="font-semibold">
                {t("flags")}
              </h3>
              <ul className="space-y-2">
                {flags.map((flag) => (
                  <li key={flag.id}>
                    <FlagRow
                      flag={flag}
                      canClear={permissions.canClearFlags}
                      stepUp={stepUp}
                      onChanged={onChanged}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="history-heading" className="space-y-2">
            <h3 id="history-heading" className="font-semibold">
              {t("history")}
            </h3>
            {obligation.payouts.length ? (
              <ul className="space-y-3">
                {[...obligation.payouts]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((payout) => (
                    <li key={payout.id}>
                      <PayoutCard
                        payout={payout}
                        data={data}
                        userId={userId}
                        canDispute={canDispute}
                        stepUp={stepUp}
                        onChanged={onChanged}
                      />
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t("noPayouts")}</p>
            )}
          </section>

          {permissions.canRecordManual && obligation.outstandingMinor > 0 && !live ? (
            <>
              <Separator />
              <ManualPaymentForm obligation={obligation} stepUp={stepUp} onChanged={onChanged} />
            </>
          ) : null}

          <Separator />
          <PayslipStatus
            obligation={obligation}
            canResend={permissions.canResend}
            onChanged={onChanged}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The next action for one block reason, with the button or link that does it. */
function BlockNext({
  reason,
  obligation,
  data,
  stepUp,
  onChanged,
}: {
  reason: PayoutBlockReason;
  obligation: wire.Obligation;
  data: wire.BatchPayoutsResponse;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.next");
  const uncertain = obligation.payouts.find(
    (payout) => payout.requestStatus === "uncertain" || payout.displayStatus === "uncertain",
  );
  if (reason === "destination-changed")
    return (
      <div className="space-y-1">
        <p>{t("destination-changed")}</p>
        {data.permissions.canApproveDestination ? (
          <DestinationApproval obligation={obligation} stepUp={stepUp} onChanged={onChanged} />
        ) : null}
      </div>
    );
  if (reason === "unverified" || reason === "on-hold" || reason === "change-hold")
    return (
      <p>
        {reason === "change-hold" && obligation.changeHoldUntil
          ? t("change-hold-until", { date: formatDateTime(obligation.changeHoldUntil) })
          : t(reason)}{" "}
        <Link className="underline" href={workerHref(obligation.labourer.id)}>
          {t("openWorker")}
        </Link>
      </p>
    );
  if (reason === "uncertain" && uncertain?.paymentRequestId)
    return (
      <p>
        {t("uncertain")}{" "}
        <Link className="underline" href={`/payments/requests/${uncertain.paymentRequestId}`}>
          {t("openCase")}
        </Link>
      </p>
    );
  return <p>{t(reason)}</p>;
}

function PayoutCard({
  payout,
  data,
  userId,
  canDispute,
  stepUp,
  onChanged,
}: {
  payout: wire.PayrollPayout;
  data: wire.BatchPayoutsResponse;
  userId: string;
  canDispute: boolean;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  const recorder = payout.createdBy?.id === userId;
  const pending = payout.status === "pending_confirmation";
  return (
    <article className="min-w-0 space-y-2 break-words rounded-lg border p-3">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {tv(`methods.${payout.method}`)} · {formatKES(payout.amountMinor)}
        </span>
        <StatusBadge tone={displayTone[payout.displayStatus]}>
          {tv(`display.${payout.displayStatus}`)}
        </StatusBadge>
      </p>
      {payout.displayStatus === "uncertain" ? (
        <p role="note" className="text-xs">
          {t("uncertainNote")}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {payout.receipt ? (
          <>
            <dt className="text-muted-foreground">{t("receipt")}</dt>
            <dd className="font-mono">{payout.receipt}</dd>
          </>
        ) : null}
        {payout.reference ? (
          <>
            <dt className="text-muted-foreground">{t("reference")}</dt>
            <dd className="font-mono">{payout.reference}</dd>
          </>
        ) : null}
        {payout.paidOn ? (
          <>
            <dt className="text-muted-foreground">{t("paidOn")}</dt>
            <dd>{formatCalendarDate(payout.paidOn)}</dd>
          </>
        ) : null}
        {payout.chargeMinor !== null ? (
          <>
            <dt className="text-muted-foreground">{t("charge")}</dt>
            <dd>{formatKES(payout.chargeMinor)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">
          {t(payout.method === "mpesa" ? "startedBy" : "recordedBy")}
        </dt>
        <dd>
          {payout.createdBy?.displayName ?? t("system")} · {formatDateTime(payout.createdAt)}
        </dd>
        {payout.confirmedBy && payout.confirmedAt ? (
          <>
            <dt className="text-muted-foreground">{t("confirmedBy")}</dt>
            <dd>
              {payout.confirmedBy.displayName} · {formatDateTime(payout.confirmedAt)}
            </dd>
          </>
        ) : null}
      </dl>
      {payout.reason ? <p className="text-xs">{payout.reason}</p> : null}
      {payout.failure ? (
        <p className="text-xs text-destructive">
          {t("failure", {
            code: payout.failure.code ?? "—",
            description: payout.failure.description ?? "—",
          })}
        </p>
      ) : null}
      {payout.rejectionReason ? (
        <p className="text-xs text-destructive">
          {t("rejectedBecause", { reason: payout.rejectionReason })}
        </p>
      ) : null}
      {payout.nameCheck ? <NameCheck check={payout.nameCheck} /> : null}
      {payout.method === "cash" ? (
        <Evidence
          payout={payout}
          canUpload={data.permissions.canRecordManual && pending}
          onChanged={onChanged}
        />
      ) : null}
      {pending && data.permissions.canConfirmManual ? (
        recorder ? (
          <p role="note" className="text-xs">
            {t("recorderNote")}
          </p>
        ) : (
          <ManualDecision payout={payout} stepUp={stepUp} onChanged={onChanged} />
        )
      ) : null}
      <div className="flex flex-wrap gap-2">
        {payout.paymentRequestId ? (
          <Link
            className="text-xs underline"
            href={`/payments/requests/${payout.paymentRequestId}`}
          >
            {t("paymentRequest")}
          </Link>
        ) : null}
        {canDispute && payout.status === "confirmed" ? <DisputeButton payout={payout} /> : null}
      </div>
    </article>
  );
}

function NameCheck({ check }: { check: NonNullable<wire.PayrollPayout["nameCheck"]> }) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  return (
    <p className="text-xs">
      {t("nameCheck")}:{" "}
      <StatusBadge
        tone={
          check.result === "match" ? "success" : check.result === "mismatch" ? "danger" : "neutral"
        }
      >
        {tv(`nameCheck.${check.result}`)}
      </StatusBadge>
      {check.score !== null ? ` ${t("score", { score: Math.round(check.score * 100) })}` : ""}
      {check.receiverName ? ` · ${t("receiverName", { name: check.receiverName })}` : ""}
    </p>
  );
}

function Evidence({
  payout,
  canUpload,
  onChanged,
}: {
  payout: wire.PayrollPayout;
  canUpload: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  return (
    <div className="space-y-1 text-xs">
      <p className="font-medium">{t("evidence")}</p>
      {payout.evidence.length ? (
        <ul className="space-y-1">
          {payout.evidence.map((item) => (
            <li key={item.id}>
              {t("evidenceItem", {
                type: item.contentType.replace("image/", "").toUpperCase(),
                size: Math.max(1, Math.round(item.sizeBytes / 1024)),
                name: item.uploadedBy.displayName,
                date: formatDateTime(item.uploadedAt),
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("noEvidence")}</p>
      )}
      {canUpload && payout.evidence.length < MANUAL_PAYMENT_LIMITS.evidencePerPayment ? (
        <EvidenceUpload payoutId={payout.id} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

/** Photo or signature evidence for a cash payment: uploaded after recording, before confirming. */
function EvidenceUpload({
  payoutId,
  onChanged,
}: {
  payoutId: string;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const types: readonly string[] = MANUAL_PAYMENT_LIMITS.evidenceContentTypes;
  const invalid =
    file !== null &&
    (!types.includes(file.type) || file.size > MANUAL_PAYMENT_LIMITS.evidenceMaxBytes);
  async function upload() {
    if (!file || invalid) return;
    setBusy(true);
    setMessage(null);
    try {
      await liveUpload(
        `/payroll/manual-payments/${payoutId}/evidence`,
        file,
        wire.paymentEvidenceResponseSchema,
        {},
        { "Idempotency-Key": key.value() },
      );
      setFile(null);
      if (input.current) input.current.value = "";
      setMessage({ error: false, text: t("evidenceUploaded") });
      await onChanged();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-dashed p-2">
      <Field>
        <FieldLabel htmlFor={`evidence-${payoutId}`}>{t("evidenceFile")}</FieldLabel>
        <Input
          ref={input}
          id={`evidence-${payoutId}`}
          type="file"
          accept={types.join(",")}
          onChange={(event) => {
            key.renew();
            setFile(event.target.files?.[0] ?? null);
          }}
          aria-describedby={`evidence-${payoutId}-hint`}
        />
        <FieldDescription id={`evidence-${payoutId}-hint`}>{t("evidenceHint")}</FieldDescription>
      </Field>
      {invalid ? (
        <p role="alert" className="text-destructive">
          {t("evidenceInvalid")}
        </p>
      ) : null}
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "text-destructive" : ""}
        >
          {message.text}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={!file || invalid || busy}
        onClick={() => void upload()}
      >
        {t("uploadEvidence")}
      </Button>
    </div>
  );
}

function ManualDecision({
  payout,
  stepUp,
  onChanged,
}: {
  payout: wire.PayrollPayout;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const problem = usePayoutProblem("confirm");
  const confirmKey = useCommandKey();
  const rejectKey = useCommandKey();
  const [reason, setReason] = useState("");
  const needsEvidence = payout.method === "cash" && payout.evidence.length === 0;
  return (
    <div className="space-y-1">
      {needsEvidence ? <p className="text-xs">{t("evidenceFirst")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <CommandDialog
          label={t("confirmPayment")}
          size="sm"
          variant="default"
          disabled={needsEvidence}
          title={t("confirmTitle", { amount: formatKES(payout.amountMinor) })}
          description={t("confirmHint")}
          submitLabel={t("confirmPayment")}
          problem={problem}
          onOpen={() => confirmKey.renew()}
          onSubmit={async () => {
            await stepUp(() =>
              payrollCommand(
                `/payroll/manual-payments/${payout.id}/confirm`,
                wire.manualPaymentResponseSchema,
                { version: payout.version },
                "POST",
                confirmKey.value(),
              ),
            );
            await onChanged();
          }}
        />
        <CommandDialog
          label={t("rejectPayment")}
          size="sm"
          variant="destructive"
          destructive
          title={t("rejectTitle")}
          description={t("rejectHint")}
          submitLabel={t("rejectPayment")}
          submitDisabled={!validReason(reason)}
          problem={problem}
          onOpen={() => {
            rejectKey.renew();
            setReason("");
          }}
          onSubmit={async () => {
            await stepUp(() =>
              payrollCommand(
                `/payroll/manual-payments/${payout.id}/reject`,
                wire.manualPaymentResponseSchema,
                { version: payout.version, reason: reason.trim() },
                "POST",
                rejectKey.value(),
              ),
            );
            await onChanged();
          }}
        >
          <ReasonField
            value={reason}
            onChange={(value) => {
              rejectKey.renew();
              setReason(value);
            }}
          />
        </CommandDialog>
      </div>
    </div>
  );
}

/** Record-only cash or bank payment (owner decisions 2 and 7): no money is sent by PM-Buddy. */
function ManualPaymentForm({
  obligation,
  stepUp,
  onChanged,
}: {
  obligation: wire.Obligation;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const today = nairobiDate();
  const [method, setMethod] = useState<"cash" | "bank">(
    obligation.channel === "manual" ? "cash" : "bank",
  );
  const [amount, setAmount] = useState(String(obligation.outstandingMinor / 100));
  const [paidOn, setPaidOn] = useState(today);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const amountMinor = wholeShillingsToMinor(amount);
  const body = {
    method,
    amountMinor,
    paidOn,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
    ...(reference.trim() ? { reference: reference.trim() } : {}),
  };
  const parsed = wire.recordManualPaymentRequestSchema.safeParse(body);
  const aboveOutstanding = amountMinor !== null && amountMinor > obligation.outstandingMinor;
  const renew =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      key.renew();
      set(value);
    };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsed.success || aboveOutstanding) return;
    setBusy(true);
    setMessage(null);
    try {
      await stepUp(() =>
        payrollCommand(
          `/payroll/obligations/${obligation.id}/manual-payments`,
          wire.manualPaymentResponseSchema,
          parsed.data as Record<string, unknown>,
          "POST",
          key.value(),
        ),
      );
      setMessage({ error: false, text: t(method === "cash" ? "cashRecorded" : "bankRecorded") });
      key.renew();
      await onChanged();
    } catch (error) {
      setMessage({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }
  const id = `manual-${obligation.id}`;
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <h3 id={`${id}-heading`} className="font-semibold">
        {t("recordManual")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("manualHint")}</p>
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("method")}</legend>
          {(["cash", "bank"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-method`}
                value={value}
                checked={method === value}
                onChange={() => renew(setMethod)(value)}
                className="size-4 accent-primary"
              />
              {tv(`methods.${value}`)}
            </label>
          ))}
        </fieldset>
        <Field>
          <FieldLabel htmlFor={`${id}-amount`}>{t("amountShillings")}</FieldLabel>
          <Input
            id={`${id}-amount`}
            inputMode="numeric"
            value={amount}
            onChange={(event) => renew(setAmount)(event.target.value)}
            aria-describedby={`${id}-amount-hint`}
            aria-invalid={amountMinor === null || aboveOutstanding}
          />
          <FieldDescription id={`${id}-amount-hint`}>
            {t("amountHint", { outstanding: formatKES(obligation.outstandingMinor) })}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-paid-on`}>{t("paidOn")}</FieldLabel>
          <Input
            id={`${id}-paid-on`}
            type="date"
            value={paidOn}
            max={today}
            min={addCalendarDays(today, -MANUAL_PAYMENT_LIMITS.paidOnMaxAgeDays)}
            onChange={(event) => renew(setPaidOn)(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-reason`}>
            {t(method === "cash" ? "cashReason" : "bankReason")}
          </FieldLabel>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            rows={2}
            maxLength={500}
            onChange={(event) => renew(setReason)(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-reference`}>
            {t(method === "bank" ? "bankReference" : "cashReference")}
          </FieldLabel>
          <Input
            id={`${id}-reference`}
            value={reference}
            maxLength={MANUAL_PAYMENT_LIMITS.referenceMax}
            onChange={(event) => renew(setReference)(event.target.value)}
          />
        </Field>
        {!parsed.success || aboveOutstanding ? (
          <p className="text-xs text-muted-foreground">{t("manualInvalid")}</p>
        ) : null}
        {message ? (
          <p
            role={message.error ? "alert" : "status"}
            className={message.error ? "text-destructive" : undefined}
          >
            {message.text}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !parsed.success || aboveOutstanding}>
          {t("recordPayment")}
        </Button>
      </form>
    </section>
  );
}

/** Re-approve a changed number (payroll.approve + step-up), naming the new number's verification. */
function DestinationApproval({
  obligation,
  stepUp,
  onChanged,
}: {
  obligation: wire.Obligation;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const problem = usePayoutProblem("destination");
  const key = useCommandKey();
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<wire.LabourerPayoutStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const current = status?.verifications.find((verification) => verification.current) ?? null;
  return (
    <CommandDialog
      label={t("reapprove")}
      size="sm"
      title={t("reapproveTitle")}
      description={t("reapproveHint")}
      submitLabel={t("reapprove")}
      submitDisabled={!current}
      problem={problem}
      onOpen={() => {
        key.renew();
        setNote("");
        setStatus(null);
        setLoadError(null);
        liveRequest(
          `/labour/labourers/${obligation.labourer.id}/payout-status`,
          wire.labourerPayoutStatusResponseSchema,
        )
          .then(setStatus)
          .catch((error: unknown) => setLoadError(problem(error)));
      }}
      onSubmit={async () => {
        if (!current) return;
        await stepUp(() =>
          payrollCommand(
            `/payroll/obligations/${obligation.id}/destination-approval`,
            wire.obligationResponseSchema,
            {
              version: obligation.version,
              verificationId: current.id,
              ...(note.trim() ? { note: note.trim() } : {}),
            },
            "POST",
            key.value(),
          ),
        );
        await onChanged();
      }}
    >
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("approvedNumber")}</dt>
        <dd>{obligation.destinationMasked ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("currentNumber")}</dt>
        <dd>{obligation.currentPhoneMasked ?? "—"}</dd>
      </dl>
      {loadError ? (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      ) : !status ? (
        <p role="status" className="text-sm">
          {t("loading")}
        </p>
      ) : current ? (
        <p className="text-sm">
          {t("verifiedBy", {
            name: current.verifiedBy.displayName,
            date: formatDateTime(current.verifiedAt),
          })}
        </p>
      ) : (
        <p role="alert" className="text-sm">
          {t("verifyNewFirst")}{" "}
          <Link className="underline" href={workerHref(obligation.labourer.id)}>
            {t("openWorker")}
          </Link>
        </p>
      )}
      <ReasonField
        optional
        value={note}
        onChange={(value) => {
          key.renew();
          setNote(value);
        }}
      />
    </CommandDialog>
  );
}

/** An unusual-payout flag (§7) and, for payments.approve holders, clearing it with a reason. */
export function FlagRow({
  flag,
  worker,
  canClear,
  stepUp,
  onChanged,
}: {
  flag: wire.PayoutFlag;
  worker?: string;
  canClear: boolean;
  stepUp: StepUpRun;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  const problem = usePayoutProblem("flag");
  const key = useCommandKey();
  const [reason, setReason] = useState("");
  return (
    <article className="min-w-0 space-y-1 break-words rounded-lg border p-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        {worker ? <span className="font-medium">{worker}</span> : null}
        <span>
          <FlagText code={flag.code} details={flag.details} />
        </span>
        <StatusBadge tone={flag.status === "open" ? "warning" : "neutral"}>
          {tv(`flagStatus.${flag.status}`)}
        </StatusBadge>
      </p>
      <p className="text-xs text-muted-foreground">
        {t("flagRaised", {
          date: formatDateTime(flag.createdAt),
          name: flag.createdBy?.displayName ?? t("system"),
        })}
      </p>
      {flag.clearedBy && flag.clearedAt ? (
        <p className="text-xs">
          {t("flagCleared", {
            name: flag.clearedBy.displayName,
            date: formatDateTime(flag.clearedAt),
          })}
          {flag.clearReason ? ` · ${flag.clearReason}` : ""}
        </p>
      ) : null}
      {canClear && flag.status === "open" ? (
        <CommandDialog
          label={t("clearFlag")}
          size="sm"
          title={t("clearFlagTitle")}
          description={t("clearFlagHint")}
          submitLabel={t("clearFlag")}
          submitDisabled={!validReason(reason)}
          problem={problem}
          onOpen={() => {
            key.renew();
            setReason("");
          }}
          onSubmit={async () => {
            await stepUp(() =>
              payrollCommand(
                `/payroll/flags/${flag.id}/clear`,
                wire.payoutFlagResponseSchema,
                { reason: reason.trim() },
                "POST",
                key.value(),
              ),
            );
            await onChanged();
          }}
        >
          <ReasonField
            value={reason}
            onChange={(value) => {
              key.renew();
              setReason(value);
            }}
          />
        </CommandDialog>
      ) : null}
    </article>
  );
}

function PayslipStatus({
  obligation,
  canResend,
  onChanged,
}: {
  obligation: wire.Obligation;
  canResend: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const tv = useTranslations("payouts.values");
  const { state, notification } = obligation.payslip;
  return (
    <section aria-labelledby={`payslip-${obligation.id}`} className="space-y-1">
      <h3 id={`payslip-${obligation.id}`} className="font-semibold">
        {t("payslipSms")}
      </h3>
      <p className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={payslipTone[state]}>{tv(`payslip.${state}`)}</StatusBadge>
        {notification ? (
          <span className="text-xs text-muted-foreground">
            {notification.recipientMasked} · {notification.language.toUpperCase()} ·{" "}
            {t("attempts", { count: notification.attempts })}
            {notification.sentAt ? ` · ${formatDateTime(notification.sentAt)}` : ""}
          </span>
        ) : null}
      </p>
      {notification?.lastErrorCode ? (
        <p className="text-xs">{tv(`notificationErrors.${notification.lastErrorCode}`)}</p>
      ) : null}
      {state === "failed" && notification && canResend ? (
        <ResendButton notificationId={notification.id} onChanged={onChanged} />
      ) : null}
    </section>
  );
}

/** Re-queues one failed payslip SMS; payment state is never touched. */
export function ResendButton({
  notificationId,
  onChanged,
}: {
  notificationId: string;
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations("payouts.board");
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          payrollCommand(
            `/payroll/notifications/${notificationId}/resend`,
            wire.payrollNotificationResponseSchema,
            {},
            "POST",
            key.value(),
          )
            .then(() => {
              key.renew();
              return onChanged();
            })
            .catch((failure: unknown) => setError(problem(failure)))
            .finally(() => setBusy(false));
        }}
      >
        {t("resend")}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A worker disputes a payout (A-12): opens a reconciliation item for payments reviewers. */
export function DisputeButton({ payout }: { payout: Pick<wire.PayrollPayout, "id"> }) {
  const t = useTranslations("payouts.board");
  const router = useRouter();
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const [reason, setReason] = useState("");
  return (
    <CommandDialog
      label={t("dispute")}
      size="xs"
      title={t("disputeTitle")}
      description={t("disputeHint")}
      submitLabel={t("dispute")}
      submitDisabled={!validReason(reason)}
      problem={problem}
      onOpen={() => {
        key.renew();
        setReason("");
      }}
      onSubmit={async () => {
        const result = await payrollCommand(
          "/payments/reconciliation/disputes",
          wire.reconciliationItemResponseSchema,
          { payoutId: payout.id, reason: reason.trim() },
          "POST",
          key.value(),
        );
        router.push(`/payments/reconciliation/items/${result.item.id}`);
      }}
    >
      <ReasonField
        value={reason}
        onChange={(value) => {
          key.renew();
          setReason(value);
        }}
      />
    </CommandDialog>
  );
}
