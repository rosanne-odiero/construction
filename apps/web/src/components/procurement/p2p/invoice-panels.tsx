"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BadgeCheck, CheckCircle2, ShieldAlert } from "lucide-react";
import { REASON_LIMITS } from "@pm-buddy/domain";
import { SETTLEMENT_METHODS, type SettlementMethod } from "@pm-buddy/types";
import { invoiceDetailResponseSchema } from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
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
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { inputToMinor, minorToInput, newClientId } from "@/lib/p2p";
import { useP2pProblem } from "./use-p2p-problem";

/**
 * Approval for payment (payments.approve + step-up, not a contributor). The request quotes the
 * match and the verified payout version on screen, so a newer match or changed payee details
 * are refused (match-stale / payee-changed) rather than approved unseen.
 */
export function ApproveInvoice({
  invoiceId,
  number,
  version,
  matchId,
  payoutVersionId,
  amountMinor,
  payee,
  reapproval,
}: {
  invoiceId: string;
  number: string;
  version: number;
  matchId: string;
  payoutVersionId: string;
  amountMinor: number;
  payee: string;
  reapproval: boolean;
}) {
  const t = useTranslations("p2p.approval");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setFailure(null);
    try {
      await stepUp.run(() =>
        liveRequest(`/procurement/invoices/${invoiceId}/approve`, invoiceDetailResponseSchema, {
          method: "POST",
          body: { version, matchId, payoutVersionId },
        }),
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        <BadgeCheck aria-hidden /> {reapproval ? t("reapprove") : t("approve")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle", { number })}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">{payee}</p>
          <p className="text-sm font-medium">{t("amount", { amount: formatKES(amountMinor) })}</p>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void approve()}>
              {t("confirm", { amount: formatKES(amountMinor) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

/** An independent approved exception for the current mismatch (payments.approve + step-up). */
export function ExceptInvoice({
  invoiceId,
  number,
  version,
  matchId,
}: {
  invoiceId: string;
  number: string;
  version: number;
  matchId: string;
}) {
  const t = useTranslations("p2p.match.exception");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function except() {
    setBusy(true);
    setFailure(null);
    try {
      await stepUp.run(() =>
        liveRequest(`/procurement/invoices/${invoiceId}/exception`, invoiceDetailResponseSchema, {
          method: "POST",
          body: { version, matchId, reason: reason.trim() },
        }),
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        <ShieldAlert aria-hidden /> {t("button")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("dialogTitle", { number })}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="exception-reason">{tCommon("reason")}</FieldLabel>
            <Textarea
              id="exception-reason"
              rows={3}
              maxLength={REASON_LIMITS.max}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <FieldDescription>{tCommon("reasonHint")}</FieldDescription>
          </Field>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            <Button
              type="button"
              disabled={busy || reason.trim().length < REASON_LIMITS.min}
              onClick={() => void except()}
            >
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

/**
 * Records a payment made outside PM-Buddy (payments.disburse + step-up, not the approver). The
 * Idempotency-Key is generated once per entry, so a retry after a lost response is not counted
 * twice; amounts above the outstanding balance are refused here and by the API.
 */
export function SettlementForm({
  invoiceId,
  outstandingMinor,
  invoiceDate,
  today,
}: {
  invoiceId: string;
  outstandingMinor: number;
  invoiceDate: string;
  today: string;
}) {
  const t = useTranslations("p2p.settlement");
  const tMethod = useTranslations("p2p.status.method");
  const problem = useP2pProblem();
  const router = useRouter();
  const stepUp = useStepUp();
  const [key, setKey] = useState(newClientId);
  const [method, setMethod] = useState<SettlementMethod>("bank_transfer");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(minorToInput(outstandingMinor));
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const minor = inputToMinor(amount);
  const above = minor !== null && minor > outstandingMinor;
  const valid =
    minor !== null &&
    minor > 0 &&
    !above &&
    /^[A-Za-z0-9][A-Za-z0-9 ./_-]{2,59}$/.test(reference.trim()) &&
    paidOn >= invoiceDate &&
    paidOn <= today;

  async function record() {
    setBusy(true);
    setMessage(null);
    try {
      await stepUp.run(() =>
        liveRequest(`/procurement/invoices/${invoiceId}/settlements`, invoiceDetailResponseSchema, {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: {
            method,
            externalReference: reference.trim(),
            amountMinor: minor,
            paidOn,
            note: note.trim() || null,
          },
        }),
      );
      setKey(newClientId());
      setReference("");
      setNote("");
      setMessage({ text: t("recorded"), error: false });
      router.refresh();
    } catch (error) {
      setMessage({ text: problem(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        className="space-y-3 rounded-lg border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void record();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="settlement-method">{t("method")}</FieldLabel>
            <select
              id="settlement-method"
              className={selectClass}
              value={method}
              onChange={(event) => setMethod(event.target.value as SettlementMethod)}
            >
              {SETTLEMENT_METHODS.map((value) => (
                <option key={value} value={value}>
                  {tMethod(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="settlement-reference">{t("reference")}</FieldLabel>
            <Input
              id="settlement-reference"
              maxLength={60}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <FieldDescription>{t("referenceHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="settlement-amount">{t("amount")}</FieldLabel>
            <Input
              id="settlement-amount"
              inputMode="decimal"
              value={amount}
              aria-invalid={above}
              onChange={(event) => setAmount(event.target.value)}
            />
            {above ? (
              <p className="text-sm text-destructive">
                {t("aboveOutstanding", { amount: formatKES(outstandingMinor) })}
              </p>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="settlement-paid-on">{t("paidOn")}</FieldLabel>
            <Input
              id="settlement-paid-on"
              type="date"
              min={invoiceDate}
              max={today}
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="settlement-note">{t("note")}</FieldLabel>
          <Input
            id="settlement-note"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {message ? (
          <p
            role={message.error ? "alert" : "status"}
            className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {message.text}
          </p>
        ) : null}
        <Button type="submit" disabled={busy || !valid}>
          <CheckCircle2 aria-hidden /> {t("record")}
        </Button>
      </form>
      {stepUp.dialog}
    </>
  );
}
