"use client";

import { useState, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { nairobiDate } from "@pm-buddy/domain";
import {
  SUBCONTRACT_KINDS,
  SUBCONTRACT_PAYMENT_METHODS,
  SUBCONTRACT_VAT_TREATMENTS,
  type SubcontractLineBasis,
} from "@pm-buddy/types";
import {
  subcontractCertificateResponseSchema,
  subcontractResponseSchema,
} from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { parseKesInput } from "@/lib/spending";
import {
  newIdempotencyKey,
  parseChangeInput,
  parseDecimalInput,
  parsePercentInput,
} from "@/lib/subcontracts";
import { useSubcontractProblem } from "./use-subcontract-problem";

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function Failure({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

const formClass = "grid gap-3 rounded-xl border p-4 sm:grid-cols-2";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shared submit state: busy, the last refusal in EN/SW and a runner. */
function useSubmit() {
  const problem = useSubcontractProblem();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function submit(work: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }
  return { busy, failure, setFailure, submit };
}

/** A new draft subcontract with a flagged subcontractor and its terms (bq.edit). */
export function NewSubcontractForm({
  projectId,
  subcontractors,
}: {
  projectId: string;
  subcontractors: { id: string; code: string; name: string }[];
}) {
  const t = useTranslations("subcontracts.forms.create");
  const tKind = useTranslations("subcontracts.kinds");
  const router = useRouter();
  const today = nairobiDate();
  const { busy, failure, setFailure, submit } = useSubmit();
  const [values, setValues] = useState({
    supplierId: subcontractors[0]?.id ?? "",
    kind: "labour_only",
    title: "",
    scope: "",
    startDate: today,
    endDate: today,
    retentionPercent: "5",
    retentionLimitPercent: "5",
    practicalReleasePercent: "50",
    vatPercent: "16",
    whtPercent: "0",
    advance: "",
    advanceRecoveryPercent: "0",
    paymentTermsDays: "30",
  });
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  async function create() {
    const percents = {
      retentionPercent: parsePercentInput(values.retentionPercent),
      practicalReleasePercent: parsePercentInput(values.practicalReleasePercent),
      vatPercent: parsePercentInput(values.vatPercent, 0, 30),
      whtPercent: parsePercentInput(values.whtPercent, 0, 30),
      advanceRecoveryPercent: parsePercentInput(values.advanceRecoveryPercent),
    };
    const limit = values.retentionLimitPercent.trim()
      ? parsePercentInput(values.retentionLimitPercent)
      : null;
    const advance = values.advance.trim() ? parseKesInput(values.advance, true) : 0;
    const days = Number(values.paymentTermsDays);
    if (
      Object.values(percents).some((value) => value === null) ||
      (values.retentionLimitPercent.trim() && limit === null) ||
      advance === null ||
      !Number.isInteger(days)
    ) {
      setFailure(t("invalid"));
      return;
    }
    await submit(async () => {
      const result = await liveRequest(
        `/subcontracts/projects/${projectId}`,
        subcontractResponseSchema,
        {
          method: "POST",
          body: {
            supplierId: values.supplierId,
            kind: values.kind,
            title: values.title,
            scope: values.scope,
            startDate: values.startDate,
            endDate: values.endDate,
            ...percents,
            retentionLimitPercent: limit,
            advanceLimitMinor: advance,
            paymentTermsDays: days,
          },
        },
      );
      router.push(`/subcontracts/${result.subcontract.id}`);
    });
  }

  if (!subcontractors.length)
    return (
      <div className="space-y-1 rounded-xl border border-dashed p-4 text-sm">
        <p className="font-medium">{t("noSubcontractors")}</p>
        <p className="text-muted-foreground">{t("noSubcontractorsHint")}</p>
      </div>
    );
  const text = (
    key: keyof typeof values,
    label: string,
    extra: ComponentProps<typeof Input> = {},
  ) => (
    <Field>
      <FieldLabel htmlFor={`new-subcontract-${key}`}>{label}</FieldLabel>
      <Input
        id={`new-subcontract-${key}`}
        value={values[key]}
        onChange={(event) => set(key)(event.target.value)}
        {...extra}
      />
    </Field>
  );
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field>
        <FieldLabel htmlFor="new-subcontract-supplier">{t("subcontractor")}</FieldLabel>
        <select
          id="new-subcontract-supplier"
          className={selectClass}
          value={values.supplierId}
          onChange={(event) => set("supplierId")(event.target.value)}
        >
          {subcontractors.map((row) => (
            <option key={row.id} value={row.id}>
              {row.code} · {row.name}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-subcontract-kind">{t("kind")}</FieldLabel>
        <select
          id="new-subcontract-kind"
          className={selectClass}
          value={values.kind}
          onChange={(event) => set("kind")(event.target.value)}
        >
          {SUBCONTRACT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {tKind(kind)}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        {text("title", t("name"), { required: true, minLength: 3, maxLength: 200 })}
      </div>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="new-subcontract-scope">{t("scope")}</FieldLabel>
        <Textarea
          id="new-subcontract-scope"
          rows={2}
          maxLength={2000}
          value={values.scope}
          onChange={(event) => set("scope")(event.target.value)}
        />
      </Field>
      {text("startDate", t("start"), { type: "date", required: true })}
      {text("endDate", t("end"), { type: "date", required: true, min: values.startDate })}
      {text("retentionPercent", t("retention"), { inputMode: "decimal" })}
      <Field>
        <FieldLabel htmlFor="new-subcontract-retentionLimitPercent">
          {t("retentionLimit")}
        </FieldLabel>
        <Input
          id="new-subcontract-retentionLimitPercent"
          inputMode="decimal"
          value={values.retentionLimitPercent}
          onChange={(event) => set("retentionLimitPercent")(event.target.value)}
        />
        <FieldDescription>{t("retentionLimitHint")}</FieldDescription>
      </Field>
      {text("practicalReleasePercent", t("release"), { inputMode: "decimal" })}
      {text("vatPercent", t("vat"), { inputMode: "decimal" })}
      <Field>
        <FieldLabel htmlFor="new-subcontract-whtPercent">{t("wht")}</FieldLabel>
        <Input
          id="new-subcontract-whtPercent"
          inputMode="decimal"
          value={values.whtPercent}
          onChange={(event) => set("whtPercent")(event.target.value)}
        />
        <FieldDescription>{t("whtHint")}</FieldDescription>
      </Field>
      {text("paymentTermsDays", t("paymentDays"), { inputMode: "numeric" })}
      {text("advance", t("advance"), { inputMode: "decimal", placeholder: "0" })}
      {text("advanceRecoveryPercent", t("recovery"), { inputMode: "decimal" })}
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button
          type="submit"
          disabled={
            busy ||
            !values.title.trim() ||
            !DATE.test(values.startDate) ||
            !DATE.test(values.endDate)
          }
        >
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

export type LettableItem = {
  lineageId: string;
  label: string;
  basis: SubcontractLineBasis;
  unit: string | null;
  available: string;
};

/** Adds a line on a BQ item at the subcontract's own rate to a draft (bq.edit). */
export function AddLineForm({
  subcontractId,
  version,
  items,
}: {
  subcontractId: string;
  version: number;
  items: LettableItem[];
}) {
  const t = useTranslations("subcontracts.forms.line");
  const tVat = useTranslations("subcontracts.vat");
  const router = useRouter();
  const { busy, failure, setFailure, submit } = useSubmit();
  const [lineage, setLineage] = useState(items[0]?.lineageId ?? "");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [vat, setVat] = useState("standard");
  const [reason, setReason] = useState("");
  const item = items.find((row) => row.lineageId === lineage);
  const percent = item?.basis === "percent";

  async function add() {
    const parsedQuantity = parseDecimalInput(quantity, 4);
    const amount = parseKesInput(rate);
    if (
      !item ||
      parsedQuantity === null ||
      amount === null ||
      (percent && Number(parsedQuantity) > 100)
    ) {
      setFailure(t("invalid"));
      return;
    }
    await submit(async () => {
      await liveRequest(`/subcontracts/${subcontractId}/lines`, subcontractResponseSchema, {
        method: "POST",
        body: {
          version,
          bqItemLineageId: item.lineageId,
          quantity: parsedQuantity,
          rateMinor: percent ? null : amount,
          lumpSumMinor: percent ? amount : null,
          vatTreatment: vat,
          ...(reason.trim() ? { overQuantityReason: reason.trim() } : {}),
        },
      });
      setQuantity("");
      setRate("");
      setReason("");
      router.refresh();
    });
  }

  if (!items.length) return <p className="text-sm text-muted-foreground">{t("noItems")}</p>;
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="line-item">{t("item")}</FieldLabel>
        <select
          id="line-item"
          className={selectClass}
          value={lineage}
          onChange={(event) => setLineage(event.target.value)}
        >
          {items.map((row) => (
            <option key={row.lineageId} value={row.lineageId}>
              {row.label}
            </option>
          ))}
        </select>
        {item ? (
          <FieldDescription>
            {t("available", { quantity: item.available, unit: percent ? "%" : (item.unit ?? "") })}
          </FieldDescription>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="line-quantity">{percent ? t("share") : t("quantity")}</FieldLabel>
        <Input
          id="line-quantity"
          inputMode="decimal"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="line-rate">{percent ? t("lumpSum") : t("rate")}</FieldLabel>
        <Input
          id="line-rate"
          inputMode="decimal"
          value={rate}
          onChange={(event) => setRate(event.target.value)}
          required
        />
        <FieldDescription>{t("rateHint")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="line-vat">{t("vat")}</FieldLabel>
        <select
          id="line-vat"
          className={selectClass}
          value={vat}
          onChange={(event) => setVat(event.target.value)}
        >
          {SUBCONTRACT_VAT_TREATMENTS.map((value) => (
            <option key={value} value={value}>
              {tVat(value)}
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="line-reason">{t("overReason")}</FieldLabel>
        <Input
          id="line-reason"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        <FieldDescription>{t("overReasonHint")}</FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** Removes a line from a draft (bq.edit). */
export function RemoveLineButton({
  subcontractId,
  lineId,
  version,
  label,
}: {
  subcontractId: string;
  lineId: string;
  version: number;
  label: string;
}) {
  const router = useRouter();
  const { busy, failure, submit } = useSubmit();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void submit(async () => {
            await liveRequest(
              `/subcontracts/${subcontractId}/lines/${lineId}?version=${version}`,
              subcontractResponseSchema,
              { method: "DELETE" },
            );
            router.refresh();
          })
        }
      >
        {label}
      </Button>
      <Failure message={failure} />
    </span>
  );
}

/** Raises a variation: signed quantity changes on lines in force, with a reason (bq.edit). */
export function VariationForm({
  subcontractId,
  lines,
}: {
  subcontractId: string;
  lines: { id: string; label: string; quantity: string; unit: string }[];
}) {
  const t = useTranslations("subcontracts.forms.variation");
  const router = useRouter();
  const { busy, failure, setFailure, submit } = useSubmit();
  const [reason, setReason] = useState("");
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [overReason, setOverReason] = useState("");

  async function raise() {
    const rows: { lineId: string; quantityChange: string; overQuantityReason?: string }[] = [];
    for (const line of lines) {
      const typed = changes[line.id]?.trim();
      if (!typed) continue;
      const change = parseChangeInput(typed);
      if (change === null) {
        setFailure(t("invalid"));
        return;
      }
      rows.push({
        lineId: line.id,
        quantityChange: change,
        ...(overReason.trim() && !change.startsWith("-")
          ? { overQuantityReason: overReason.trim() }
          : {}),
      });
    }
    if (!rows.length || Array.from(reason.trim()).length < 3) {
      setFailure(t("invalid"));
      return;
    }
    await submit(async () => {
      await liveRequest(`/subcontracts/${subcontractId}/variations`, subcontractResponseSchema, {
        method: "POST",
        body: { reason: reason.trim(), changes: rows },
      });
      setReason("");
      setChanges({});
      setOverReason("");
      router.refresh();
    });
  }

  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void raise();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <p className="text-sm text-muted-foreground sm:col-span-2">{t("hint")}</p>
      {lines.map((line) => (
        <Field key={line.id}>
          <FieldLabel htmlFor={`variation-${line.id}`}>
            {t("change", { line: line.label, quantity: line.quantity, unit: line.unit })}
          </FieldLabel>
          <Input
            id={`variation-${line.id}`}
            inputMode="decimal"
            placeholder="-10"
            value={changes[line.id] ?? ""}
            onChange={(event) =>
              setChanges((current) => ({ ...current, [line.id]: event.target.value }))
            }
          />
        </Field>
      ))}
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="variation-reason">{t("reason")}</FieldLabel>
        <Textarea
          id="variation-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="variation-over">{t("overReason")}</FieldLabel>
        <Input
          id="variation-over"
          maxLength={500}
          value={overReason}
          onChange={(event) => setOverReason(event.target.value)}
        />
        <FieldDescription>{t("overReasonHint")}</FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** Asks for an advance within the agreed limit (bq.edit or finance.manage). */
export function AdvanceRequestForm({
  subcontractId,
  remainingMinor,
}: {
  subcontractId: string;
  remainingMinor: number;
}) {
  const t = useTranslations("subcontracts.forms.advance");
  const router = useRouter();
  const { busy, failure, setFailure, submit } = useSubmit();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  async function request() {
    const amountMinor = parseKesInput(amount);
    if (amountMinor === null || Array.from(reason.trim()).length < 3) {
      setFailure(t("invalid"));
      return;
    }
    await submit(async () => {
      await liveRequest(`/subcontracts/${subcontractId}/advances`, subcontractResponseSchema, {
        method: "POST",
        body: { amountMinor, reason: reason.trim() },
      });
      setAmount("");
      setReason("");
      router.refresh();
    });
  }

  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void request();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field>
        <FieldLabel htmlFor="advance-amount">{t("amount")}</FieldLabel>
        <Input
          id="advance-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
        />
        <FieldDescription>{t("remaining", { amount: formatKES(remainingMinor) })}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="advance-reason">{t("reason")}</FieldLabel>
        <Input
          id="advance-reason"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** Payment details shared by advances and certificates (paid outside PM-Buddy). */
function PaymentFields({
  prefix,
  values,
  set,
  minDate,
}: {
  prefix: string;
  values: { paidOn: string; method: string; reference: string };
  set: (key: "paidOn" | "method" | "reference", value: string) => void;
  minDate?: string;
}) {
  const t = useTranslations("subcontracts.forms.payment");
  const tMethod = useTranslations("subcontracts.methods");
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${prefix}-date`}>{t("paidOn")}</FieldLabel>
        <Input
          id={`${prefix}-date`}
          type="date"
          max={nairobiDate()}
          min={minDate}
          value={values.paidOn}
          onChange={(event) => set("paidOn", event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-method`}>{t("method")}</FieldLabel>
        <select
          id={`${prefix}-method`}
          className={selectClass}
          value={values.method}
          onChange={(event) => set("method", event.target.value)}
        >
          {SUBCONTRACT_PAYMENT_METHODS.map((method) => (
            <option key={method} value={method}>
              {tMethod(method)}
            </option>
          ))}
        </select>
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={`${prefix}-reference`}>{t("reference")}</FieldLabel>
        <Input
          id={`${prefix}-reference`}
          maxLength={60}
          value={values.reference}
          onChange={(event) => set("reference", event.target.value)}
          required
        />
        <FieldDescription>{t("referenceHint")}</FieldDescription>
      </Field>
    </>
  );
}

/** Records an approved advance as paid outside PM-Buddy (payments.disburse, step-up). */
export function AdvancePayForm({ advanceId, version }: { advanceId: string; version: number }) {
  const t = useTranslations("subcontracts.forms.advancePay");
  const router = useRouter();
  const stepUp = useStepUp();
  const { busy, failure, submit } = useSubmit();
  const [values, setValues] = useState({
    paidOn: nairobiDate(),
    method: "bank_transfer",
    reference: "",
  });
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(async () => {
          await stepUp.run(() =>
            liveRequest(`/subcontracts/advances/${advanceId}/pay`, subcontractResponseSchema, {
              method: "POST",
              body: { version, ...values, reference: values.reference.trim() },
            }),
          );
          router.refresh();
        });
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <PaymentFields
        prefix={`advance-${advanceId}`}
        values={values}
        set={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
      />
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy || values.reference.trim().length < 2}>
          {t("submit")}
        </Button>
      </div>
      {stepUp.dialog}
    </form>
  );
}

/** Opens a draft interim certificate or a retention release (bq.edit). */
export function NewCertificateForm({
  subcontractId,
  release,
  minDate,
}: {
  subcontractId: string;
  release: boolean;
  minDate: string | null;
}) {
  const t = useTranslations("subcontracts.forms.certificate");
  const router = useRouter();
  const today = nairobiDate();
  const { busy, failure, submit } = useSubmit();
  const [kind, setKind] = useState("interim");
  const [date, setDate] = useState(today);
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(async () => {
          const result = await liveRequest(
            `/subcontracts/${subcontractId}/certificates`,
            subcontractCertificateResponseSchema,
            {
              method: "POST",
              body:
                kind === "interim"
                  ? { valuationDate: date }
                  : { kind: "retention_release", releaseStage: kind, valuationDate: date },
            },
          );
          router.push(`/subcontracts/certificates/${result.certificate.id}`);
        });
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field>
        <FieldLabel htmlFor="new-certificate-kind">{t("kind")}</FieldLabel>
        <select
          id="new-certificate-kind"
          className={selectClass}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="interim">{t("kinds.interim")}</option>
          {release ? <option value="practical">{t("kinds.practical")}</option> : null}
          {release ? <option value="final">{t("kinds.final")}</option> : null}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-certificate-date">{t("date")}</FieldLabel>
        <Input
          id="new-certificate-date"
          type="date"
          value={date}
          max={today}
          min={minDate ?? undefined}
          onChange={(event) => setDate(event.target.value)}
        />
        <FieldDescription>{t("dateHint")}</FieldDescription>
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy || !DATE.test(date)}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/** The quantities to date claimed on a draft interim's lines (bq.edit). */
export function ClaimsForm({
  certificateId,
  version,
  lines,
}: {
  certificateId: string;
  version: number;
  lines: {
    lineId: string;
    label: string;
    unit: string;
    quantityToDate: string;
    availableQuantity: string;
    percent: boolean;
  }[];
}) {
  const t = useTranslations("subcontracts.forms.claims");
  const router = useRouter();
  const { busy, failure, setFailure, submit } = useSubmit();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((line) => [line.lineId, line.quantityToDate])),
  );

  async function save() {
    const claims: { lineId: string; quantityToDate: string }[] = [];
    for (const line of lines) {
      const parsed = parseDecimalInput(values[line.lineId] ?? "", 4, { allowZero: true });
      if (parsed === null || (line.percent && Number(parsed) > 100)) {
        setFailure(t("invalid"));
        return;
      }
      claims.push({ lineId: line.lineId, quantityToDate: parsed });
    }
    await submit(async () => {
      await liveRequest(
        `/subcontract-certificates/${certificateId}/claims`,
        subcontractCertificateResponseSchema,
        { method: "PUT", body: { version, claims } },
      );
      router.refresh();
    });
  }

  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <p className="text-sm text-muted-foreground sm:col-span-2">{t("hint")}</p>
      {lines.map((line) => (
        <Field key={line.lineId}>
          <FieldLabel htmlFor={`claim-${line.lineId}`}>{line.label}</FieldLabel>
          <Input
            id={`claim-${line.lineId}`}
            inputMode="decimal"
            value={values[line.lineId] ?? ""}
            onChange={(event) =>
              setValues((current) => ({ ...current, [line.lineId]: event.target.value }))
            }
          />
          <FieldDescription>
            {t("available", { quantity: line.availableQuantity, unit: line.unit })}
          </FieldDescription>
        </Field>
      ))}
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Records a payment made outside PM-Buddy against a certified certificate (payments.disburse,
 * step-up, never the certifier). One Idempotency-Key per form, so a retry never pays twice.
 */
export function PaymentForm({
  certificateId,
  outstandingMinor,
  minDate,
}: {
  certificateId: string;
  outstandingMinor: number;
  minDate: string;
}) {
  const t = useTranslations("subcontracts.forms.payment");
  const router = useRouter();
  const stepUp = useStepUp();
  const { busy, failure, setFailure, submit } = useSubmit();
  const [key, setKey] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState("");
  const [values, setValues] = useState({
    paidOn: nairobiDate(),
    method: "bank_transfer",
    reference: "",
  });

  async function record() {
    const amountMinor = parseKesInput(amount);
    if (amountMinor === null || amountMinor > outstandingMinor) {
      setFailure(t("invalid", { amount: formatKES(outstandingMinor) }));
      return;
    }
    await submit(async () => {
      await stepUp.run(() =>
        liveRequest(
          `/subcontract-certificates/${certificateId}/payments`,
          subcontractCertificateResponseSchema,
          {
            method: "POST",
            body: { amountMinor, ...values, reference: values.reference.trim() },
            headers: { "Idempotency-Key": key },
          },
        ),
      );
      setAmount("");
      setValues((current) => ({ ...current, reference: "" }));
      setKey(newIdempotencyKey());
      router.refresh();
    });
  }

  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void record();
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="payment-amount">{t("amount")}</FieldLabel>
        <Input
          id="payment-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
        />
        <FieldDescription>
          {t("outstanding", { amount: formatKES(outstandingMinor) })}
        </FieldDescription>
      </Field>
      <PaymentFields
        prefix="payment"
        values={values}
        minDate={minDate}
        set={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
      />
      <p className="text-xs text-muted-foreground sm:col-span-2">{t("outside")}</p>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy || values.reference.trim().length < 2}>
          {t("submit")}
        </Button>
      </div>
      {stepUp.dialog}
    </form>
  );
}

/** Matches the subcontractor's tax invoice to a certified certificate (finance.manage). */
export function InvoiceForm({
  certificateId,
  amountMinor,
}: {
  certificateId: string;
  amountMinor: number;
}) {
  const t = useTranslations("subcontracts.forms.invoice");
  const router = useRouter();
  const { busy, failure, submit } = useSubmit();
  const [number, setNumber] = useState("");
  const [date, setDate] = useState(nairobiDate());
  const [etims, setEtims] = useState("");
  return (
    <form
      className={formClass}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(async () => {
          await liveRequest(
            `/subcontract-certificates/${certificateId}/invoice`,
            subcontractCertificateResponseSchema,
            {
              method: "POST",
              body: { invoiceNumber: number.trim(), invoiceDate: date, etimsNumber: etims.trim() },
            },
          );
          router.refresh();
        });
      }}
    >
      <h3 className="font-semibold sm:col-span-2">{t("title")}</h3>
      <p className="text-sm text-muted-foreground sm:col-span-2">
        {t("hint", { amount: formatKES(amountMinor) })}
      </p>
      <Field>
        <FieldLabel htmlFor="invoice-number">{t("number")}</FieldLabel>
        <Input
          id="invoice-number"
          maxLength={60}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="invoice-date">{t("date")}</FieldLabel>
        <Input
          id="invoice-date"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          required
        />
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor="invoice-etims">{t("etims")}</FieldLabel>
        <Input
          id="invoice-etims"
          maxLength={60}
          value={etims}
          onChange={(event) => setEtims(event.target.value)}
        />
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <Failure message={failure} />
        <Button type="submit" disabled={busy || !number.trim()}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
