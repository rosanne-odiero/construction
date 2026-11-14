"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { PlantItem } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { alertTone, plantStatusTone, serviceTone } from "@/lib/plant";

/** What needs attention on an item (fuel alerts are estimates, never proof of theft). */
export function AlertBadges({ item }: { item: Pick<PlantItem, "alerts"> }) {
  const t = useTranslations("plant");
  if (!item.alerts.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t("register.alertsLabel")}>
      {item.alerts.map((alert) => (
        <li key={alert.kind}>
          <StatusBadge
            tone={alertTone[alert.severity]}
            className="h-auto whitespace-normal text-left"
          >
            {t(`alertKind.${alert.kind}`)}
          </StatusBadge>
        </li>
      ))}
    </ul>
  );
}

/** One item in a list: code, name, where it is, its state, meter, service and hire. */
export function PlantCard({ item, extra }: { item: PlantItem; extra?: React.ReactNode }) {
  const t = useTranslations("plant");
  const unit = item.meterType === "km" ? "km" : "h";
  return (
    <article aria-label={`${item.code} ${item.name}`} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <Link
            href={`/plant/${item.id}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            <span className="mr-2 font-mono text-sm">{item.code}</span>
            {item.name}
          </Link>
          <p className="text-sm text-muted-foreground">
            {t(`category.${item.category}`)}
            {item.quantity > 1
              ? ` · ${t("register.quantity", { count: item.quantity })}`
              : ""} · {t(`ownership.${item.ownership}`)}
          </p>
        </div>
        <StatusBadge tone={plantStatusTone[item.status]}>{t(`status.${item.status}`)}</StatusBadge>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex flex-wrap gap-1">
          <dt className="text-muted-foreground">{t("register.where")}:</dt>
          <dd>
            {item.locationRestricted
              ? t("register.restricted")
              : item.location
                ? `${item.location.projectCode} · ${item.location.siteName}`
                : t("yard")}
          </dd>
        </div>
        {item.meter.reading ? (
          <div className="flex flex-wrap gap-1">
            <dt className="text-muted-foreground">{t("register.meter")}:</dt>
            <dd>
              {item.meter.reading} {unit}
            </dd>
          </div>
        ) : null}
        {item.service.state !== "not_scheduled" ? (
          <div className="flex flex-wrap items-center gap-1">
            <dt className="text-muted-foreground">{t("register.service")}:</dt>
            <dd>
              <StatusBadge tone={serviceTone[item.service.state]}>
                {t(`serviceState.${item.service.state}`)}
              </StatusBadge>
            </dd>
          </div>
        ) : null}
        {item.hire ? (
          <div className="flex flex-wrap gap-1 sm:col-span-2">
            <dt className="text-muted-foreground">{t("register.hire")}:</dt>
            <dd>
              {t("register.hireLine", {
                supplier: item.hire.supplier.name,
                days: item.hire.daysOnHire,
                idle: item.hire.idleDays,
              })}
              {item.hire.endOn
                ? ` · ${t("register.hireEnds", { date: formatCalendarDate(item.hire.endOn) })}`
                : ""}
              {item.hire.estimateMinor !== null
                ? ` · ${t("register.estimate", { amount: formatKES(item.hire.estimateMinor) })}`
                : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      <AlertBadges item={item} />
      {extra}
    </article>
  );
}
