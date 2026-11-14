"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ClipboardPaste } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import {
  COST_CATEGORIES,
  MPESA_OUTFLOW_KINDS,
  SPENDING_LIMITS,
  type CostCategory,
} from "@pm-buddy/types";
import {
  expenseResponseSchema,
  receiptResponseSchema,
  smsParseResponseSchema,
  type SmsParseResponse,
} from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatKES } from "@/lib/format";
import { liveRequest, liveUpload } from "@/lib/live-api";
import { expenseRetryPlan, minorToInput, newClientId, parseKesInput } from "@/lib/spending";
import { spendingSelectClass } from "./spending-action";
import { SentenceBadge } from "./sentence-badge";
import { TagPicker, type CostTag } from "./tag-picker";

type OutflowKind = (typeof MPESA_OUTFLOW_KINDS)[number];
type Form = {
  spentOn: string;
  amount: string;
  charge: string;
  method: "cash" | "mpesa";
  mpesaCode: string;
  payeeName: string;
  payeeAccount: string;
  payeePhoneMasked: string;
  counterpartyKind: "other" | "worker";
  category: CostCategory;
  description: string;
};

const blank = (): Form => ({
  spentOn: nairobiDate(),
  amount: "",
  charge: "",
  method: "cash",
  mpesaCode: "",
  payeeName: "",
  payeeAccount: "",
  payeePhoneMasked: "",
  counterpartyKind: "other",
  category: "petty_cash",
  description: "",
});

const isOutflow = (kind: string): kind is OutflowKind =>
  (MPESA_OUTFLOW_KINDS as readonly string[]).includes(kind);

/**
 * Records a petty-cash expense at 360 px (D5.4). A pasted M-Pesa SMS fills a draft only — the
 * custodian checks it, tags it and attaches the receipt photo; the message never confirms that money
 * moved. Offline-ready contract: the record ID and Idempotency-Key are created once per form, so
 * a retry after a dropped connection returns the original instead of spending twice.
 */
export function ExpenseForm({
  floatId,
  projectId,
  balanceMinor,
}: {
  floatId: string;
  projectId: string;
  balanceMinor: number;
}) {
  const t = useTranslations("spending.expenseForm");
  const tCategory = useTranslations("spending.categories");
  const tSms = useTranslations("spending.sms");
  const problem = useP2pProblem();
  const router = useRouter();
  const [ids, setIds] = useState(() => ({
    id: newClientId(),
    key: newClientId(),
    capturedAt: new Date().toISOString(),
  }));
  const [form, setForm] = useState<Form>(blank);
  const [tag, setTag] = useState<CostTag | null>(null);
  const [sms, setSms] = useState("");
  const [parsed, setParsed] = useState<SmsParseResponse | null>(null);
  const [smsKind, setSmsKind] = useState<OutflowKind | null>(null);
  const [smsFailure, setSmsFailure] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [recordedId, setRecordedId] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Editing a filled-in field keeps the SMS link only while the code is unchanged.
    if (key === "mpesaCode") setSmsKind(null);
  };

  async function readSms() {
    setSmsFailure(null);
    setParsed(null);
    try {
      const result = await liveRequest("/petty-cash/sms/parse", smsParseResponseSchema, {
        method: "POST",
        body: { text: sms },
      });
      setParsed(result);
      if (!result.result.ok) return;
      const draft = result.result.draft;
      if (!isOutflow(draft.kind)) {
        setSmsFailure(tSms("notOutflow"));
        return;
      }
      setForm((current) => ({
        ...current,
        method: "mpesa",
        amount: minorToInput(draft.amountMinor),
        charge: draft.chargeMinor ? minorToInput(draft.chargeMinor) : "",
        mpesaCode: draft.code,
        payeeName: draft.counterpartyName ?? current.payeeName,
        payeeAccount: draft.account ?? "",
        payeePhoneMasked: draft.counterpartyPhoneMasked ?? "",
        spentOn: draft.occurredOn ?? current.spentOn,
      }));
      setSmsKind(draft.kind);
    } catch (error) {
      setSmsFailure(problem(error));
    }
  }

  function validate(): { body: Record<string, unknown> } | { invalid: string } {
    const amountMinor = parseKesInput(form.amount);
    if (amountMinor === null) return { invalid: t("amountInvalid") };
    const chargeMinor = form.method === "mpesa" ? parseKesInput(form.charge || "0", true) : 0;
    if (chargeMinor === null) return { invalid: t("chargeInvalid") };
    if (amountMinor + chargeMinor > balanceMinor)
      return { invalid: t("aboveBalance", { balance: formatKES(balanceMinor) }) };
    if (!tag) return { invalid: t("tagRequired") };
    const code = form.mpesaCode.trim().toUpperCase();
    if (form.method === "mpesa" && !/^(?=.*[A-Z])[A-Z0-9]{10}$/.test(code))
      return { invalid: t("codeInvalid") };
    if (Array.from(form.payeeName.trim()).length < 2) return { invalid: t("payeeRequired") };
    if (Array.from(form.description.trim()).length < 3)
      return { invalid: t("descriptionRequired") };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.spentOn)) return { invalid: t("dateInvalid") };
    const phone = form.payeePhoneMasked.trim();
    return {
      body: {
        id: ids.id,
        floatId,
        capturedAt: ids.capturedAt,
        spentOn: form.spentOn,
        amountMinor,
        chargeMinor,
        category: form.category,
        ...(tag.kind === "item" ? { bqItemLineageId: tag.lineageId } : { costCodeId: tag.id }),
        counterpartyKind: form.counterpartyKind,
        payeeName: form.payeeName.trim(),
        payeeAccount: form.payeeAccount.trim() || null,
        payeePhoneMasked: /^0[17]\d{2}\*{3}\d{3}$/.test(phone) ? phone : null,
        paymentMethod: form.method,
        mpesaCode: form.method === "mpesa" ? code : null,
        parsedFromSms: form.method === "mpesa" && smsKind !== null,
        smsKind: form.method === "mpesa" ? smsKind : null,
        description: form.description.trim(),
        source: "web",
      },
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const built = validate();
    if ("invalid" in built) {
      setFailure(built.invalid);
      return;
    }
    setBusy(true);
    setFailure(null);
    setRecordedId(null);
    try {
      const result = await liveRequest("/petty-cash/expenses", expenseResponseSchema, {
        method: "POST",
        body: built.body,
        headers: { "Idempotency-Key": ids.key },
      });
      if (file) {
        try {
          await liveUpload(
            `/petty-cash/expenses/${result.expense.id}/receipts`,
            file,
            receiptResponseSchema,
          );
        } catch {
          // The expense is recorded; its page offers the upload again.
        }
      }
      setIds({ id: newClientId(), key: newClientId(), capturedAt: new Date().toISOString() });
      router.push(`/spending/petty-cash/expenses/${result.expense.id}`);
    } catch (error) {
      const plan = expenseRetryPlan(error);
      if (plan === "renew")
        setIds({ id: newClientId(), key: newClientId(), capturedAt: new Date().toISOString() });
      if (plan === "recorded") {
        // An earlier attempt from this form was recorded (its reply was lost): never record
        // it again under a new ID; point at the recorded expense instead.
        setRecordedId(ids.id);
        setFailure(t("alreadyRecorded"));
      } else setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5" noValidate>
      <section aria-labelledby="sms-title" className="space-y-2 rounded-xl border p-3">
        <h2 id="sms-title" className="font-semibold">
          {tSms("title")}
        </h2>
        <Field>
          <FieldLabel htmlFor="sms-text">{tSms("label")}</FieldLabel>
          <Textarea
            id="sms-text"
            rows={4}
            value={sms}
            maxLength={SPENDING_LIMITS.smsMaxLength}
            onChange={(event) => setSms(event.target.value)}
          />
          <FieldDescription>{tSms("hint")}</FieldDescription>
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={!sms.trim()}
          onClick={() => void readSms()}
        >
          <ClipboardPaste aria-hidden /> {tSms("read")}
        </Button>
        {smsFailure ? (
          <p role="alert" className="text-sm text-destructive">
            {smsFailure}
          </p>
        ) : null}
        {parsed && !parsed.result.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {tSms(`errors.${parsed.result.error}`)}
          </p>
        ) : null}
        {parsed?.result.ok ? (
          <div role="status" className="space-y-1">
            <SentenceBadge tone="warning">{tSms("draftOnly")}</SentenceBadge>
            <p className="text-sm">
              {tSms("filled", {
                kind: tSms(`kinds.${parsed.result.draft.kind}`),
                code: parsed.result.draft.code,
                amount: formatKES(parsed.result.draft.amountMinor),
              })}
            </p>
            {parsed.result.warnings.length ? (
              <p className="text-xs text-muted-foreground">
                {parsed.result.warnings.map((warning) => tSms(`warnings.${warning}`)).join(" ")}
              </p>
            ) : null}
            {parsed.duplicates.length ? (
              <SentenceBadge tone="danger">
                {tSms("duplicate", {
                  records: parsed.duplicates.map((entry) => entry.label).join(", "),
                })}
              </SentenceBadge>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="expense-method">{t("method")}</FieldLabel>
          <select
            id="expense-method"
            className={spendingSelectClass}
            value={form.method}
            onChange={(event) => set("method", event.target.value === "mpesa" ? "mpesa" : "cash")}
          >
            <option value="cash">{t("cash")}</option>
            <option value="mpesa">{t("mpesa")}</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="expense-date">{t("spentOn")}</FieldLabel>
          <Input
            id="expense-date"
            type="date"
            value={form.spentOn}
            onChange={(event) => set("spentOn", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="expense-amount">{t("amount")}</FieldLabel>
          <Input
            id="expense-amount"
            inputMode="decimal"
            autoComplete="off"
            value={form.amount}
            onChange={(event) => set("amount", event.target.value)}
          />
          <FieldDescription>
            {t("balanceHint", { balance: formatKES(balanceMinor) })}
          </FieldDescription>
        </Field>
        {form.method === "mpesa" ? (
          <>
            <Field>
              <FieldLabel htmlFor="expense-charge">{t("charge")}</FieldLabel>
              <Input
                id="expense-charge"
                inputMode="decimal"
                autoComplete="off"
                value={form.charge}
                onChange={(event) => set("charge", event.target.value)}
              />
              <FieldDescription>{t("chargeHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="expense-code">{t("mpesaCode")}</FieldLabel>
              <Input
                id="expense-code"
                autoComplete="off"
                autoCapitalize="characters"
                maxLength={10}
                value={form.mpesaCode}
                onChange={(event) => set("mpesaCode", event.target.value)}
              />
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel htmlFor="expense-payee">{t("payee")}</FieldLabel>
          <Input
            id="expense-payee"
            autoComplete="off"
            maxLength={200}
            value={form.payeeName}
            onChange={(event) => set("payeeName", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="expense-party">{t("counterparty")}</FieldLabel>
          <select
            id="expense-party"
            className={spendingSelectClass}
            value={form.counterpartyKind}
            onChange={(event) =>
              set("counterpartyKind", event.target.value === "worker" ? "worker" : "other")
            }
          >
            <option value="other">{t("counterpartyOther")}</option>
            <option value="worker">{t("counterpartyWorker")}</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="expense-account">{t("account")}</FieldLabel>
          <Input
            id="expense-account"
            autoComplete="off"
            maxLength={40}
            value={form.payeeAccount}
            onChange={(event) => set("payeeAccount", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="expense-category">{t("category")}</FieldLabel>
          <select
            id="expense-category"
            className={spendingSelectClass}
            value={form.category}
            onChange={(event) => set("category", event.target.value as CostCategory)}
          >
            {COST_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {tCategory(category)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("tag")}</p>
        <TagPicker
          id="expense-tag"
          projectId={projectId}
          value={tag}
          onChange={(next) => {
            setTag(next);
            if (next?.kind === "costCode") set("category", next.category);
          }}
        />
        <p className="text-sm text-muted-foreground">{t("tagHint")}</p>
      </div>
      <Field>
        <FieldLabel htmlFor="expense-description">{t("details")}</FieldLabel>
        <Textarea
          id="expense-description"
          rows={2}
          maxLength={500}
          value={form.description}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="expense-receipt">{t("receipt")}</FieldLabel>
        <input
          id="expense-receipt"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="max-w-full text-sm file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <FieldDescription>{t("receiptHint")}</FieldDescription>
      </Field>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
          {recordedId ? (
            <>
              {" "}
              <Link
                href={`/spending/petty-cash/expenses/${recordedId}`}
                className="font-medium underline underline-offset-4"
              >
                {t("openRecorded")}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="w-full sm:w-auto">
        {busy ? t("saving") : t("submit")}
      </Button>
    </form>
  );
}
