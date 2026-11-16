"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react";
import type { ApprovalBlocker } from "@pm-buddy/types";
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
import { formatDateTime, formatKES } from "@/lib/format";
import { LiveApiError } from "@/lib/live-api";
import { batchTone, payrollCommand } from "@/lib/payroll";
import { batchTimeline, verificationTone, workerHref, type TimelineStep } from "@/lib/payouts";
import { CommandDialog, ReasonField, useCommandKey, validReason } from "./command-dialog";
import { usePayoutProblem } from "./payout-problem";

/** submitted → reviewed → approved → the derived settlement status, with who and when. */
export function BatchTimeline({
  batch,
  decisions,
}: {
  batch: wire.PayrollBatch;
  decisions: wire.BatchDecision[];
}) {
  const t = useTranslations("payouts.timeline");
  const steps = batchTimeline(batch, decisions);
  const label = (step: TimelineStep) =>
    step.key === "payout"
      ? step.status && step.status !== "approved"
        ? t(`settlement.${step.status as "disbursing" | "partially_settled" | "settled"}`)
        : t("payout")
      : t(step.key);
  return (
    <section aria-labelledby="timeline-heading" className="space-y-2">
      <h2 id="timeline-heading" className="font-semibold">
        {t("title")}
      </h2>
      <ol aria-labelledby="timeline-heading" className="grid gap-2 sm:grid-cols-5">
        {steps.map((step) => {
          const stopped = step.key === "rejected" || step.key === "cancelled";
          const Icon = stopped
            ? XCircle
            : step.state === "done"
              ? CheckCircle2
              : step.state === "current"
                ? CircleDot
                : Circle;
          return (
            <li
              key={step.key}
              aria-current={step.state === "current" ? "step" : undefined}
              className="min-w-0 space-y-1 rounded-lg border p-3 text-sm data-[state=upcoming]:text-muted-foreground"
              data-state={step.state}
            >
              <p className="flex items-center gap-2 font-medium">
                <Icon
                  aria-hidden
                  className={
                    stopped
                      ? "size-4 text-destructive"
                      : step.state === "done"
                        ? "size-4 text-success"
                        : step.state === "current"
                          ? "size-4 text-primary"
                          : "size-4"
                  }
                />
                {label(step)}
                <span className="sr-only">({t(`state.${step.state}`)})</span>
              </p>
              {step.actor ? (
                <p className="break-words text-xs">
                  {step.actor}
                  {step.at ? ` · ${formatDateTime(step.at)}` : ""}
                </p>
              ) : null}
              {step.underWaiver ? (
                <StatusBadge tone="warning">{t("underWaiver")}</StatusBadge>
              ) : null}
              {step.note ? <p className="break-words text-xs">{step.note}</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The append-only decision log (non-repudiation evidence), newest first. */
export function DecisionHistory({ decisions }: { decisions: wire.BatchDecision[] }) {
  const t = useTranslations("payouts.approval");
  const tv = useTranslations("payouts.values");
  if (!decisions.length) return null;
  return (
    <section aria-labelledby="decisions-heading" className="space-y-2">
      <h2 id="decisions-heading" className="font-semibold">
        {t("decisions")}
      </h2>
      <ul className="space-y-2 text-sm">
        {[...decisions]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((decision) => (
            <li key={decision.id} className="min-w-0 space-y-1 rounded-lg border p-3">
              <p className="font-medium">
                {tv(`decisions.${decision.action}`)} · {decision.actor.displayName} ·{" "}
                {formatDateTime(decision.createdAt)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("decisionFacts", {
                  version: decision.batchVersion,
                  net: formatKES(decision.netMinor),
                })}
                {decision.appliedLimitMinor !== null
                  ? ` · ${t("appliedLimit", { limit: formatKES(decision.appliedLimitMinor) })}`
                  : ""}
                {decision.underWaiver ? ` · ${t("underWaiver")}` : ""}
              </p>
              {decision.note ? <p className="break-words">{decision.note}</p> : null}
              <p className="break-all font-mono text-xs text-muted-foreground">
                {t("actionHash")}: {decision.actionHash}
              </p>
            </li>
          ))}
      </ul>
    </section>
  );
}

/**
 * Review, rejection, reopening and approval of a batch (D4.3 §1–3): the reviewer confirms the
 * snapshot digest they checked; the approver sees what approval binds — limit, recipients and
 * their verification, flags, carry-forwards, totals — and approves exactly that approval digest
 * with a fresh step-up. The API repeats every check (maker-checker, limit, snapshot).
 */
export function BatchApproval({
  approval,
  userId,
}: {
  approval: wire.BatchApprovalResponse;
  userId: string;
}) {
  const t = useTranslations("payouts.approval");
  const tStatus = useTranslations("payrollLive.values");
  const router = useRouter();
  const stepUp = useStepUp();
  const { batch, permissions } = approval;
  const path = `/payroll/batches/${batch.id}`;
  const contributor = approval.separation.contributors.some((person) => person.id === userId);
  const reviewProblem = usePayoutProblem("review");
  const decisionProblem = usePayoutProblem();
  const reviewKey = useCommandKey();
  const rejectKey = useCommandKey();
  const reopenKey = useCommandKey();
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState("");
  const pending = batch.status === "submitted" || batch.status === "reviewed";
  const done = () => router.refresh();

  return (
    <section aria-labelledby="approval-heading" className="min-w-0 space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="approval-heading" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <StatusBadge tone={batchTone[batch.status]}>{tStatus(batch.status)}</StatusBadge>
      </div>
      {batch.status === "draft" ? <p className="text-sm">{t("draftHint")}</p> : null}
      {batch.status === "rejected" ? <p className="text-sm">{t("rejectedHint")}</p> : null}
      {batch.status === "submitted" && contributor ? (
        <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("contributorNote")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {permissions.canReview && batch.status === "submitted" ? (
          <CommandDialog
            label={t("review")}
            variant="default"
            disabled={contributor}
            title={t("reviewTitle")}
            description={t("reviewHint")}
            submitLabel={t("reviewSubmit")}
            submitDisabled={!checked}
            problem={reviewProblem}
            onOpen={() => {
              reviewKey.renew();
              setNote("");
              setChecked(false);
            }}
            onSubmit={async () => {
              await stepUp.run(() =>
                payrollCommand(
                  `${path}/review`,
                  wire.batchDecisionResponseSchema,
                  {
                    version: batch.version,
                    digest: batch.digest,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  },
                  "POST",
                  reviewKey.value(),
                ),
              );
              done();
            }}
          >
            <DigestBox label={t("snapshotDigest")} digest={batch.digest} />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={checked}
                onChange={(event) => {
                  reviewKey.renew();
                  setChecked(event.target.checked);
                }}
              />
              {t("reviewConfirm")}
            </label>
            <ReasonField
              optional
              value={note}
              onChange={(value) => {
                reviewKey.renew();
                setNote(value);
              }}
            />
          </CommandDialog>
        ) : null}
        {permissions.canReject && pending ? (
          <CommandDialog
            label={t("reject")}
            variant="destructive"
            destructive
            title={t("rejectTitle")}
            description={t("rejectHint")}
            submitLabel={t("reject")}
            submitDisabled={!validReason(reason)}
            problem={decisionProblem}
            onOpen={() => {
              rejectKey.renew();
              setReason("");
            }}
            onSubmit={async () => {
              await stepUp.run(() =>
                payrollCommand(
                  `${path}/reject`,
                  wire.batchDecisionResponseSchema,
                  { version: batch.version, reason: reason.trim() },
                  "POST",
                  rejectKey.value(),
                ),
              );
              done();
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
        ) : null}
        {permissions.canReopen && batch.status === "rejected" ? (
          <CommandDialog
            label={t("reopen")}
            title={t("reopenTitle")}
            description={t("reopenHint", { version: batch.version + 1 })}
            submitLabel={t("reopen")}
            problem={decisionProblem}
            onOpen={() => reopenKey.renew()}
            onSubmit={async () => {
              await stepUp.run(() =>
                payrollCommand(
                  `${path}/reopen`,
                  wire.batchDecisionResponseSchema,
                  { version: batch.version },
                  "POST",
                  reopenKey.value(),
                ),
              );
              done();
            }}
          />
        ) : null}
      </div>
      {pending ? <ApprovalReadiness approval={approval} /> : null}
      {permissions.canApprove && batch.status === "reviewed" ? (
        <ApproveSection approval={approval} stepUp={stepUp.run} />
      ) : null}
      {stepUp.dialog}
    </section>
  );
}

function DigestBox({ label, digest }: { label: string; digest: string }) {
  return (
    <div className="space-y-1 rounded-lg border bg-muted/40 p-3">
      <p className="text-sm font-medium">{label}</p>
      <p className="break-all font-mono text-xs">{digest}</p>
    </div>
  );
}

const workerLabel = (labourer: { fullName: string; workerNo: string }) =>
  `${labourer.fullName} · ${labourer.workerNo}`;

/** Everything approval would bind, for reviewers and approvers alike. */
function ApprovalReadiness({ approval }: { approval: wire.BatchApprovalResponse }) {
  const t = useTranslations("payouts.approval");
  const tv = useTranslations("payouts.values");
  const { totals, limit } = approval;
  const unverified = approval.recipients.filter(
    (recipient) => recipient.verificationState !== "verified" && recipient.channel === "mpesa",
  );
  const flagged = approval.recipients.filter((recipient) => recipient.flags.length > 0);
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{t("readiness")}</h3>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ["obligations", String(totals.obligations)],
            ["netTotal", formatKES(totals.netMinor)],
            ["mpesaTotal", formatKES(totals.mpesaMinor)],
            ["manualTotal", formatKES(totals.manualMinor)],
            ["carryForwardTotal", formatKES(totals.carryForwardMinor)],
            ["broughtForwardTotal", formatKES(totals.broughtForwardMinor)],
            ["unverifiedCount", String(totals.unverified)],
            ["flaggedCount", String(totals.flagged)],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-lg border p-3">
            <dt className="text-muted-foreground">{t(key)}</dt>
            <dd className="font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {approval.zeroNetLines > 0 ? (
        <p className="text-sm">{t("zeroNet", { count: approval.zeroNetLines })}</p>
      ) : null}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t("limit")}</dt>
        <dd>
          {limit.maxBatchNetMinor === null
            ? t("noLimit")
            : t("limitValue", {
                limit: formatKES(limit.maxBatchNetMinor),
                source: tv(`limitSources.${limit.source}`),
              })}
          {limit.appliedLimitMinor !== null &&
          limit.appliedLimitMinor !== limit.maxBatchNetMinor ? (
            <> · {t("appliedLimit", { limit: formatKES(limit.appliedLimitMinor) })}</>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">{t("contributors")}</dt>
        <dd>
          {approval.separation.contributors.map((person) => person.displayName).join(", ") || "—"}
        </dd>
        <dt className="text-muted-foreground">{t("reviewer")}</dt>
        <dd>{approval.separation.reviewer?.displayName ?? "—"}</dd>
      </dl>
      {unverified.length ? (
        <div
          role="note"
          aria-labelledby="unverified-heading"
          className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <p id="unverified-heading" className="font-semibold">
            {t("unverifiedTitle", { count: unverified.length })}
          </p>
          <p>{t("unverifiedHint")}</p>
          <ul className="list-disc space-y-1 pl-5">
            {unverified.map((recipient) => (
              <li key={recipient.lineId}>
                <Link className="underline" href={workerHref(recipient.labourer.id)}>
                  {t("verifyLink", { worker: workerLabel(recipient.labourer) })}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {flagged.length ? (
        <div className="space-y-2 text-sm">
          <h4 className="font-semibold">{t("flagsPreview")}</h4>
          <p>{t("flagsHint")}</p>
          <ul className="list-disc space-y-1 pl-5">
            {flagged.flatMap((recipient) =>
              recipient.flags.map((flag) => (
                <li key={`${recipient.lineId}-${flag.code}`}>
                  {workerLabel(recipient.labourer)}: <FlagText code={flag.code} details={flag.details} />
                </li>
              )),
            )}
          </ul>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table aria-label={t("recipients")}>
          <TableHeader>
            <TableRow>
              {(
                [
                  "worker",
                  "lineNet",
                  "broughtForward",
                  "payNow",
                  "carryForward",
                  "channel",
                  "verification",
                ] as const
              ).map((key) => (
                <TableHead key={key}>{t(`columns.${key}`)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {approval.recipients.map((recipient) => (
              <TableRow key={recipient.lineId}>
                <TableCell>
                  <Link className="underline" href={workerHref(recipient.labourer.id)}>
                    {workerLabel(recipient.labourer)}
                  </Link>
                </TableCell>
                <TableCell>{formatKES(recipient.lineNetMinor)}</TableCell>
                <TableCell>
                  {recipient.broughtForwardMinor ? formatKES(recipient.broughtForwardMinor) : "—"}
                </TableCell>
                <TableCell className="font-medium">{formatKES(recipient.amountMinor)}</TableCell>
                <TableCell>
                  {recipient.carryForwardMinor ? formatKES(recipient.carryForwardMinor) : "—"}
                </TableCell>
                <TableCell>
                  {recipient.channel === "mpesa"
                    ? t("mpesaTo", { phone: recipient.phoneMasked ?? "—" })
                    : `${tv("channels.manual")} · ${tv(`manualReasons.${recipient.manualReason ?? "no_number"}`)}`}
                  {recipient.numberChanged ? (
                    <span className="block text-xs text-destructive">{t("numberChanged")}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {recipient.channel === "mpesa" ? (
                    <StatusBadge tone={verificationTone[recipient.verificationState]}>
                      {tv(`verification.${recipient.verificationState}`)}
                    </StatusBadge>
                  ) : (
                    "—"
                  )}
                  {recipient.verification ? (
                    <span className="block text-xs text-muted-foreground">
                      {recipient.verification.verifiedBy.displayName} ·{" "}
                      {formatDateTime(recipient.verification.verifiedAt)}
                    </span>
                  ) : null}
                  {recipient.activeHolds.length ? (
                    <span className="block text-xs">
                      {t("holds", { count: recipient.activeHolds.length })}
                    </span>
                  ) : null}
                  {recipient.changeHoldUntil ? (
                    <span className="block text-xs">
                      {t("changeHoldUntil", { date: formatDateTime(recipient.changeHoldUntil) })}
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {approval.carryForwardOnly.length ? (
        <div className="space-y-2 text-sm">
          <h4 className="font-semibold">{t("carryOnly")}</h4>
          <p>{t("carryOnlyHint")}</p>
          <ul className="list-disc space-y-1 pl-5">
            {approval.carryForwardOnly.map((line) => (
              <li key={line.lineId}>
                {workerLabel(line.labourer)}: {formatKES(line.carryForwardMinor)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A flag code with its safe details (amounts formatted, counts as numbers). */
export function FlagText({
  code,
  details,
}: {
  code: wire.PayoutFlag["code"];
  details: Record<string, number | string | boolean>;
}) {
  const tv = useTranslations("payouts.values");
  const t = useTranslations("payouts.flagDetails");
  const number = (key: string) => (typeof details[key] === "number" ? details[key] : null);
  const amount = number("amountMinor");
  const threshold = number("thresholdMinor");
  const others = number("otherLabourers");
  const inBatch = number("obligationsInBatch");
  return (
    <>
      {tv(`flags.${code}`)}
      {code === "new_recipient_large" && amount !== null && threshold !== null
        ? ` (${t("newRecipient", { amount: formatKES(amount), threshold: formatKES(threshold) })})`
        : ""}
      {code === "shared_number" && others !== null && inBatch !== null
        ? ` (${t("sharedNumber", { others, inBatch })})`
        : ""}
    </>
  );
}

function ApproveSection({
  approval,
  stepUp,
}: {
  approval: wire.BatchApprovalResponse;
  stepUp: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  const t = useTranslations("payouts.approval");
  const router = useRouter();
  const problem = usePayoutProblem("approve");
  const key = useCommandKey();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);
  const { batch, blockers, approvalDigest } = approval;
  const blocked = blockers.length > 0 || approvalDigest === null;
  async function approve() {
    if (blocked || !approvalDigest) return;
    setBusy(true);
    setError(null);
    try {
      await stepUp(() =>
        payrollCommand(
          `/payroll/batches/${batch.id}/approve`,
          wire.approveBatchResponseSchema,
          {
            version: batch.version,
            digest: batch.digest,
            approvalDigest,
            ...(note.trim() ? { note: note.trim() } : {}),
          },
          "POST",
          key.value(),
        ),
      );
      router.refresh();
    } catch (failure) {
      setError({
        text: problem(failure),
        stale:
          failure instanceof LiveApiError &&
          ["snapshot-changed", "version-conflict", "unverified-recipients"].includes(failure.code),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby="approve-heading"
      className="space-y-3 rounded-lg border border-primary/30 p-3"
    >
      <h3 id="approve-heading" className="font-semibold">
        {t("approveTitle")}
      </h3>
      <WaiverNote approval={approval} />
      {blockers.length ? (
        <div role="note" className="space-y-1 text-sm">
          <p className="font-medium">{t("blockedTitle")}</p>
          <ul className="list-disc space-y-1 pl-5">
            {blockers.map((blocker) => (
              <li key={blocker}>
                <BlockerText blocker={blocker} approval={approval} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {approvalDigest ? <DigestBox label={t("approvalDigest")} digest={approvalDigest} /> : null}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={confirmed}
          disabled={blocked}
          onChange={(event) => {
            key.renew();
            setConfirmed(event.target.checked);
          }}
        />
        {t("approveConfirm", { net: formatKES(approval.totals.netMinor) })}
      </label>
      <ReasonField
        optional
        value={note}
        onChange={(value) => {
          key.renew();
          setNote(value);
        }}
      />
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error.text}</p>
          {error.stale ? (
            <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
              {t("reload")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Button type="button" disabled={blocked || !confirmed || busy} onClick={() => void approve()}>
        {t("approve")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("approveHint")}</p>
    </section>
  );
}

function WaiverNote({ approval }: { approval: wire.BatchApprovalResponse }) {
  const t = useTranslations("payouts.approval");
  if (!approval.waiver.appliesToCaller) return null;
  return (
    <p role="note" className="text-sm">
      {t("waiverApplies", { limit: formatKES(approval.waiver.limitMinor) })}
    </p>
  );
}

function BlockerText({
  blocker,
  approval,
}: {
  blocker: ApprovalBlocker;
  approval: wire.BatchApprovalResponse;
}) {
  const t = useTranslations("payouts.blockers");
  const applied = approval.limit.appliedLimitMinor;
  if (blocker === "approval-limit-exceeded" && applied !== null)
    return (
      <>
        {t("limitFigures", {
          net: formatKES(approval.totals.netMinor),
          limit: formatKES(applied),
        })}
      </>
    );
  if (blocker === "unverified-recipients")
    return <>{t("unverifiedCount", { count: approval.unverifiedLabourerIds.length })}</>;
  if (blocker === "maker-checker")
    return (
      <>
        {approval.waiver.enabled ? t("makerCheckerWaiver") : t("makerChecker")}
      </>
    );
  return <>{t(blocker)}</>;
}
