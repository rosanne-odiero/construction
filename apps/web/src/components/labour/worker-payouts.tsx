"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Smartphone } from "lucide-react";
import * as wire from "@pm-buddy/validation";
import {
  CommandDialog,
  ReasonField,
  useCommandKey,
  validReason,
} from "@/components/payroll/command-dialog";
import { usePayoutProblem } from "@/components/payroll/payout-problem";
import { useStepUp } from "@/components/projects/step-up";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { payrollCommand } from "@/lib/payroll";
import { verificationTone } from "@/lib/payouts";

/**
 * The payout side of a worker record (D4.3 §5): the M-Pesa number's in-person verification by a
 * second person, the change hold after a number change and the owner's override, payout holds
 * (name mismatch or manual) with release, and cents carried to the next payroll.
 */
export function WorkerPayouts({ status }: { status: wire.LabourerPayoutStatusResponse }) {
  const t = useTranslations("payouts.worker");
  const tv = useTranslations("payouts.values");
  const router = useRouter();
  const stepUp = useStepUp();
  const verifyProblem = usePayoutProblem("verify");
  const problem = usePayoutProblem();
  const verifyKey = useCommandKey();
  const overrideKey = useCommandKey();
  const holdKey = useCommandKey();
  const [idChecked, setIdChecked] = useState(false);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const { labourer, permissions, changeHold } = status;
  const base = `/labour/labourers/${labourer.id}`;
  const current = status.verifications.find((verification) => verification.current) ?? null;
  const activeHolds = status.holds.filter((hold) => hold.state === "active");
  const done = () => router.refresh();
  return (
    <section aria-labelledby="panel-payouts" className="space-y-3">
      <h3 id="panel-payouts" className="flex items-center gap-2 font-semibold">
        <Smartphone className="size-4" aria-hidden /> {t("title")}
      </h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">{t("number")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{labourer.phoneMasked ?? t("noNumber")}</span>
          <StatusBadge tone={verificationTone[status.verificationState]}>
            {tv(`verification.${status.verificationState}`)}
          </StatusBadge>
        </dd>
        <dt className="text-muted-foreground">{t("smsLanguage")}</dt>
        <dd>{t(`languages.${labourer.preferredLanguage}`)}</dd>
        <dt className="text-muted-foreground">{t("openObligations")}</dt>
        <dd>
          {t("outstanding", {
            count: status.openObligations,
            amount: formatKES(status.outstandingMinor),
          })}
        </dd>
      </dl>

      {current ? (
        <p className="rounded-lg border border-success/30 bg-success/5 p-2">
          {t("verifiedBy", {
            name: current.verifiedBy.displayName,
            date: formatDateTime(current.verifiedAt),
          })}
          {current.note ? <span className="block text-xs">{current.note}</span> : null}
        </p>
      ) : status.verificationState === "unverified" ? (
        <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-2">
          {t("unverifiedNote")}
        </p>
      ) : null}

      {permissions.canVerify && status.verificationState === "unverified" ? (
        <CommandDialog
          label={t("verify")}
          size="sm"
          variant="default"
          title={t("verifyTitle", { name: labourer.fullName })}
          description={t("verifyHint", { phone: labourer.phoneMasked ?? "—" })}
          submitLabel={t("verifySubmit")}
          submitDisabled={!idChecked}
          problem={verifyProblem}
          onOpen={() => {
            verifyKey.renew();
            setIdChecked(false);
            setNote("");
          }}
          onSubmit={async () => {
            await stepUp.run(() =>
              payrollCommand(
                `${base}/payout-verifications`,
                wire.labourerPayoutStatusResponseSchema,
                {
                  version: labourer.version,
                  method: "in_person_id_check",
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
                "POST",
                verifyKey.value(),
              ),
            );
            done();
          }}
        >
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={idChecked}
              onChange={(event) => {
                verifyKey.renew();
                setIdChecked(event.target.checked);
              }}
            />
            {t("idChecked", { name: labourer.fullName })}
          </label>
          <ReasonField
            optional
            value={note}
            onChange={(value) => {
              verifyKey.renew();
              setNote(value);
            }}
          />
        </CommandDialog>
      ) : null}

      {status.blockReasons.length ? (
        <div className="space-y-1">
          <p className="font-medium">{t("blocked")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {status.blockReasons.map((reason) => (
              <li key={reason}>
                <StatusBadge tone="warning">{tv(`blockReasons.${reason}`)}</StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {changeHold ? (
        <div className="space-y-1 rounded-lg border p-2">
          <p className="font-medium">{t("changeHold")}</p>
          <p>
            {t("changedOn", {
              date: formatDateTime(changeHold.changedAt),
              name: changeHold.changedBy?.displayName ?? t("unknownPerson"),
            })}
          </p>
          <p>
            {changeHold.active
              ? t("holdUntil", { date: formatDateTime(changeHold.until) })
              : t("holdEnded", { date: formatDateTime(changeHold.until) })}
          </p>
          {changeHold.override ? (
            <p>
              {t("overridden", {
                name: changeHold.override.by.displayName,
                date: formatDateTime(changeHold.override.at),
              })}
              <span className="block text-xs">{changeHold.override.reason}</span>
            </p>
          ) : null}
          {permissions.canOverrideChangeHold && changeHold.active && !changeHold.override ? (
            <CommandDialog
              label={t("override")}
              size="sm"
              title={t("overrideTitle")}
              description={t("overrideHint")}
              submitLabel={t("override")}
              submitDisabled={!validReason(reason)}
              problem={problem}
              onOpen={() => {
                overrideKey.renew();
                setReason("");
              }}
              onSubmit={async () => {
                await stepUp.run(() =>
                  payrollCommand(
                    `${base}/change-hold-override`,
                    wire.labourerPayoutStatusResponseSchema,
                    { version: labourer.version, reason: reason.trim() },
                    "POST",
                    overrideKey.value(),
                  ),
                );
                done();
              }}
            >
              <ReasonField
                value={reason}
                onChange={(value) => {
                  overrideKey.renew();
                  setReason(value);
                }}
              />
            </CommandDialog>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{t("holds", { count: activeHolds.length })}</p>
          {permissions.canPlaceHold ? (
            <CommandDialog
              label={t("placeHold")}
              size="sm"
              title={t("placeHoldTitle")}
              description={t("placeHoldHint")}
              submitLabel={t("placeHold")}
              submitDisabled={!validReason(reason)}
              problem={problem}
              onOpen={() => {
                holdKey.renew();
                setReason("");
              }}
              onSubmit={async () => {
                await payrollCommand(
                  `${base}/payout-holds`,
                  wire.labourerPayoutStatusResponseSchema,
                  { reason: reason.trim() },
                  "POST",
                  holdKey.value(),
                );
                done();
              }}
            >
              <ReasonField
                value={reason}
                onChange={(value) => {
                  holdKey.renew();
                  setReason(value);
                }}
              />
            </CommandDialog>
          ) : null}
        </div>
        {status.holds.length ? (
          <ul className="space-y-2">
            {status.holds.map((hold) => (
              <li key={hold.id}>
                <HoldCard
                  hold={hold}
                  canRelease={permissions.canReleaseHolds}
                  stepUp={stepUp.run}
                  onDone={done}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t("noHolds")}</p>
        )}
      </div>

      <div className="space-y-1">
        <p className="font-medium">
          {t("carryForwards", { amount: formatKES(status.openCarryForwardMinor) })}
        </p>
        <p className="text-xs text-muted-foreground">{t("carryHint")}</p>
        {status.carryForwards.length ? (
          <ul className="space-y-1">
            {status.carryForwards.map((carry) => (
              <li key={carry.id}>
                <Link className="underline" href={`/payroll/batches/${carry.source.batchId}`}>
                  {formatKES(carry.amountMinor)} ·{" "}
                  {formatCalendarDate(carry.source.periodStart)} –{" "}
                  {formatCalendarDate(carry.source.periodEnd)}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {status.verifications.length > (current ? 1 : 0) ? (
        <details className="text-xs">
          <summary className="cursor-pointer">{t("history")}</summary>
          <ul className="mt-1 space-y-1">
            {status.verifications
              .filter((verification) => !verification.current)
              .map((verification) => (
                <li key={verification.id}>
                  {t("earlierVerification", {
                    phone: verification.phoneMasked ?? "—",
                    name: verification.verifiedBy.displayName,
                    date: formatDateTime(verification.verifiedAt),
                  })}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {stepUp.dialog}
    </section>
  );
}

function HoldCard({
  hold,
  canRelease,
  stepUp,
  onDone,
}: {
  hold: wire.PayoutHold;
  canRelease: boolean;
  stepUp: <T>(operation: () => Promise<T>) => Promise<T>;
  onDone: () => void;
}) {
  const t = useTranslations("payouts.worker");
  const tv = useTranslations("payouts.values");
  const problem = usePayoutProblem();
  const key = useCommandKey();
  const [reason, setReason] = useState("");
  return (
    <article className="min-w-0 space-y-1 break-words rounded-lg border p-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{tv(`holdKinds.${hold.kind}`)}</span>
        <StatusBadge tone={hold.state === "active" ? "danger" : "neutral"}>
          {tv(`holdStates.${hold.state}`)}
        </StatusBadge>
      </p>
      <p className="text-xs">
        {t("holdPlaced", {
          name: hold.createdBy?.displayName ?? t("system"),
          date: formatDateTime(hold.createdAt),
        })}
        {hold.phoneMasked ? ` · ${hold.phoneMasked}` : ""}
      </p>
      <p>{hold.reason}</p>
      {hold.releasedBy && hold.releasedAt ? (
        <p className="text-xs">
          {t("released", {
            name: hold.releasedBy.displayName,
            date: formatDateTime(hold.releasedAt),
          })}
          {hold.releaseReason ? ` · ${hold.releaseReason}` : ""}
        </p>
      ) : null}
      {canRelease && hold.state === "active" ? (
        <CommandDialog
          label={t("release")}
          size="sm"
          title={t("releaseTitle")}
          description={t("releaseHint")}
          submitLabel={t("release")}
          submitDisabled={!validReason(reason)}
          problem={problem}
          onOpen={() => {
            key.renew();
            setReason("");
          }}
          onSubmit={async () => {
            await stepUp(() =>
              payrollCommand(
                `/labour/payout-holds/${hold.id}/release`,
                wire.labourerPayoutStatusResponseSchema,
                { reason: reason.trim() },
                "POST",
                key.value(),
              ),
            );
            onDone();
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
