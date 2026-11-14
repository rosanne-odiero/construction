"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nairobiDate } from "@pm-buddy/domain";
import {
  CLIENT_PAYMENT_METHODS,
  CLIENT_PORTAL_LIMITS,
  FX_CURRENCIES,
  PAYBILL_ACCOUNT_FORMATS,
  type ClientPaymentMethod,
  type FxCurrency,
  type PaybillAccountFormat,
} from "@pm-buddy/types";
import {
  clientPaymentsResponseSchema,
  fxRatesResponseSchema,
  paymentInstructionsResponseSchema,
  variationClientResponseSchema,
  type PaymentInstructions,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";
import { newTimeOrderedId } from "@/lib/supplier-portal";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function Failure({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

/**
 * Records money received from the client against a certified certificate (finance.manage). The
 * entry's ID and Idempotency-Key are made once per entry and kept across retries, so a retried
 * request never records it twice; both are renewed after a success.
 */
export function ReceiptForm({
  projectId,
  certificates,
}: {
  projectId: string;
  certificates: { id: string; number: string; outstandingMinor: number }[];
}) {
  const t = useTranslations("clientPayments.record");
  const tMethods = useTranslations("clientPortal.methods");
  const problem = useProblemMessage();
  const router = useRouter();
  const open = certificates.filter((row) => row.outstandingMinor > 0);
  const [certificate, setCertificate] = useState(open[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [receivedOn, setReceivedOn] = useState(nairobiDate());
  const [method, setMethod] = useState<ClientPaymentMethod>("mpesa_paybill");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attempt = useRef<{ id: string; key: string } | null>(null);
  if (!open.length) return <p className="text-sm text-muted-foreground">{t("nothingOpen")}</p>;
  const outstanding = open.find((row) => row.id === certificate)?.outstandingMinor ?? 0;

  async function record() {
    setFailure(null);
    const amountMinor = parseKesInput(amount);
    if (amountMinor === null || amountMinor > outstanding) {
      setFailure(t("amountInvalid", { outstanding: formatKES(outstanding) }));
      return;
    }
    if (reference.trim().length < 3) {
      setFailure(t("referenceRequired"));
      return;
    }
    attempt.current ??= { id: newTimeOrderedId(), key: `receipt-${crypto.randomUUID()}` };
    setBusy(true);
    try {
      await liveRequest(`/projects/${projectId}/client-payments`, clientPaymentsResponseSchema, {
        method: "POST",
        body: {
          id: attempt.current.id,
          valuationId: certificate,
          amountMinor,
          receivedOn,
          method,
          reference: reference.trim(),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        headers: { "Idempotency-Key": attempt.current.key },
      });
      attempt.current = null;
      setAmount("");
      setReference("");
      setNote("");
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void record();
      }}
    >
      <Field>
        <FieldLabel htmlFor="receipt-certificate">{t("certificate")}</FieldLabel>
        <select
          id="receipt-certificate"
          className={selectClass}
          value={certificate}
          onChange={(event) => {
            setCertificate(event.target.value);
            attempt.current = null;
          }}
        >
          {open.map((row) => (
            <option key={row.id} value={row.id}>
              {t("certificateOption", {
                number: row.number,
                outstanding: formatKES(row.outstandingMinor),
              })}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="receipt-amount">{t("amount")}</FieldLabel>
        <Input
          id="receipt-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            attempt.current = null;
          }}
          placeholder="0.00"
        />
        <FieldDescription>
          {t("amountHint", { outstanding: formatKES(outstanding) })}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="receipt-date">{t("receivedOn")}</FieldLabel>
        <Input
          id="receipt-date"
          type="date"
          max={nairobiDate()}
          value={receivedOn}
          onChange={(event) => {
            setReceivedOn(event.target.value);
            attempt.current = null;
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="receipt-method">{t("method")}</FieldLabel>
        <select
          id="receipt-method"
          className={selectClass}
          value={method}
          onChange={(event) => {
            setMethod(event.target.value as ClientPaymentMethod);
            attempt.current = null;
          }}
        >
          {CLIENT_PAYMENT_METHODS.map((value) => (
            <option key={value} value={value}>
              {tMethods(value)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="receipt-reference">{t("reference")}</FieldLabel>
        <Input
          id="receipt-reference"
          value={reference}
          maxLength={CLIENT_PORTAL_LIMITS.referenceMax}
          onChange={(event) => {
            setReference(event.target.value);
            attempt.current = null;
          }}
        />
        <FieldDescription>{t("referenceHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="receipt-note">{t("note")}</FieldLabel>
        <Input
          id="receipt-note"
          value={note}
          maxLength={CLIENT_PORTAL_LIMITS.noteMax}
          onChange={(event) => {
            setNote(event.target.value);
            attempt.current = null;
          }}
        />
        <FieldDescription>{t("noteHint")}</FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("recording") : t("submit")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        <Failure message={failure} />
      </div>
    </form>
  );
}

/** Reverses a receipt in full with a reason the client will see (finance.manage). */
export function ReverseReceipt({ projectId, paymentId }: { projectId: string; paymentId: string }) {
  const t = useTranslations("clientPayments.reverse");
  const problem = useProblemMessage();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attempt = useRef<{ id: string; key: string } | null>(null);
  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("open")}
      </Button>
    );
  return (
    <div className="w-full space-y-2">
      <label htmlFor={`reverse-${paymentId}`} className="block text-sm font-medium">
        {t("reason")}
      </label>
      <Textarea
        id={`reverse-${paymentId}`}
        value={reason}
        maxLength={500}
        onChange={(event) => {
          setReason(event.target.value);
          attempt.current = null;
        }}
      />
      <p className="text-xs text-muted-foreground">{t("visible")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setFailure(null);
            if (reason.trim().length < 3) {
              setFailure(t("reasonRequired"));
              return;
            }
            attempt.current ??= { id: newTimeOrderedId(), key: `reverse-${crypto.randomUUID()}` };
            setBusy(true);
            try {
              await liveRequest(
                `/projects/${projectId}/client-payments/${paymentId}/reverse`,
                clientPaymentsResponseSchema,
                {
                  method: "POST",
                  body: { id: attempt.current.id, reason: reason.trim() },
                  headers: { "Idempotency-Key": attempt.current.key },
                },
              );
              router.refresh();
            } catch (error) {
              setFailure(problem(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("reversing") : t("confirm")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t("cancel")}
        </Button>
      </div>
      <Failure message={failure} />
    </div>
  );
}

/** The project's client terms: whether variations wait for the client, and the payment period. */
export function ClientTermsForm({
  projectId,
  version,
  clientApprovalRequired,
  paymentTermsDays,
}: {
  projectId: string;
  version: number;
  clientApprovalRequired: boolean;
  paymentTermsDays: number;
}) {
  const t = useTranslations("clientPayments.terms");
  const problem = useProblemMessage();
  const router = useRouter();
  const [required, setRequired] = useState(clientApprovalRequired);
  const [days, setDays] = useState(String(paymentTermsDays));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setFailure(null);
        const parsed = Number(days);
        const { min, max } = CLIENT_PORTAL_LIMITS.paymentTermsDays;
        if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
          setFailure(t("daysInvalid", { min, max }));
          return;
        }
        setBusy(true);
        try {
          await liveRequest(
            `/projects/${projectId}/client-settings`,
            clientPaymentsResponseSchema,
            {
              method: "PUT",
              body: { version, clientApprovalRequired: required, paymentTermsDays: parsed },
            },
          );
          router.refresh();
        } catch (error) {
          setFailure(problem(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />
        <span>
          <span className="block font-medium">{t("required")}</span>
          <span className="text-muted-foreground">{t("requiredHint")}</span>
        </span>
      </label>
      <Field>
        <FieldLabel htmlFor="terms-days">{t("days")}</FieldLabel>
        <Input
          id="terms-days"
          inputMode="numeric"
          value={days}
          onChange={(event) => setDays(event.target.value)}
          className="max-w-32"
        />
        <FieldDescription>{t("daysHint")}</FieldDescription>
      </Field>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? t("saving") : t("save")}
      </Button>
      <Failure message={failure} />
    </form>
  );
}

/** Sends the current submission of a variation to the client, with an optional message. */
export function SendToClient({
  projectId,
  variationId,
  version,
  snapshotDigest,
}: {
  projectId: string;
  variationId: string;
  version: number;
  snapshotDigest: string;
}) {
  const t = useTranslations("variationClient");
  const problem = useProblemMessage();
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <label htmlFor="client-message" className="block text-sm font-medium">
        {t("message")}
      </label>
      <Textarea
        id="client-message"
        value={message}
        maxLength={CLIENT_PORTAL_LIMITS.messageMax}
        onChange={(event) => setMessage(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t("sendHint")}</p>
      <Button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            await liveRequest(
              `/projects/${projectId}/bq/variations/${variationId}/client`,
              variationClientResponseSchema,
              {
                method: "POST",
                body: {
                  version,
                  snapshotDigest,
                  ...(message.trim() ? { message: message.trim() } : {}),
                },
              },
            );
            router.refresh();
          } catch (error) {
            setFailure(problem(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("sending") : t("send")}
      </Button>
      <Failure message={failure} />
    </div>
  );
}

/** The company's Paybill instructions for clients (config.manage, with a fresh second factor). */
export function PaymentInstructionsForm({
  instructions,
}: {
  instructions: PaymentInstructions | null;
}) {
  const t = useTranslations("clientSettings.instructions");
  const problem = useProblemMessage();
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [paybill, setPaybill] = useState(instructions?.paybillNumber ?? "");
  const [till, setTill] = useState(instructions?.tillNumber ?? "");
  const [accountName, setAccountName] = useState(instructions?.accountName ?? "");
  const [format, setFormat] = useState<PaybillAccountFormat>(
    instructions?.accountFormat ?? "project_certificate",
  );
  const [bank, setBank] = useState(instructions?.bankInstructions ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setMessage(null);
        setBusy(true);
        try {
          await run(() =>
            liveRequest("/client-portal/payment-instructions", paymentInstructionsResponseSchema, {
              method: "PUT",
              body: {
                version: instructions?.version ?? 0,
                paybillNumber: paybill.trim() || null,
                tillNumber: till.trim() || null,
                accountName: accountName.trim(),
                accountFormat: format,
                bankInstructions: bank.trim() || null,
              },
            }),
          );
          setMessage({ ok: true, text: t("saved") });
          router.refresh();
        } catch (error) {
          setMessage({ ok: false, text: problem(error) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor="paybill-number">{t("paybill")}</FieldLabel>
        <Input
          id="paybill-number"
          inputMode="numeric"
          value={paybill}
          maxLength={7}
          onChange={(event) => setPaybill(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="till-number">{t("till")}</FieldLabel>
        <Input
          id="till-number"
          inputMode="numeric"
          value={till}
          maxLength={7}
          onChange={(event) => setTill(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="account-name">{t("accountName")}</FieldLabel>
        <Input
          id="account-name"
          value={accountName}
          maxLength={150}
          onChange={(event) => setAccountName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="account-format">{t("format")}</FieldLabel>
        <select
          id="account-format"
          className={selectClass}
          value={format}
          onChange={(event) => setFormat(event.target.value as PaybillAccountFormat)}
        >
          {PAYBILL_ACCOUNT_FORMATS.map((value) => (
            <option key={value} value={value}>
              {t(`formats.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="bank-text">{t("bank")}</FieldLabel>
        <Textarea
          id="bank-text"
          value={bank}
          maxLength={500}
          onChange={(event) => setBank(event.target.value)}
        />
        <FieldDescription>{t("bankHint")}</FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("saving") : t("save")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        {message ? (
          <p
            role={message.ok ? "status" : "alert"}
            className={message.ok ? "text-sm" : "text-sm text-destructive"}
          >
            {message.text}
          </p>
        ) : null}
      </div>
      {dialog}
    </form>
  );
}

/** Enters an indicative rate (KES per unit), dated, with its source (append-only). */
export function FxRateForm() {
  const t = useTranslations("clientSettings.rates");
  const problem = useProblemMessage();
  const router = useRouter();
  const [currency, setCurrency] = useState<FxCurrency>("USD");
  const [rate, setRate] = useState("");
  const [rateDate, setRateDate] = useState(nairobiDate());
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setFailure(null);
        try {
          await liveRequest("/client-portal/fx-rates", fxRatesResponseSchema, {
            method: "POST",
            body: { currency, kesPerUnit: rate.trim(), rateDate, source: source.trim() },
          });
          setRate("");
          setSource("");
          router.refresh();
        } catch (error) {
          setFailure(problem(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor="fx-currency">{t("currency")}</FieldLabel>
        <select
          id="fx-currency"
          className={selectClass}
          value={currency}
          onChange={(event) => setCurrency(event.target.value as FxCurrency)}
        >
          {FX_CURRENCIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="fx-rate">{t("rate", { currency })}</FieldLabel>
        <Input
          id="fx-rate"
          inputMode="decimal"
          value={rate}
          placeholder="129.45"
          onChange={(event) => setRate(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="fx-date">{t("date")}</FieldLabel>
        <Input
          id="fx-date"
          type="date"
          max={nairobiDate()}
          value={rateDate}
          onChange={(event) => setRateDate(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="fx-source">{t("source")}</FieldLabel>
        <Input
          id="fx-source"
          value={source}
          maxLength={200}
          onChange={(event) => setSource(event.target.value)}
        />
        <FieldDescription>{t("sourceHint")}</FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("saving") : t("save")}
        </Button>
        <Failure message={failure} />
      </div>
    </form>
  );
}
