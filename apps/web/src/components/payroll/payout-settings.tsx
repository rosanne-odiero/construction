"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { PAYOUT_SETTINGS_LIMITS } from "@pm-buddy/types";
import * as wire from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/labour/action-dialog";
import { formatDateTime, formatKES } from "@/lib/format";
import { payrollCommand } from "@/lib/payroll";
import { ratioInput, wholeShillingsToMinor } from "@/lib/payouts";
import { ReasonField, useCommandKey, validReason } from "./command-dialog";
import { usePayoutProblem } from "./payout-problem";
import { WaiverBanner } from "./waiver-banner";

type Feedback = { error: boolean; text: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.error ? "alert" : "status"}
      className={feedback.error ? "text-sm text-destructive" : "text-sm"}
    >
      {feedback.text}
    </p>
  );
}

/** A KES amount shown as whole shillings in an input ("20000"); 0 stays 0. */
const shillings = (minor: number) => String(Math.round(minor / 100));

/**
 * Company payout settings (CONFIGURATION "D4.3" rows, all proposals): cash cap, name match, change
 * hold, unusual amount, business hours and float age. config.manage + step-up to change.
 */
export function PayoutSettingsPanel({ value }: { value: wire.PayoutSettingsResponse }) {
  const t = useTranslations("payouts.settings");
  const router = useRouter();
  const stepUp = useStepUp();
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const s = value.settings;
  const [form, setForm] = useState({
    cash: shillings(s.cashMaxPerWorkerPeriodMinor),
    threshold: String(s.nameMatchThreshold),
    hold: s.nameMismatchHold ? "true" : "false",
    holdHours: String(s.payeeChangeHoldHours),
    unusual: shillings(s.unusualNewRecipientMinor),
    start: s.businessHoursStart,
    end: s.businessHoursEnd,
    floatAge: String(s.floatCheckMaxAgeMinutes),
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const update = (name: keyof typeof form) => (event: { target: { value: string } }) => {
    key.renew();
    setForm((current) => ({ ...current, [name]: event.target.value }));
  };
  const body = {
    version: s.version,
    cashMaxPerWorkerPeriodMinor: form.cash.trim() === "0" ? 0 : wholeShillingsToMinor(form.cash),
    nameMatchThreshold: ratioInput(form.threshold),
    nameMismatchHold: form.hold === "true",
    payeeChangeHoldHours: /^\d{1,3}$/.test(form.holdHours) ? Number(form.holdHours) : null,
    unusualNewRecipientMinor: wholeShillingsToMinor(form.unusual),
    businessHoursStart: form.start,
    businessHoursEnd: form.end,
    floatCheckMaxAgeMinutes: /^\d{1,3}$/.test(form.floatAge) ? Number(form.floatAge) : null,
  };
  const parsed = wire.updatePayoutSettingsRequestSchema.safeParse(body);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    setFeedback(null);
    try {
      await stepUp.run(() =>
        payrollCommand(
          "/payroll/payout-settings",
          wire.payoutSettingsResponseSchema,
          parsed.data as Record<string, unknown>,
          "PUT",
          key.value(),
        ),
      );
      key.renew();
      setFeedback({ error: false, text: t("saved") });
      router.refresh();
    } catch (error) {
      setFeedback({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }
  const field = (
    name: keyof typeof form,
    hint: string,
    props: { type?: string; inputMode?: "numeric" | "decimal" } = {},
  ) => (
    <Field>
      <FieldLabel htmlFor={`payout-${name}`}>{t(`fields.${name}`)}</FieldLabel>
      <Input
        id={`payout-${name}`}
        value={form[name]}
        onChange={update(name)}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        disabled={!value.canManage}
        aria-describedby={`payout-${name}-hint`}
      />
      <FieldDescription id={`payout-${name}-hint`}>{hint}</FieldDescription>
    </Field>
  );
  return (
    <section aria-labelledby="payout-settings-heading" className="space-y-3 rounded-xl border p-4">
      <h2 id="payout-settings-heading" className="font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      {s.updatedBy && s.updatedAt ? (
        <p className="text-xs text-muted-foreground">
          {t("updated", { name: s.updatedBy.displayName, date: formatDateTime(s.updatedAt) })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("defaults")}</p>
      )}
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void save(event)}>
        {field("cash", t("hints.cash", { max: formatKES(PAYOUT_SETTINGS_LIMITS.cashMaxPerWorkerPeriodMinor.max) }), { inputMode: "numeric" })}
        {field("threshold", t("hints.threshold"), { inputMode: "decimal" })}
        <Field>
          <FieldLabel htmlFor="payout-hold">{t("fields.hold")}</FieldLabel>
          <select
            id="payout-hold"
            className={selectClass}
            value={form.hold}
            onChange={update("hold")}
            disabled={!value.canManage}
          >
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </select>
        </Field>
        {field("holdHours", t("hints.holdHours"), { inputMode: "numeric" })}
        {field("unusual", t("hints.unusual"), { inputMode: "numeric" })}
        {field("floatAge", t("hints.floatAge"), { inputMode: "numeric" })}
        {field("start", t("hints.hours"), { type: "time" })}
        {field("end", t("hints.hours"), { type: "time" })}
        {value.canManage ? (
          <div className="space-y-2 sm:col-span-2">
            {!parsed.success ? <p className="text-sm text-muted-foreground">{t("invalid")}</p> : null}
            <FeedbackLine feedback={feedback} />
            <Button type="submit" disabled={busy || !parsed.success}>
              {t("save")}
            </Button>
          </div>
        ) : null}
      </form>
      {stepUp.dialog}
    </section>
  );
}

/**
 * The owner-only segregation waiver (OR-04): with a reason and step-up, the reviewer of a batch may
 * also approve it under a lower limit. Every page that approves shows a banner while it is on.
 */
export function WaiverPanel({ value }: { value: wire.PayoutSettingsResponse }) {
  const t = useTranslations("payouts.settings");
  const router = useRouter();
  const stepUp = useStepUp();
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const waiver = value.settings.waiver;
  const [reason, setReason] = useState("");
  const [limit, setLimit] = useState(shillings(waiver.limitMinor));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const limitMinor = wholeShillingsToMinor(limit);
  const parsed = wire.updateWaiverRequestSchema.safeParse({
    version: value.settings.version,
    enabled: !waiver.enabled,
    reason: reason.trim(),
    ...(!waiver.enabled && limitMinor !== null ? { limitMinor } : {}),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    setFeedback(null);
    try {
      await stepUp.run(() =>
        payrollCommand(
          "/payroll/payout-settings/waiver",
          wire.payoutSettingsResponseSchema,
          parsed.data as Record<string, unknown>,
          "PUT",
          key.value(),
        ),
      );
      key.renew();
      setReason("");
      setFeedback({ error: false, text: t(waiver.enabled ? "waiverDisabled" : "waiverEnabled") });
      router.refresh();
    } catch (error) {
      setFeedback({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="waiver-heading" className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="waiver-heading" className="font-semibold">
          {t("waiverTitle")}
        </h2>
        <StatusBadge tone={waiver.enabled ? "warning" : "neutral"}>
          {t(waiver.enabled ? "waiverOn" : "waiverOff")}
        </StatusBadge>
      </div>
      <p className="text-sm text-muted-foreground">{t("waiverHint")}</p>
      <WaiverBanner waiver={waiver} />
      {value.canManageWaiver ? (
        <form className="max-w-xl space-y-3" onSubmit={(event) => void submit(event)}>
          {!waiver.enabled ? (
            <Field>
              <FieldLabel htmlFor="waiver-limit">{t("waiverLimit")}</FieldLabel>
              <Input
                id="waiver-limit"
                inputMode="numeric"
                value={limit}
                onChange={(event) => {
                  key.renew();
                  setLimit(event.target.value);
                }}
                aria-describedby="waiver-limit-hint"
              />
              <FieldDescription id="waiver-limit-hint">{t("waiverLimitHint")}</FieldDescription>
            </Field>
          ) : null}
          <ReasonField
            value={reason}
            onChange={(next) => {
              key.renew();
              setReason(next);
            }}
          />
          <FeedbackLine feedback={feedback} />
          <Button
            type="submit"
            variant={waiver.enabled ? "outline" : "destructive"}
            disabled={busy || !validReason(reason) || !parsed.success}
          >
            {t(waiver.enabled ? "disableWaiver" : "enableWaiver")}
          </Button>
        </form>
      ) : (
        <p className="text-sm">{t("ownerOnly")}</p>
      )}
      {stepUp.dialog}
    </section>
  );
}

/**
 * Batch approval limits per role (§3): the owner's default applies while the owner has no row;
 * any other role without a row cannot approve. The whole set is replaced (config.manage, step-up).
 */
export function ApprovalLimitsPanel({ value }: { value: wire.ApprovalLimitsResponse }) {
  const t = useTranslations("payouts.settings");
  const tRoles = useTranslations("foundation.roles");
  const router = useRouter();
  const stepUp = useStepUp();
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const roleKey = (role: { systemRole: string | null; customRoleId: string | null }) =>
    role.systemRole ?? `custom:${role.customRoleId}`;
  const configured = new Map(value.limits.map((row) => [roleKey(row), row]));
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      value.roles.map((role) => {
        const row = configured.get(roleKey(role));
        return [roleKey(role), row ? shillings(row.maxBatchNetMinor) : ""];
      }),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const roleName = (role: { systemRole: string | null; name: string }) => {
    const parsed = role.systemRole ? wire.tenantRoleSchema.safeParse(role.systemRole) : null;
    return parsed?.success ? tRoles(parsed.data) : role.name;
  };
  const limits = value.roles
    .filter((role) => (inputs[roleKey(role)] ?? "").trim() !== "")
    .map((role) => ({
      systemRole: role.systemRole,
      customRoleId: role.customRoleId,
      maxBatchNetMinor: wholeShillingsToMinor(inputs[roleKey(role)] ?? ""),
    }));
  const parsed = wire.updateApprovalLimitsRequestSchema.safeParse({
    version: value.version,
    limits,
  });
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    setFeedback(null);
    try {
      await stepUp.run(() =>
        payrollCommand(
          "/payroll/approval-limits",
          wire.approvalLimitsResponseSchema,
          parsed.data as Record<string, unknown>,
          "PUT",
          key.value(),
        ),
      );
      key.renew();
      setFeedback({ error: false, text: t("saved") });
      router.refresh();
    } catch (error) {
      setFeedback({ error: true, text: problem(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="limits-heading" className="space-y-3 rounded-xl border p-4">
      <h2 id="limits-heading" className="font-semibold">
        {t("limitsTitle")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("limitsHint", { amount: formatKES(value.ownerDefaultMinor) })}
      </p>
      <ul className="space-y-1 text-sm">
        {value.limits.map((row) => (
          <li key={roleKey(row)}>
            {roleName({ systemRole: row.systemRole, name: row.roleName })}:{" "}
            {formatKES(row.maxBatchNetMinor)}
            {row.updatedBy && row.updatedAt
              ? ` · ${t("updated", { name: row.updatedBy.displayName, date: formatDateTime(row.updatedAt) })}`
              : ""}
          </li>
        ))}
        {!value.limits.length ? <li>{t("noLimits")}</li> : null}
      </ul>
      {value.canManage ? (
        <form className="max-w-xl space-y-3" onSubmit={(event) => void save(event)}>
          {value.roles.map((role) => (
            <Field key={roleKey(role)}>
              <FieldLabel htmlFor={`limit-${roleKey(role)}`}>
                {t("limitFor", { role: roleName(role) })}
              </FieldLabel>
              <Input
                id={`limit-${roleKey(role)}`}
                inputMode="numeric"
                value={inputs[roleKey(role)] ?? ""}
                onChange={(event) => {
                  key.renew();
                  setInputs((current) => ({ ...current, [roleKey(role)]: event.target.value }));
                }}
                aria-describedby="limit-hint"
              />
            </Field>
          ))}
          <p id="limit-hint" className="text-xs text-muted-foreground">
            {t("limitInputHint")}
          </p>
          {!parsed.success ? <p className="text-sm text-muted-foreground">{t("invalid")}</p> : null}
          <FeedbackLine feedback={feedback} />
          <Button type="submit" disabled={busy || !parsed.success}>
            {t("saveLimits")}
          </Button>
        </form>
      ) : null}
      {stepUp.dialog}
    </section>
  );
}
