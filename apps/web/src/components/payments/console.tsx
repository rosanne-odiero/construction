"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { z } from "zod";
import type { Messages } from "@pm-buddy/i18n";
import {
  B2C_COMMANDS,
  CALLBACK_STATUSES,
  PAYMENT_PROBLEMS,
  PAYMENT_REQUEST_KINDS,
  PAYMENT_REQUEST_STATUSES,
  PAYMENT_SECRET_FIELDS,
  STK_TRANSACTION_TYPES,
  type PaymentProblem,
} from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/schedule/use-schedule-mutation";
import { formatKES } from "@/lib/format";
import { LiveApiError, liveRequest } from "@/lib/live-api";
import { paymentTone, wholeKesMinor } from "@/lib/payments";

export type ConsoleData =
  | { kind: "overview" | "new"; value: wire.PaymentsOverviewResponse }
  | { kind: "settings"; value: wire.PaymentSettingsResponse }
  | { kind: "requests"; value: wire.PaymentRequestsResponse }
  | { kind: "requestsDetail"; value: wire.PaymentRequestDetailResponse }
  | { kind: "callbacks"; value: wire.PaymentCallbacksResponse }
  | { kind: "callbacksDetail"; value: wire.PaymentCallbackResponse }
  | { kind: "cases"; value: wire.ReconciliationCasesResponse }
  | { kind: "casesDetail"; value: wire.ReconciliationCaseResponse };

type FieldKey = keyof Messages["payments"]["fields"];
function useCode() {
  const t = useTranslations("payments.codes");
  return (value: string) => {
    const key = value as keyof Messages["payments"]["codes"];
    return t.has(key) ? t(key) : value;
  };
}

function usePaymentsMutation() {
  const t = useTranslations("payments");
  const problem = useProblemMessage();
  const step = useStepUp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function run(operation: () => Promise<unknown>, done?: () => void) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await step.run(operation);
      setSaved(true);
      done?.();
      router.refresh();
    } catch (e) {
      setError(
        e instanceof LiveApiError && (PAYMENT_PROBLEMS as readonly string[]).includes(e.code)
          ? t(`problems.${e.code as PaymentProblem}`)
          : problem(e),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    run,
    invalid: () => setError(t("invalid")),
    feedback: (
      <>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm">
            {t("saved")}
          </p>
        ) : null}
        {step.dialog}
      </>
    ),
  };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 space-y-3 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function TextField({
  name,
  label,
  value,
  type = "text",
  required = false,
  maxLength,
  disabled = false,
}: {
  name: string;
  label: string;
  value?: string | number;
  type?: string;
  required?: boolean;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <label className="block min-w-0 space-y-1 text-sm">
      <span>{label}</span>
      <Input
        name={name}
        defaultValue={value}
        type={type}
        required={required}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete={type === "password" ? "new-password" : "off"}
      />
    </label>
  );
}

function SelectField({
  name,
  label,
  values,
  value,
  onChange,
  blank = false,
}: {
  name: string;
  label: string;
  values: readonly string[];
  value?: string;
  onChange?: (value: string) => void;
  blank?: boolean;
}) {
  const t = useTranslations("payments");
  const code = useCode();
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <select
        name={name}
        className={selectClass}
        defaultValue={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {blank ? <option value="">{t("all")}</option> : null}
        {values.map((v) => (
          <option key={v} value={v}>
            {code(v)}
          </option>
        ))}
      </select>
    </label>
  );
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function State({ value }: { value: string }) {
  const code = useCode();
  return <StatusBadge tone={paymentTone(value)}>{code(value)}</StatusBadge>;
}

function DateTime({ value }: { value: string | null }) {
  const locale = useLocale();
  return value ? (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale === "sw" ? "sw-KE" : "en-KE", {
        timeZone: "Africa/Nairobi",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))}
    </time>
  ) : (
    <>—</>
  );
}

function Refresh() {
  const t = useTranslations("payments");
  const router = useRouter();
  return (
    <Button variant="outline" onClick={() => router.refresh()}>
      {t("refresh")}
    </Button>
  );
}

function Timeline({ events }: { events: wire.PaymentEvent[] }) {
  const t = useTranslations("payments");
  const code = useCode();
  return (
    <Panel title={t("timeline")}>
      <ol className="space-y-3 border-l pl-4">
        {events.map((e) => (
          <li key={e.id} className="space-y-1 break-words text-sm">
            <DateTime value={e.at} /> · {e.actor?.displayName ?? t("system")}
            <div>
              {e.fromStatus ? (
                <>
                  <State value={e.fromStatus} /> →{" "}
                </>
              ) : null}
              {e.toStatus ? <State value={e.toStatus} /> : null}{" "}
              {e.reason ? code(e.reason) : e.event}
            </div>
          </li>
        ))}
        {!events.length ? <li>{t("empty")}</li> : null}
      </ol>
    </Panel>
  );
}

function CallbackCards({ callbacks }: { callbacks: wire.PaymentCallback[] }) {
  const t = useTranslations("payments");
  return (
    <div className="space-y-3">
      {callbacks.map((c) => (
        <article key={c.id} className="space-y-2 break-words rounded border p-3">
          <Link className="underline" href={`/payments/callbacks/${c.id}`}>
            {t(`codes.${c.kind}`)} · <DateTime value={c.receivedAt} />
          </Link>
          <div>
            <State value={c.status} />{" "}
            {c.quarantineReason ? <State value={c.quarantineReason} /> : null}
          </div>
          {c.quarantineReason === "unknown_request" ? (
            <p role="alert" className="text-sm">
              {t("unknownCallback")}
            </p>
          ) : null}
          <p className="text-sm">{t("duplicates", { count: c.duplicates })}</p>
          {c.requestId ? (
            <Link className="text-sm underline" href={`/payments/requests/${c.requestId}`}>
              {t("linkedRequest")}
            </Link>
          ) : null}
        </article>
      ))}
      {!callbacks.length ? <p>{t("empty")}</p> : null}
    </div>
  );
}

function CaseCards({ cases }: { cases: wire.ReconciliationCase[] }) {
  const t = useTranslations("payments");
  const code = useCode();
  return (
    <div className="space-y-3">
      {cases.map((c) => (
        <article key={c.id} className="space-y-2 break-words rounded border p-3">
          <Link className="underline" href={`/payments/cases/${c.id}`}>
            {t(`codes.${c.kind}`)}
          </Link>
          <div>
            <State value={c.status} /> {c.attemptStatus ? <State value={c.attemptStatus} /> : null}
          </div>
          <p className="text-sm">
            {t("owner")}: {c.owner} · {t("opened")}: <DateTime value={c.openedAt} />
          </p>
          <p className="text-sm">{code(c.reason)}</p>
        </article>
      ))}
      {!cases.length ? <p>{t("empty")}</p> : null}
    </div>
  );
}

function ListControls({
  kind,
  total,
  offset,
  status,
}: {
  kind: string;
  total: number;
  offset: number;
  status: string;
}) {
  const t = useTranslations("payments");
  const values =
    kind === "requests"
      ? PAYMENT_REQUEST_STATUSES
      : kind === "callbacks"
        ? CALLBACK_STATUSES
        : ["open", "resolved", "dismissed"];
  return (
    <div className="flex flex-wrap items-end gap-3">
      <form className="flex items-end gap-2" action={`/payments/${kind}`}>
        <SelectField name="status" label={t("status")} values={values} value={status} blank />
        <Button variant="outline" type="submit">
          {t("filter")}
        </Button>
      </form>
      <p className="text-sm">{t("total", { count: total })}</p>
      {offset > 0 ? (
        <Link
          className="underline"
          href={`/payments/${kind}?offset=${Math.max(0, offset - 25)}&status=${status}`}
        >
          {t("previous")}
        </Link>
      ) : null}
      {offset + 25 < total ? (
        <Link
          className="underline"
          href={`/payments/${kind}?offset=${offset + 25}&status=${status}`}
        >
          {t("next")}
        </Link>
      ) : null}
      <Refresh />
    </div>
  );
}

export function PaymentConsole({
  data,
  offset,
  status,
}: {
  data: ConsoleData;
  offset: number;
  status: string;
}) {
  const t = useTranslations("payments");
  switch (data.kind) {
    case "overview": {
      const v = data.value;
      return (
        <div className="space-y-4">
          <p>
            {t("environment")}: {v.environment ? t(`codes.${v.environment}`) : t("notConfigured")} ·{" "}
            {t(v.payoutsEnabled ? "payoutsOn" : "payoutsOff")}
          </p>
          <Refresh />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(v.counts).map(([key, value]) => (
              <div key={key} className="rounded border p-3">
                <p className="text-sm text-muted-foreground">
                  {t(`counts.${key as keyof Messages["payments"]["counts"]}`)}
                </p>
                <p className="text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          {v.counts.uncertain > 0 ? (
            <p role="alert">
              {t("uncertainty")} · <DateTime value={v.oldestUncertainAt} />
            </p>
          ) : null}
          <Panel title={t("balance")}>
            <p className="text-sm">{t("balanceHint")}</p>
            {v.latestBalance ? (
              <>
                <State value={v.latestBalance.status} />{" "}
                <DateTime value={v.latestBalance.requestedAt} />
                {v.latestBalance.balances?.map((b, i) => (
                  <p key={i}>
                    {b.account}:{" "}
                    {b.availableMinor === null
                      ? "—"
                      : `${b.currency} ${(b.availableMinor / 100).toLocaleString()}`}
                  </p>
                ))}
              </>
            ) : (
              <p>{t("empty")}</p>
            )}
            {v.configured &&
            (v.permissions.review ||
              v.permissions.manageCredentials ||
              v.permissions.initiateTest) ? (
              <SimpleAction
                path="/payments/balance-checks"
                schema={wire.balanceCheckResponseSchema}
                label={t("checkBalance")}
              />
            ) : null}
          </Panel>
          <Panel title={t("receipts")}>
            {v.receipts.map((r) => (
              <p key={r.id} className="break-words">
                {r.receipt} · {formatKES(r.amountMinor)} · <State value={r.status} />
              </p>
            ))}
            {!v.receipts.length ? <p>{t("empty")}</p> : null}
          </Panel>
        </div>
      );
    }
    case "requests":
      return (
        <Panel title={t("nav.requests")}>
          <ListControls kind="requests" total={data.value.total} offset={offset} status={status} />
          <div className="grid gap-3 md:grid-cols-2">
            {data.value.requests.map((r) => (
              <article key={r.id} className="min-w-0 space-y-2 break-words rounded border p-4">
                <Link className="font-medium underline" href={`/payments/requests/${r.id}`}>
                  {r.reference}
                </Link>
                <p>
                  {formatKES(r.amountMinor)} · {r.counterparty}
                </p>
                <p>
                  {t(`codes.${r.kind}`)} · {t(`codes.${r.environment}`)}
                </p>
                <State value={r.status} />{" "}
                {r.latestAttempt ? <State value={r.latestAttempt.status} /> : null}
                {r.status === "uncertain" ? <p className="text-sm">{t("uncertainty")}</p> : null}
                <p className="text-xs">
                  <DateTime value={r.createdAt} />
                </p>
              </article>
            ))}
          </div>
          {!data.value.requests.length ? <p>{t("empty")}</p> : null}
        </Panel>
      );
    case "requestsDetail":
      return <RequestDetail value={data.value} />;
    case "callbacks":
      return (
        <Panel title={t("nav.callbacks")}>
          <p role={data.value.openAlerts ? "alert" : undefined}>
            {t("openAlerts", { count: data.value.openAlerts })}
          </p>
          <ListControls kind="callbacks" total={data.value.total} offset={offset} status={status} />
          <CallbackCards callbacks={data.value.callbacks} />
        </Panel>
      );
    case "callbacksDetail":
      return <CallbackDetail value={data.value} />;
    case "cases":
      return (
        <Panel title={t("nav.cases")}>
          <p>{t("openCases", { count: data.value.open })}</p>
          <ListControls kind="cases" total={data.value.total} offset={offset} status={status} />
          <CaseCards cases={data.value.cases} />
        </Panel>
      );
    case "casesDetail":
      return <CaseDetail value={data.value} />;
    case "new":
      return <TestForm overview={data.value} />;
    case "settings":
      return <Settings value={data.value} />;
  }
}

function SimpleAction<T>({
  path,
  schema,
  label,
}: {
  path: string;
  schema: z.ZodType<T>;
  label: string;
}) {
  const m = usePaymentsMutation();
  return (
    <div className="space-y-2">
      <Button
        disabled={m.busy}
        variant="outline"
        onClick={() => void m.run(() => liveRequest(path, schema, { method: "POST" }))}
      >
        {label}
      </Button>
      {m.feedback}
    </div>
  );
}

function RequestDetail({ value: v }: { value: wire.PaymentRequestDetailResponse }) {
  const t = useTranslations("payments");
  const attempt = v.attempts.find((a) => a.id === v.request.latestAttempt?.id);
  return (
    <div className="space-y-4">
      <Panel title={v.request.reference}>
        <p>
          {formatKES(v.request.amountMinor)} · {v.request.counterparty} ·{" "}
          {t(`codes.${v.request.environment}`)}
        </p>
        <State value={v.request.status} />
        {["uncertain", "in_progress", "reversal_pending"].includes(v.request.status) ? (
          <p role="alert">{t("uncertainty")}</p>
        ) : null}
        <p className="text-sm">
          {t("creator")}: {v.request.createdBy?.displayName ?? "—"} ·{" "}
          <DateTime value={v.request.createdAt} />
        </p>
        <Refresh />
      </Panel>
      <Panel title={t("attempts")}>
        {v.attempts.map((a) => (
          <article key={a.id} className="space-y-2 break-words rounded border p-3">
            <h3 className="font-medium">
              {t("attempt", { count: a.sequence })} · {t(`codes.${a.kind}`)}
            </h3>
            <State value={a.status} /> <span>{formatKES(a.amountMinor)}</span>
            <p className="text-sm">
              {t("receipt")}: {a.receipt ?? "—"}
            </p>
            <p className="text-xs">
              {a.resultCode} {a.resultDesc}
            </p>
            <dl className="text-xs">
              {Object.entries(a.providerIds).map(([key, val]) => (
                <div key={key}>
                  <dt className="inline">{t(`fields.${key as FieldKey}`)}: </dt>
                  <dd className="inline">{val ?? "—"}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs">
              <DateTime value={a.createdAt} /> → <DateTime value={a.finalizedAt} />
            </p>
          </article>
        ))}
      </Panel>
      {attempt && v.canQueryStatus ? (
        <SimpleAction
          path={`/payments/attempts/${attempt.id}/status-query`}
          schema={wire.paymentRequestDetailResponseSchema}
          label={t("queryStatus")}
        />
      ) : null}
      <p className="text-sm text-muted-foreground">{t("queryHint")}</p>
      {attempt && v.canReverse ? (
        <ReviewForm mode="reversal" id={attempt.id} version={attempt.version} />
      ) : null}
      <Timeline events={v.timeline} />
      <Panel title={t("nav.callbacks")}>
        <CallbackCards callbacks={v.callbacks} />
      </Panel>
      <Panel title={t("nav.cases")}>
        <CaseCards cases={v.cases} />
      </Panel>
      <Panel title={t("queries")}>
        {v.queries.map((q) => (
          <p key={q.id}>
            {t(`codes.${q.kind}`)} · <State value={q.status} /> · <DateTime value={q.createdAt} />{" "}
            {q.summary}
          </p>
        ))}
        {!v.queries.length ? <p>{t("empty")}</p> : null}
      </Panel>
      <Panel title={t("receipts")}>
        {v.transactions.map((r) => (
          <p key={r.id}>
            {r.receipt} · {formatKES(r.amountMinor)} · <State value={r.status} />
          </p>
        ))}
        {!v.transactions.length ? <p>{t("empty")}</p> : null}
      </Panel>
    </div>
  );
}

function CallbackDetail({ value: v }: { value: wire.PaymentCallbackResponse }) {
  const t = useTranslations("payments");
  return (
    <div className="space-y-4">
      <Panel title={t("callbackDetail")}>
        <CallbackCards callbacks={[v.callback]} />
        <p className="break-all text-xs">SHA-256: {v.callback.bodySha256}</p>
        <p>{t("bodyBytes", { count: v.callback.bodyBytes })}</p>
        <h3 className="font-medium">{t("redactedBody")}</h3>
        <pre className="max-w-full whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
          {JSON.stringify(v.callback.redactedBody, null, 2)}
        </pre>
        <Refresh />
        {v.callback.review ? (
          <p>
            {t(`codes.${v.callback.review.decision}`)} · {v.callback.review.by?.displayName} ·{" "}
            <DateTime value={v.callback.review.at} /> · {v.callback.review.reason}
          </p>
        ) : null}
      </Panel>
      {v.canReview ? (
        <ReviewForm mode="callback" id={v.callback.id} version={v.callback.version} />
      ) : null}
    </div>
  );
}

function CaseDetail({ value: v }: { value: wire.ReconciliationCaseResponse }) {
  const t = useTranslations("payments");
  return (
    <div className="space-y-4">
      <Panel title={t("caseDetail")}>
        <CaseCards cases={[v.case]} />
        {v.case.amountMinor !== null ? <p>{formatKES(v.case.amountMinor)}</p> : null}
        {v.case.requestId ? (
          <Link className="underline" href={`/payments/requests/${v.case.requestId}`}>
            {t("linkedRequest")}
          </Link>
        ) : null}
        {v.case.callbackId ? (
          <Link className="block underline" href={`/payments/callbacks/${v.case.callbackId}`}>
            {t("callbackDetail")}
          </Link>
        ) : null}
        {v.case.resolution ? (
          <p>
            <State value={v.case.resolution} /> {v.case.resolutionNote} ·{" "}
            {v.case.resolvedBy?.displayName} · <DateTime value={v.case.resolvedAt} />
          </p>
        ) : null}
        <Refresh />
      </Panel>
      {v.case.canResolve ? (
        <ReviewForm
          mode="case"
          id={v.case.id}
          version={v.case.version}
          uncertain={["submitting", "pending", "unknown"].includes(v.case.attemptStatus ?? "")}
          outcomeCase={["unknown_outcome", "unverified_success"].includes(v.case.kind)}
        />
      ) : null}
      <Timeline events={v.timeline} />
    </div>
  );
}

function ReviewForm({
  mode,
  id,
  version,
  uncertain = false,
  outcomeCase = false,
}: {
  mode: "case" | "callback" | "reversal";
  id: string;
  version: number;
  uncertain?: boolean;
  outcomeCase?: boolean;
}) {
  const t = useTranslations("payments");
  const m = usePaymentsMutation();
  const key = useRef<string | null>(null);
  const decisions =
    mode === "callback"
      ? ["resolved", "dismissed"]
      : outcomeCase && uncertain
        ? ["failed", "confirmed"]
        : ["no_payment_effect", "dismissed"];
  const [decision, setDecision] = useState(decisions[0]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const base = { version, reason: text(form, "reason") };
    const schema =
      mode === "case"
        ? wire.resolveCaseRequestSchema
        : mode === "callback"
          ? wire.reviewCallbackRequestSchema
          : wire.requestReversalRequestSchema;
    const parsed = schema.safeParse({
      ...base,
      ...(mode === "case"
        ? {
            resolution: text(form, "decision"),
            ...(decision === "confirmed"
              ? { receipt: text(form, "receipt"), amountMinor: wholeKesMinor(text(form, "amount")) }
              : {}),
          }
        : {}),
      ...(mode === "callback" ? { decision: text(form, "decision") } : {}),
    });
    if (!parsed.success) {
      m.invalid();
      return;
    }
    key.current ??= crypto.randomUUID();
    const path =
      mode === "case"
        ? `cases/${id}/resolve`
        : mode === "callback"
          ? `callbacks/${id}/review`
          : `attempts/${id}/reversal`;
    const response =
      mode === "case"
        ? wire.reconciliationCaseResponseSchema
        : mode === "callback"
          ? wire.paymentCallbackResponseSchema
          : wire.paymentRequestDetailResponseSchema;
    await m.run(() =>
      liveRequest(`/payments/${path}`, response as z.ZodType<unknown>, {
        method: "POST",
        body: parsed.data,
        headers: { "Idempotency-Key": key.current! },
      }),
    );
  }
  return (
    <Panel title={t(mode === "reversal" ? "reverse" : "review")}>
      <p className="text-sm">{t("reviewHint")}</p>
      <form className="max-w-xl space-y-3" onSubmit={submit}>
        {mode !== "reversal" ? (
          <SelectField
            name="decision"
            label={t("decision")}
            values={decisions}
            value={decision}
            onChange={setDecision}
          />
        ) : null}
        {mode === "case" && decision === "confirmed" ? (
          <>
            <TextField name="receipt" label={t("receipt")} required maxLength={20} />
            <TextField name="amount" label={t("amount")} required />
            <p className="text-sm">{t("evidenceHint")}</p>
          </>
        ) : null}
        <TextField name="reason" label={t("reason")} required maxLength={500} />
        <Button type="submit" disabled={m.busy}>
          {t(mode === "reversal" ? "reverse" : "submitReview")}
        </Button>
        {m.feedback}
      </form>
    </Panel>
  );
}

function TestForm({ overview }: { overview: wire.PaymentsOverviewResponse }) {
  const t = useTranslations("payments");
  const router = useRouter();
  const m = usePaymentsMutation();
  const [kind, setKind] = useState("stk_push");
  const pending = useRef<{ key: string; body: Record<string, unknown> } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const blocked =
    !overview.configured ||
    !overview.permissions.initiateTest ||
    overview.environment === "production";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pending.current) {
      const f = new FormData(e.currentTarget);
      const parsed = wire.createTestPaymentRequestSchema.safeParse({
        kind,
        amountMinor: wholeKesMinor(text(f, "amount")),
        ...(kind === "stk_push"
          ? {
              phone: text(f, "phone"),
              accountReference: text(f, "accountReference"),
              description: text(f, "description"),
            }
          : kind === "b2c"
            ? { phone: text(f, "phone"), command: text(f, "command"), remarks: text(f, "remarks") }
            : {
                partyB: text(f, "partyB"),
                accountReference: text(f, "accountReference"),
                remarks: text(f, "remarks"),
              }),
      });
      if (!parsed.success) {
        m.invalid();
        return;
      }
      pending.current = { key: crypto.randomUUID(), body: parsed.data };
    }
    const attempt = pending.current;
    await m.run(async () => {
      try {
        const result = await liveRequest("/payments/requests", wire.paymentRequestResponseSchema, {
          method: "POST",
          body: attempt.body,
          headers: { "Idempotency-Key": attempt.key },
        });
        router.push(`/payments/requests/${result.request.id}`);
      } catch (error) {
        // A dropped response may have created the request: freeze payload and key for retry.
        if (
          error instanceof LiveApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.code !== "idempotency-key-reused"
        ) {
          pending.current = null;
          setUncertain(false);
        } else setUncertain(true);
        throw error;
      }
    });
  }
  return (
    <Panel title={t("nav.new")}>
      <p>
        {t("testHint")} ·{" "}
        {overview.environment ? t(`codes.${overview.environment}`) : t("notConfigured")}
      </p>
      {!overview.payoutsEnabled ? <p role="alert">{t("queuedPayouts")}</p> : null}
      {uncertain ? <p role="alert">{t("retryHint")}</p> : null}
      <form className="max-w-xl space-y-3" onSubmit={submit}>
        <fieldset disabled={blocked || m.busy || uncertain} className="space-y-3">
          <SelectField
            name="kind"
            label={t("kind")}
            values={PAYMENT_REQUEST_KINDS}
            value={kind}
            onChange={setKind}
          />
          <TextField name="amount" label={t("amount")} required />
          {kind === "stk_push" || kind === "b2c" ? (
            <TextField name="phone" label={t("phone")} required />
          ) : (
            <TextField name="partyB" label={t("partyB")} required />
          )}
          {kind !== "b2c" ? (
            <TextField
              name="accountReference"
              label={t("accountReference")}
              required
              maxLength={kind === "stk_push" ? 12 : 13}
            />
          ) : (
            <SelectField name="command" label={t("command")} values={B2C_COMMANDS} />
          )}
          {kind === "stk_push" ? (
            <TextField name="description" label={t("description")} maxLength={13} />
          ) : (
            <TextField name="remarks" label={t("remarks")} required maxLength={100} />
          )}
        </fieldset>
        <Button type="submit" disabled={blocked || m.busy}>
          {t(uncertain ? "retry" : "initiate")}
        </Button>
        {m.feedback}
      </form>
    </Panel>
  );
}

function Settings({ value: v }: { value: wire.PaymentSettingsResponse }) {
  const t = useTranslations("payments");
  const m = usePaymentsMutation();
  const s = v.settings;
  const [secretsKey, setSecretsKey] = useState(0);
  if (!s)
    return (
      <Panel title={t("nav.settings")}>
        <p>{t("notConfigured")}</p>
        {v.canManage ? (
          <Button
            disabled={m.busy}
            onClick={() =>
              void m.run(() =>
                liveRequest("/payments/settings", wire.paymentSettingsResponseSchema, {
                  method: "POST",
                }),
              )
            }
          >
            {t("initialise")}
          </Button>
        ) : null}
        {m.feedback}
      </Panel>
    );
  async function save(e: FormEvent<HTMLFormElement>, credentials: boolean) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (!s) return;
    const schema = credentials
      ? wire.updatePaymentCredentialsRequestSchema
      : wire.updatePaymentSettingsRequestSchema;
    const raw = credentials
      ? {
          version: s.version,
          ...Object.fromEntries(
            PAYMENT_SECRET_FIELDS.filter((k) => String(f.get(k) ?? "").length).map((k) => [
              k,
              String(f.get(k)),
            ]),
          ),
        }
      : {
          version: s.version,
          environment: text(f, "environment"),
          shortcodes: Object.fromEntries(
            Object.keys(s.shortcodes).map((k) => [k, text(f, k) || null]),
          ),
          limits: Object.fromEntries(
            Object.keys(s.limits).map((k) => [k, wholeKesMinor(text(f, k))]),
          ),
        };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      m.invalid();
      return;
    }
    // Clear write-only inputs immediately, including when a step-up or network failure follows.
    if (credentials) {
      form.reset();
      setSecretsKey((k) => k + 1);
    }
    await m.run(() =>
      liveRequest(
        `/payments/settings${credentials ? "/credentials" : ""}`,
        wire.paymentSettingsResponseSchema,
        { method: "PUT", body: parsed.data },
      ),
    );
  }
  return (
    <div className="space-y-4">
      <p>
        {t("productionBlocked")} · {t(s.payoutsEnabled ? "payoutsOn" : "payoutsOff")}
      </p>
      {m.feedback}
      <Panel title={t("configuration")}>
        <form className="max-w-3xl space-y-3" onSubmit={(e) => void save(e, false)} key={s.version}>
          <fieldset disabled={!v.canManage || m.busy} className="space-y-3">
            <SelectField
              name="environment"
              label={t("environment")}
              values={s.availableEnvironments.filter((e) => e !== "production")}
              value={s.environment}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(s.shortcodes).map(([k, val]) =>
                k === "stkTransactionType" ? (
                  <SelectField
                    key={k}
                    name={k}
                    label={t(`fields.${k}`)}
                    values={STK_TRANSACTION_TYPES}
                    value={val ?? undefined}
                  />
                ) : (
                  <TextField
                    key={k}
                    name={k}
                    label={t(`fields.${k as FieldKey}`)}
                    value={val ?? ""}
                  />
                ),
              )}
            </div>
            <h3 className="font-medium">
              {t("limits")} · {t(`codes.${s.limitsStatus}`)}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(s.limits).map(([k, val]) => (
                <TextField
                  key={k}
                  name={k}
                  label={t(`fields.${k as FieldKey}`)}
                  value={val / 100}
                  required
                />
              ))}
            </div>
            {v.canManage ? <Button type="submit">{t("save")}</Button> : null}
          </fieldset>
        </form>
      </Panel>
      <Panel title={t("credentials")}>
        <p className="text-sm">{t("writeOnly")}</p>
        <form key={secretsKey} className="max-w-3xl space-y-3" onSubmit={(e) => void save(e, true)}>
          <fieldset disabled={!v.canManage || m.busy} className="grid gap-3 sm:grid-cols-2">
            {PAYMENT_SECRET_FIELDS.map((k) => (
              <div key={k} className="space-y-1">
                <TextField
                  name={k}
                  label={t(`fields.${k}`)}
                  type="password"
                  maxLength={k === "initiatorName" ? 100 : 512}
                />
                <p className="text-xs">
                  {t(s.secrets[k].configured ? "configured" : "notSet")} ·{" "}
                  <DateTime value={s.secrets[k].updatedAt} />
                </p>
              </div>
            ))}
          </fieldset>
          {v.canManage ? (
            <Button disabled={m.busy} type="submit">
              {t("replaceCredentials")}
            </Button>
          ) : null}
        </form>
      </Panel>
      {v.canManage || v.canPause ? (
        <SettingsOperations settings={s} canManage={v.canManage} />
      ) : null}
      <Panel title={t("callbackUrls")}>
        {s.callbackUrlWarnings.length ? <p role="alert">{t("callbackWarning")}</p> : null}
        <p>
          {t(s.ipAllowlistEnabled ? "allowlistOn" : "allowlistOff")} ·{" "}
          {t(s.certificateConfigured ? "certificateOn" : "certificateOff")}
        </p>
        <ul className="space-y-2">
          {s.callbackUrls.map((c) => (
            <li key={c.kind} className="break-all text-sm">
              {t(`codes.${c.kind}`)}: {c.url}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function SettingsOperations({
  settings: s,
  canManage,
}: {
  settings: wire.PaymentSettings;
  canManage: boolean;
}) {
  const t = useTranslations("payments");
  const m = usePaymentsMutation();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const action = text(f, "action");
    const raw = {
      version: s.version,
      reason: text(f, "reason"),
      ...(action === "payouts" ? { enabled: !s.payoutsEnabled } : {}),
    };
    const parsed = (
      action === "payouts" ? wire.payoutSwitchRequestSchema : wire.rotateCallbackTokenRequestSchema
    ).safeParse(raw);
    if (!parsed.success) {
      m.invalid();
      return;
    }
    await m.run(() =>
      liveRequest(`/payments/settings/${action}`, wire.paymentSettingsResponseSchema, {
        method: action === "payouts" ? "PUT" : "POST",
        body: parsed.data,
      }),
    );
  }
  return (
    <Panel title={t("controls")}>
      <p className="text-sm">{t("controlsHint")}</p>
      <form className="max-w-xl space-y-3" onSubmit={submit}>
        <label className="block text-sm">
          {t("action")}
          <select name="action" className={selectClass}>
            {canManage || s.payoutsEnabled ? (
              <option value="payouts">
                {t(s.payoutsEnabled ? "pausePayouts" : "enablePayouts")}
              </option>
            ) : null}
            {canManage ? <option value="callback-token">{t("rotateToken")}</option> : null}
          </select>
        </label>
        <TextField name="reason" label={t("reason")} required maxLength={500} />
        <Button disabled={m.busy || (!canManage && !s.payoutsEnabled)} type="submit">
          {t("apply")}
        </Button>
        {m.feedback}
      </form>
      {canManage ? (
        <>
          <p className="text-sm">{t("c2bHint")}</p>
          <SimpleAction
            path="/payments/settings/c2b-registration"
            schema={wire.paymentSettingsResponseSchema}
            label={t("registerC2b")}
          />
        </>
      ) : null}
    </Panel>
  );
}
