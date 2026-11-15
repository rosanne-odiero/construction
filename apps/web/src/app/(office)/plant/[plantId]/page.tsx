import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import {
  plantDetailResponseSchema,
  plantFuelListResponseSchema,
  plantOptionsResponseSchema,
  plantUsageListResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import {
  BreakdownActions,
  OperatorEnd,
  PlantActions,
  ServiceVoid,
} from "@/components/plant/plant-actions";
import { AlertBadges } from "@/components/plant/plant-card";
import { CorrectEntry } from "@/components/plant/site-forms";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Pager } from "@/components/safety/common";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatDateTime, formatKES, formatTime } from "@/lib/format";
import {
  breakdownTone,
  certificateTone,
  plantStatusTone,
  recordTone,
  serviceTone,
  signedPercent,
  windowTone,
} from "@/lib/plant";
import { calendarInput } from "@/lib/project-input";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = Record<string, string | string[] | undefined>;
const cursorOf = (value: string | string[] | undefined) =>
  typeof value === "string" && /^\d{1,6}$/.test(value) ? value : undefined;

export async function generateMetadata({ params }: { params: Promise<{ plantId: string }> }) {
  const { plantId } = await params;
  const t = await getTranslations("plant");
  if (!UUID.test(plantId)) return { title: t("title") };
  const detail = await serverApi(`/plant/${plantId}`, plantDetailResponseSchema);
  return { title: detail.ok ? `${detail.data.item.code} ${detail.data.item.name}` : t("title") };
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A plant item (D8.3): status, hire, service, fuel windows, usage, breakdowns and history. */
export default async function PlantItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ plantId: string }>;
  searchParams: Promise<Params>;
}) {
  const { plantId } = await params;
  if (!UUID.test(plantId)) notFound();
  const query = await searchParams;
  const usageCursor = cursorOf(query["usage"]);
  const fuelCursor = cursorOf(query["fuel"]);
  const path = `/plant/${plantId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, usage, fuel] = await Promise.all([
    loadLive(path, plantDetailResponseSchema, path),
    loadLive(
      `${path}/usage${usageCursor ? `?cursor=${usageCursor}` : ""}`,
      plantUsageListResponseSchema,
      path,
    ),
    loadLive(
      `${path}/fuel${fuelCursor ? `?cursor=${fuelCursor}` : ""}`,
      plantFuelListResponseSchema,
      path,
    ),
  ]);
  if (!detail.ok || !usage.ok || !fuel.ok) {
    const forbidden = [detail, usage, fuel].some((result) => !result.ok && result.status === 403);
    return forbidden ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const data = detail.data;
  const { item, permissions } = data;
  const options =
    permissions.canEdit || permissions.canMove
      ? await serverApi("/plant/options", plantOptionsResponseSchema)
      : null;
  const t = await getTranslations("plant");
  const today = calendarInput(nairobiDate());
  const unit = item.meterType === "km" ? "km" : "h";
  const href = (key: "usage" | "fuel", cursor: number | null) => {
    const next = new URLSearchParams();
    if (key === "usage" && cursor) next.set("usage", String(cursor));
    if (key === "fuel" && cursor) next.set("fuel", String(cursor));
    if (key !== "usage" && usageCursor) next.set("usage", usageCursor);
    if (key !== "fuel" && fuelCursor) next.set("fuel", fuelCursor);
    return `${path}${next.size ? `?${next.toString()}` : ""}#plant-${key}`;
  };

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/plant" className="hover:underline">
              {t("title")}
            </Link>
            <span aria-hidden>/</span>
            <span className="font-mono">{item.code}</span>
          </span>
        }
        title={`${item.code} · ${item.name}`}
        description={`${t(`category.${item.category}`)} · ${t(`ownership.${item.ownership}`)}${
          item.makeModel ? ` · ${item.makeModel}` : ""
        }${item.registration ? ` · ${item.registration}` : ""}`}
        actions={
          <StatusBadge tone={plantStatusTone[item.status]}>
            {t(`status.${item.status}`)}
          </StatusBadge>
        }
      />
      <PlantActions
        detail={data}
        options={options?.ok ? options.data : null}
        today={today}
        now={formatTime(new Date())}
      />
      {item.statusReason ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("closed", {
            date: item.closedOn ? formatCalendarDate(item.closedOn) : "—",
            reason: item.statusReason,
          })}
        </p>
      ) : null}
      <AlertBadges item={item} />

      <Section id="plant-overview" title={t("detail.overview")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("register.where")}</dt>
            <dd>
              {item.locationRestricted
                ? t("register.restricted")
                : item.location
                  ? `${item.location.projectCode} · ${item.location.projectName} · ${item.location.siteName}`
                  : t("yard")}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("register.meter")}</dt>
            <dd>
              {item.meter.reading
                ? `${item.meter.reading} ${unit}${item.meter.readAt ? ` (${formatDateTime(item.meter.readAt)})` : ""}`
                : t(`meterType.${item.meterType}`)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("detail.standard")}</dt>
            <dd>
              {item.standardConsumption
                ? t(item.meterType === "km" ? "detail.perKm" : "detail.perHour", {
                    litres: item.standardConsumption,
                  })
                : t(`fuelType.${item.fuelType}`)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("register.service")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={serviceTone[item.service.state]}>
                {t(`serviceState.${item.service.state}`)}
              </StatusBadge>
              {item.service.remaining
                ? t("detail.remaining", { remaining: item.service.remaining, unit })
                : null}
              {item.service.dueOn
                ? t("detail.dueOn", { date: formatCalendarDate(item.service.dueOn) })
                : null}
            </dd>
          </div>
          {item.hire ? (
            <>
              <div>
                <dt className="text-muted-foreground">{t("form.supplier")}</dt>
                <dd>
                  {item.hire.supplier.name}
                  {item.lpo ? ` · ${item.lpo.number}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("detail.hirePeriod")}</dt>
                <dd>
                  {formatCalendarDate(item.hire.startOn)} –{" "}
                  {item.hire.endOn ? formatCalendarDate(item.hire.endOn) : t("detail.openEnded")}
                  {" · "}
                  {t("detail.hireDays", { days: item.hire.daysOnHire, idle: item.hire.idleDays })}
                </dd>
              </div>
              {item.hire.rateMinor !== null ? (
                <div>
                  <dt className="text-muted-foreground">{t("form.rate")}</dt>
                  <dd>
                    {formatKES(item.hire.rateMinor)} / {t(`rateUnit.${item.hire.rateUnit}`)}
                  </dd>
                </div>
              ) : null}
              {item.hire.estimateMinor !== null ? (
                <div>
                  <dt className="text-muted-foreground">{t("detail.estimate")}</dt>
                  <dd>
                    {formatKES(item.hire.estimateMinor)}{" "}
                    <span className="text-muted-foreground">{t("detail.estimateNote")}</span>
                  </dd>
                </div>
              ) : null}
            </>
          ) : null}
          {item.notes ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">{t("form.notes")}</dt>
              <dd className="whitespace-pre-wrap">{item.notes}</dd>
            </div>
          ) : null}
        </dl>
      </Section>

      <Section id="plant-fuel" title={t("detail.fuel")}>
        <p className="text-sm text-muted-foreground">
          {t("fuel.rules", {
            tolerance: fuel.data.rules.tolerancePercent,
            sample: fuel.data.rules.minSample,
            unit,
          })}{" "}
          {t("fuel.estimateNote")}
        </p>
        {fuel.data.windows.length ? (
          <div
            role="region"
            aria-label={t("fuel.windowsLabel")}
            tabIndex={0}
            className="overflow-x-auto rounded-md border"
          >
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="p-2 font-medium">{t("fuel.window")}</th>
                  <th className="p-2 font-medium">{t("fuel.litres")}</th>
                  <th className="p-2 font-medium">{t("fuel.advance", { unit })}</th>
                  <th className="p-2 font-medium">{t("fuel.expected")}</th>
                  <th className="p-2 font-medium">{t("fuel.rate")}</th>
                  <th className="p-2 font-medium">{t("fuel.variance")}</th>
                  <th className="p-2 font-medium">{t("fuel.state")}</th>
                </tr>
              </thead>
              <tbody>
                {fuel.data.windows.map((window) => (
                  <tr key={window.toId} className="border-t">
                    <td className="p-2">
                      {formatDateTime(window.fromAt)} → {formatDateTime(window.toAt)}
                    </td>
                    <td className="p-2">{window.litres}</td>
                    <td className="p-2">{window.advance}</td>
                    <td className="p-2">{window.expectedLitres ?? "—"}</td>
                    <td className="p-2">{window.actualRate ?? "—"}</td>
                    <td className="p-2">
                      {window.variancePercent ? signedPercent(window.variancePercent) : "—"}
                    </td>
                    <td className="p-2">
                      <StatusBadge tone={windowTone[window.state]}>
                        {t(`windowState.${window.state}`)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm">{t("fuel.noWindows")}</p>
        )}
        {fuel.data.pending.issueCount ? (
          <p className="text-sm">
            {t("fuel.pending", {
              count: fuel.data.pending.issueCount,
              litres: fuel.data.pending.litres,
              advance: fuel.data.pending.advance,
              unit,
            })}
          </p>
        ) : null}
        {fuel.data.entries.length ? (
          <ul className="divide-y rounded-md border" aria-label={t("fuel.issuesLabel")}>
            {fuel.data.entries.map((entry) => (
              <li key={entry.id} className="space-y-2 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDateTime(entry.issuedAt)}</span>
                  <span>
                    {entry.litres} L{entry.meterReading ? ` @ ${entry.meterReading} ${unit}` : ""}
                  </span>
                  <span className="text-muted-foreground">
                    {entry.tankFilled ? t("fuel.full") : t("fuel.partial")} ·{" "}
                    {t(`fuelSource.${entry.source}`)} · {entry.siteName}
                  </span>
                  <StatusBadge tone={recordTone[entry.state]}>
                    {t(`recordState.${entry.state}`)}
                  </StatusBadge>
                  {entry.meterStatic && entry.state === "current" ? (
                    <StatusBadge tone="warning">{t("alertKind.fuel_meter_static")}</StatusBadge>
                  ) : null}
                </p>
                {entry.correctionReason ? (
                  <p className="text-muted-foreground">
                    {t("correct.because", { reason: entry.correctionReason })}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {t("recordedBy", {
                    name: entry.recordedBy.displayName,
                    at: formatDateTime(entry.recordedAt),
                  })}
                </p>
                <CorrectEntry
                  kind="fuel"
                  plantId={item.id}
                  entry={entry}
                  meterType={item.meterType}
                />
              </li>
            ))}
          </ul>
        ) : null}
        <Pager
          label={t("fuel.pages")}
          firstHref={fuelCursor ? href("fuel", null) : null}
          nextHref={fuel.data.nextCursor ? href("fuel", fuel.data.nextCursor) : null}
          offset
        />
      </Section>

      <Section id="plant-usage" title={t("detail.usage")}>
        <p className="text-sm">
          {t("usage.totals", {
            working: usage.data.totals.workingDays30,
            idle: usage.data.totals.idleDays30,
            breakdown: usage.data.totals.breakdownDays30,
          })}
          {usage.data.totals.run30
            ? ` · ${t("usage.run30", { run: usage.data.totals.run30, unit })}`
            : ""}
        </p>
        {usage.data.entries.length ? (
          <ul className="divide-y rounded-md border" aria-label={t("usage.entriesLabel")}>
            {usage.data.entries.map((entry) => (
              <li key={entry.id} className="space-y-2 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatCalendarDate(entry.usedOn)}</span>
                  <span>{t(`dayStatus.${entry.dayStatus}`)}</span>
                  {entry.run ? (
                    <span>
                      {entry.startReading} → {entry.endReading} ({entry.run} {unit})
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">{entry.siteName}</span>
                  <StatusBadge tone={recordTone[entry.state]}>
                    {t(`recordState.${entry.state}`)}
                  </StatusBadge>
                </p>
                {entry.operator || entry.costCode || entry.bqItem ? (
                  <p className="text-muted-foreground">
                    {[
                      entry.operator ? t("usage.operatorIs", { name: entry.operator.name }) : null,
                      entry.costCode ? `${entry.costCode.code} · ${entry.costCode.name}` : null,
                      entry.bqItem
                        ? `${entry.bqItem.ref ?? ""} ${entry.bqItem.description}`.trim()
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : null}
                {entry.correctionReason ? (
                  <p className="text-muted-foreground">
                    {t("correct.because", { reason: entry.correctionReason })}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {t("recordedBy", {
                    name: entry.recordedBy.displayName,
                    at: formatDateTime(entry.recordedAt),
                  })}
                </p>
                <CorrectEntry
                  kind="usage"
                  plantId={item.id}
                  entry={entry}
                  meterType={item.meterType}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("usage.none")}</p>
        )}
        <Pager
          label={t("usage.pages")}
          firstHref={usageCursor ? href("usage", null) : null}
          nextHref={usage.data.nextCursor ? href("usage", usage.data.nextCursor) : null}
          offset
        />
      </Section>

      <Section id="plant-breakdowns" title={t("detail.breakdowns")}>
        {data.breakdowns.length ? (
          <ul className="divide-y rounded-md border">
            {data.breakdowns.map((breakdown) => (
              <li key={breakdown.id} aria-label={breakdown.code} className="space-y-2 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{breakdown.code}</span>
                  <StatusBadge tone={breakdown.severity === "minor" ? "neutral" : "danger"}>
                    {t(`severity.${breakdown.severity}`)}
                  </StatusBadge>
                  <StatusBadge tone={breakdownTone[breakdown.status]}>
                    {t(`breakdownStatus.${breakdown.status}`)}
                  </StatusBadge>
                  <span className="text-muted-foreground">
                    {formatDateTime(breakdown.reportedAt)} · {breakdown.siteName} ·{" "}
                    {t("breakdown.daysDown", { count: breakdown.daysDown })}
                  </span>
                </p>
                <p className="whitespace-pre-wrap">{breakdown.description}</p>
                {breakdown.resolvedOn ? (
                  <p className="text-muted-foreground">
                    {t("breakdown.resolved", {
                      date: formatCalendarDate(breakdown.resolvedOn),
                      name: breakdown.resolvedBy?.displayName ?? "—",
                    })}
                    {breakdown.repairedBy ? ` · ${breakdown.repairedBy}` : ""}
                    {breakdown.costReference ? ` · ${breakdown.costReference}` : ""}
                    {breakdown.resolutionNote ? ` · ${breakdown.resolutionNote}` : ""}
                  </p>
                ) : null}
                <BreakdownActions plantId={item.id} breakdown={breakdown} today={today} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("breakdown.none")}</p>
        )}
      </Section>

      <Section id="plant-maintenance" title={t("detail.maintenance")}>
        {data.services.length ? (
          <ul className="divide-y rounded-md border">
            {data.services.map((service) => (
              <li key={service.id} className="space-y-1 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDateTime(service.servicedAt)}</span>
                  <span>{t(`serviceKind.${service.kind}`)}</span>
                  {service.meterReading ? (
                    <span>
                      {service.meterReading} {unit}
                    </span>
                  ) : null}
                  {service.status === "voided" ? (
                    <StatusBadge tone="neutral">{t("recordState.voided")}</StatusBadge>
                  ) : null}
                </p>
                <p className="whitespace-pre-wrap">{service.description}</p>
                <p className="text-muted-foreground">
                  {[service.doneBy, service.costReference, service.voidReason]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <ServiceVoid plantId={item.id} service={service} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("service.none")}</p>
        )}
        {data.resets.length ? (
          <ul className="space-y-1 text-sm" aria-label={t("reset.listLabel")}>
            {data.resets.map((reset) => (
              <li key={reset.id}>
                {t("reset.line", {
                  at: formatDateTime(reset.resetAt),
                  old: reset.oldReading,
                  new: reset.newReading,
                  reason: t(`resetReason.${reset.reason}`),
                })}{" "}
                <span className="text-muted-foreground">{reset.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section id="plant-operators" title={t("detail.operators")}>
        {data.operators.length ? (
          <ul className="divide-y rounded-md border">
            {data.operators.map((operator) => (
              <li key={operator.id} className="space-y-1 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {operator.labourer
                      ? `${operator.labourer.fullName} (${operator.labourer.workerNo})`
                      : (operator.user?.displayName ?? "—")}
                  </span>
                  <span className="text-muted-foreground">
                    {formatCalendarDate(operator.fromOn)} –{" "}
                    {operator.toOn ? formatCalendarDate(operator.toOn) : t("detail.openEnded")}
                  </span>
                  {operator.active ? (
                    <StatusBadge tone="success">{t("operator.active")}</StatusBadge>
                  ) : null}
                  <StatusBadge tone={certificateTone[operator.certificateState]}>
                    {t(`certificate.${operator.certificateState}`)}
                  </StatusBadge>
                </p>
                {operator.certificateRef ? (
                  <p className="text-muted-foreground">
                    {operator.certificateRef}
                    {operator.certificateExpiresOn
                      ? ` · ${t("operator.expiresOn", { date: formatCalendarDate(operator.certificateExpiresOn) })}`
                      : ""}
                  </p>
                ) : null}
                <OperatorEnd plantId={item.id} operator={operator} today={today} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("operator.none")}</p>
        )}
      </Section>

      <Section id="plant-moves" title={t("detail.moves")}>
        <ol className="space-y-1 text-sm">
          {data.moves.map((move) => (
            <li key={move.id}>
              {move.restricted
                ? t("move.restrictedLine", { date: formatCalendarDate(move.movedOn) })
                : t("move.line", {
                    date: formatCalendarDate(move.movedOn),
                    from: move.from
                      ? `${move.from.projectCode} · ${move.from.siteName}`
                      : t("yard"),
                    to: move.to ? `${move.to.projectCode} · ${move.to.siteName}` : t("yard"),
                  })}{" "}
              <span className="text-muted-foreground">
                {move.movedBy.displayName}
                {move.reason ? ` · ${move.reason}` : ""}
              </span>
            </li>
          ))}
          <li className="text-muted-foreground">
            {t("move.registered", {
              date: formatCalendarDate(item.openingOn),
              name: item.createdBy.displayName,
            })}
          </li>
        </ol>
      </Section>
      <p className="text-xs text-muted-foreground">{t("complianceNote")}</p>
    </div>
  );
}
