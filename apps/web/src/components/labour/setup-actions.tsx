"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { ACCREDITATION_ALERT_DAYS_LIMITS, NCA_CATEGORIES, RATE_BASES } from "@pm-buddy/types";
import {
  labourRateResponseSchema,
  labourSetupResponseSchema,
  messageResponseSchema,
  skillLevelResponseSchema,
  tradeResponseSchema,
  type LabourSetupResponse,
  type SkillLevel,
  type Trade,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { calendarInput, parseCalendarInput, parseShillings } from "@/lib/project-input";
import { ActionDialog, selectClass } from "./action-dialog";
import { localName } from "./labour-badges";

export function InstallDefaultsButton() {
  const t = useTranslations("labourLive.setup");
  const router = useRouter();
  const problem = useProblemMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailure(null);
          void liveRequest("/labour/setup/defaults", labourSetupResponseSchema, { method: "POST" })
            .then(() => router.refresh())
            .catch((error: unknown) => setFailure(problem(error)))
            .finally(() => setBusy(false));
        }}
      >
        {t("installDefaults")}
      </Button>
      {failure ? (
        <span role="alert" className="text-sm text-destructive">
          {failure}
        </span>
      ) : null}
    </span>
  );
}

type Entry = { kind: "trade"; value: Trade | null } | { kind: "skill"; value: SkillLevel | null };

/** Add or edit a trade or skill level (config.manage). Keys are fixed once created. */
export function ConfigEntryButton(props: Entry) {
  const t = useTranslations("labourLive.setup");
  const tNca = useTranslations("labourLive.setup.ncaCategories");
  const router = useRouter();
  const existing = props.value;
  const skill = props.kind === "skill" ? props.value : null;
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(existing?.key ?? "");
  const [nameEn, setNameEn] = useState(existing?.nameEn ?? "");
  const [nameSw, setNameSw] = useState(existing?.nameSw ?? "");
  const [active, setActive] = useState(existing?.active ?? true);
  const [ncaCategory, setNcaCategory] = useState(skill?.ncaCategory ?? "skilled");
  const [expected, setExpected] = useState(skill?.accreditationExpected ?? false);
  const noun = props.kind === "trade" ? t("trade") : t("skillLevel");
  const path = props.kind === "trade" ? "/labour/trades" : "/labour/skill-levels";

  async function save() {
    const names = { nameEn: nameEn.trim(), nameSw: nameSw.trim() };
    const skillFields =
      props.kind === "skill" ? { ncaCategory, accreditationExpected: expected } : {};
    const target = existing ? `${path}/${existing.id}` : path;
    const init = existing
      ? {
          method: "PATCH" as const,
          body: { ...names, ...skillFields, active, version: existing.version },
        }
      : { method: "POST" as const, body: { key: key.trim(), ...names, ...skillFields } };
    if (props.kind === "trade") await liveRequest(target, tradeResponseSchema, init);
    else await liveRequest(target, skillLevelResponseSchema, init);
    router.refresh();
  }

  const id = `${props.kind}-${existing?.id ?? "new"}`;
  return (
    <>
      {existing ? (
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          {t("edit")}
          <span className="sr-only">: {existing.nameEn}</span>
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus aria-hidden /> {t("add", { what: noun })}
        </Button>
      )}
      <ActionDialog
        id={`${id}-form`}
        open={open}
        onOpenChange={setOpen}
        title={existing ? t("editTitle", { what: noun }) : t("add", { what: noun })}
        description={t("entryHint")}
        submitLabel={t("save")}
        submitDisabled={
          !nameEn.trim() || !nameSw.trim() || (!existing && !/^[a-z][a-z0-9_]{1,39}$/.test(key))
        }
        onSubmit={save}
      >
        {!existing ? (
          <Field>
            <FieldLabel htmlFor={`${id}-key`}>{t("key")}</FieldLabel>
            <Input
              id={`${id}-key`}
              value={key}
              onChange={(event) => setKey(event.target.value.toLowerCase())}
              maxLength={40}
              required
              aria-describedby={`${id}-key-hint`}
            />
            <FieldDescription id={`${id}-key-hint`}>{t("keyHint")}</FieldDescription>
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${id}-en`}>{t("nameEn")}</FieldLabel>
          <Input
            id={`${id}-en`}
            lang="en"
            value={nameEn}
            onChange={(event) => setNameEn(event.target.value)}
            maxLength={80}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-sw`}>{t("nameSw")}</FieldLabel>
          <Input
            id={`${id}-sw`}
            lang="sw"
            value={nameSw}
            onChange={(event) => setNameSw(event.target.value)}
            maxLength={80}
            required
          />
        </Field>
        {props.kind === "skill" ? (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-nca`}>{t("ncaCategory")}</FieldLabel>
              <select
                id={`${id}-nca`}
                className={selectClass}
                value={ncaCategory}
                onChange={(event) => setNcaCategory(event.target.value as typeof ncaCategory)}
              >
                {NCA_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {tNca(value)}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={expected}
                onChange={(event) => setExpected(event.target.checked)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>{t("accreditationExpected")}</span>
            </label>
          </>
        ) : null}
        {existing ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              {t("active")}
              <span className="block text-xs text-muted-foreground">{t("activeHint")}</span>
            </span>
          </label>
        ) : null}
      </ActionDialog>
    </>
  );
}

export function AlertDaysForm({ settings }: { settings: LabourSetupResponse["settings"] }) {
  const t = useTranslations("labourLive.setup");
  const router = useRouter();
  const problem = useProblemMessage();
  const [days, setDays] = useState(String(settings.accreditationAlertDays));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const value = Number(days);
  const valid =
    Number.isInteger(value) &&
    value >= ACCREDITATION_ALERT_DAYS_LIMITS.min &&
    value <= ACCREDITATION_ALERT_DAYS_LIMITS.max;
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setMessage(null);
        void liveRequest("/labour/settings", labourSetupResponseSchema, {
          method: "PUT",
          body: { accreditationAlertDays: value, version: settings.version },
        })
          .then(() => {
            setMessage({ ok: true, text: t("saved") });
            router.refresh();
          })
          .catch((error: unknown) => setMessage({ ok: false, text: problem(error) }))
          .finally(() => setBusy(false));
      }}
    >
      <Field className="w-40">
        <FieldLabel htmlFor="alert-days">{t("alertDays")}</FieldLabel>
        <Input
          id="alert-days"
          value={days}
          onChange={(event) => setDays(event.target.value)}
          inputMode="numeric"
          aria-invalid={valid ? undefined : true}
          aria-describedby="alert-days-hint"
        />
      </Field>
      <Button type="submit" variant="secondary" disabled={busy || !valid}>
        {t("save")}
      </Button>
      <p id="alert-days-hint" className="w-full text-xs text-muted-foreground">
        {t("alertDaysHint", {
          min: ACCREDITATION_ALERT_DAYS_LIMITS.min,
          max: ACCREDITATION_ALERT_DAYS_LIMITS.max,
        })}
      </p>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm text-success" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}

/** A new effective-dated rate (never an edit of an existing one). */
export function AddRateButton({
  setup,
  projectId,
}: {
  setup: LabourSetupResponse;
  projectId: string | null;
}) {
  const t = useTranslations("labourLive.setup.rates");
  const tBasis = useTranslations("labourLive.panel.rateBases");
  const locale = useLocale();
  const router = useRouter();
  const trades = setup.trades.filter((trade) => trade.active);
  const levels = setup.skillLevels.filter((level) => level.active);
  const [open, setOpen] = useState(false);
  const [tradeId, setTradeId] = useState(trades[0]?.id ?? "");
  const [skillLevelId, setSkillLevelId] = useState("");
  const [basis, setBasis] = useState<(typeof RATE_BASES)[number]>("daily");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(calendarInput(nairobiDate()));
  const rateMinor = parseShillings(amount);
  const effectiveFrom = parseCalendarInput(from);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={!trades.length}>
        <Plus aria-hidden /> {t("add")}
      </Button>
      <ActionDialog
        id="add-rate-form"
        open={open}
        onOpenChange={setOpen}
        title={t("add")}
        description={projectId ? t("projectHint") : t("companyHint")}
        submitLabel={t("save")}
        submitDisabled={!tradeId || !rateMinor || !effectiveFrom}
        onSubmit={async () => {
          await liveRequest("/labour/rates", labourRateResponseSchema, {
            method: "POST",
            body: {
              projectId,
              tradeId,
              skillLevelId: skillLevelId || null,
              basis,
              rateMinor,
              effectiveFrom,
            },
          });
          router.refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor="rate-trade">{t("trade")}</FieldLabel>
          <select
            id="rate-trade"
            className={selectClass}
            value={tradeId}
            onChange={(event) => setTradeId(event.target.value)}
          >
            {trades.map((trade) => (
              <option key={trade.id} value={trade.id}>
                {localName(trade, locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="rate-skill">{t("skillLevel")}</FieldLabel>
          <select
            id="rate-skill"
            className={selectClass}
            value={skillLevelId}
            onChange={(event) => setSkillLevelId(event.target.value)}
          >
            <option value="">{t("anySkill")}</option>
            {levels.map((level) => (
              <option key={level.id} value={level.id}>
                {localName(level, locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="rate-basis">{t("basis")}</FieldLabel>
          <select
            id="rate-basis"
            className={selectClass}
            value={basis}
            onChange={(event) => setBasis(event.target.value as typeof basis)}
          >
            {RATE_BASES.map((value) => (
              <option key={value} value={value}>
                {tBasis(value)}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="rate-amount">{t("amount")}</FieldLabel>
          <Input
            id="rate-amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            required
            aria-describedby="rate-amount-hint"
          />
          <FieldDescription id="rate-amount-hint">{t("amountHint")}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="rate-from">{t("effectiveFrom")}</FieldLabel>
          <Input
            id="rate-from"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            inputMode="numeric"
            aria-describedby="rate-from-hint"
          />
          <FieldDescription id="rate-from-hint">{t("effectiveFromHint")}</FieldDescription>
        </Field>
      </ActionDialog>
    </>
  );
}

export function CancelRateButton({ rateId, label }: { rateId: string; label: string }) {
  const t = useTranslations("labourLive.setup.rates");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {t("cancel")}
        <span className="sr-only">: {label}</span>
      </Button>
      <ActionDialog
        id={`cancel-rate-${rateId}`}
        open={open}
        onOpenChange={setOpen}
        title={t("cancelTitle")}
        description={t("cancelHint")}
        submitLabel={t("cancel")}
        destructive
        onSubmit={async () => {
          await liveRequest(`/labour/rates/${rateId}`, messageResponseSchema, { method: "DELETE" });
          router.refresh();
        }}
      >
        <p className="text-sm">{label}</p>
      </ActionDialog>
    </>
  );
}
