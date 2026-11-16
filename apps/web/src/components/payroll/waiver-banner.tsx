"use client";

import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";
import type { WaiverState } from "@pm-buddy/validation";
import { formatDateTime, formatKES } from "@/lib/format";

/**
 * OR-04: while the owner's segregation waiver is on, a batch's reviewer may also approve it (under
 * the lower waiver limit). Shown wherever approvals happen, and on every batch approved under it.
 */
export function WaiverBanner({
  waiver,
  approvedUnderWaiver = false,
}: {
  waiver: WaiverState | null;
  approvedUnderWaiver?: boolean;
}) {
  const t = useTranslations("payouts.waiver");
  if (!waiver?.enabled && !approvedUnderWaiver) return null;
  return (
    <div
      role="note"
      aria-label={t("label")}
      className="space-y-1 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"
    >
      {approvedUnderWaiver ? (
        <p className="flex items-start gap-2 font-semibold">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("approvedUnder")}
        </p>
      ) : null}
      {waiver?.enabled ? (
        <>
          <p className="flex items-start gap-2 font-semibold">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("on")}
          </p>
          <p>{t("onDetail", { limit: formatKES(waiver.limitMinor) })}</p>
          {waiver.reason ? <p>{t("reason", { reason: waiver.reason })}</p> : null}
          {waiver.changedBy && waiver.changedAt ? (
            <p className="text-xs text-muted-foreground">
              {t("changed", {
                name: waiver.changedBy.displayName,
                date: formatDateTime(waiver.changedAt),
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
