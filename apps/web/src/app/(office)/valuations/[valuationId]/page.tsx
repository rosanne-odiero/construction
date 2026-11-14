import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { measurementItemsResponseSchema, valuationResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { ValuationAction } from "@/components/valuations/valuation-action";
import { DraftEditor } from "@/components/valuations/valuation-forms";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { formatCalendarDate, formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { itemLabel, valuationStatusTone } from "@/lib/valuations";

export async function generateMetadata() {
  const t = await getTranslations("valuations.valuation");
  return { title: t("metaTitle") };
}

/**
 * A valuation and its payment certificate (D6.3): the certificate breakdown (work done,
 * materials on site, retention, adjustments, previous certificates, amount due, VAT), the lines,
 * the draft inputs and the workflow: submit (bq.edit), certify with step-up on the digest seen
 * (finance.manage, never a contributor), return or cancel. PDF and Excel on demand.
 */
export default async function ValuationPage({
  params,
}: {
  params: Promise<{ valuationId: string }>;
}) {
  const { valuationId } = await params;
  if (!isUuid(valuationId)) notFound();
  const path = `/valuations/${valuationId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(`/valuations/${valuationId}`, valuationResponseSchema, path);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("valuations.valuation");
  const tStatus = await getTranslations("valuations.status");
  const tKinds = await getTranslations("valuations.kinds");
  const tStages = await getTranslations("valuations.stages");
  const tAdjust = await getTranslations("valuations.adjustmentKinds");
  const tWarn = await getTranslations("valuations.warnings");
  const tSource = await getTranslations("valuations.sources");
  const v = result.data.valuation;
  const { figures, terms } = v;
  const items =
    v.permissions.canEdit && v.kind === "interim"
      ? await serverApi(
          `/projects/${v.project.id}/measurements/items?limit=200`,
          measurementItemsResponseSchema,
        )
      : null;
  const measurable = items?.ok
    ? items.data.items
        .filter((row) => row.basis)
        .map((row) => ({
          lineageId: row.item.lineageId,
          label: `${itemLabel(row.item)} · ${row.item.description.slice(0, 60)}`,
        }))
    : [];
  const cap =
    figures.retentionCapMinor === null
      ? ""
      : t("capSuffix", { amount: formatKES(figures.retentionCapMinor) });
  const summary: { label: string; amount: number; strong?: boolean }[] = [
    { label: t("summary.workDone"), amount: figures.workDoneMinor },
    { label: t("summary.materialsGross"), amount: figures.materialsGrossMinor },
    {
      label: t("summary.materials", { percent: terms.materialsPercent }),
      amount: figures.materialsMinor,
    },
    { label: t("summary.gross"), amount: figures.grossMinor, strong: true },
    {
      label:
        figures.retentionStage === "none"
          ? t("summary.retention", { percent: terms.retentionPercent, cap })
          : t("summary.retentionAfter", { stage: tStages(figures.retentionStage) }),
      amount: -figures.retentionHeldMinor,
    },
    { label: t("summary.adjustments"), amount: figures.adjustmentsToDateMinor },
    { label: t("summary.net"), amount: figures.netToDateMinor, strong: true },
    { label: t("summary.previous"), amount: -figures.previousCertifiedMinor },
    { label: t("summary.amountDue"), amount: figures.amountDueMinor, strong: true },
    { label: t("summary.vat", { rate: terms.vatPercent }), amount: figures.vatMinor },
    { label: t("summary.total"), amount: figures.totalMinor, strong: true },
  ];
  const title = v.certificateNumber
    ? t(v.kind === "interim" ? "titleCertificate" : "titleRelease", { number: v.certificateNumber })
    : t("titleValuation", { number: v.number });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <ValuationsEyebrow
            trail={{
              href: `/valuations/projects/${v.project.id}?tab=certificates`,
              label: t("back"),
            }}
          />
        }
        title={title}
        description={`${v.project.code} · ${v.project.name} · ${formatCalendarDate(v.valuationDate)}`}
        actions={
          <>
            <StatusBadge tone={valuationStatusTone[v.status]}>{tStatus(v.status)}</StatusBadge>
            <StatusBadge tone="neutral">
              {v.kind === "interim" ? tKinds("interim") : tKinds(`release.${v.releaseStage!}`)}
            </StatusBadge>
            {v.permissions.canSubmit ? (
              <ValuationAction
                path={`/valuations/${v.id}/submit`}
                entity="valuation"
                body={{ version: v.version }}
                primary
                text={{
                  button: t("submit"),
                  title: t("submitTitle"),
                  description: t("submitDescription", {
                    amount: formatKES(figures.amountDueMinor),
                  }),
                  confirm: t("submit"),
                }}
              />
            ) : null}
            {v.permissions.canCertify && v.digest ? (
              <ValuationAction
                path={`/valuations/${v.id}/certify`}
                entity="valuation"
                body={{ version: v.version, digest: v.digest }}
                primary
                text={{
                  button: t("certify"),
                  title: t("certifyTitle", { amount: formatKES(figures.amountDueMinor) }),
                  description: t("certifyDescription", { total: formatKES(figures.totalMinor) }),
                  confirm: t("certify"),
                }}
              />
            ) : null}
            {v.permissions.canReturn ? (
              <ValuationAction
                path={`/valuations/${v.id}/return`}
                entity="valuation"
                body={{ version: v.version }}
                reason
                text={{
                  button: t("return"),
                  title: t("returnTitle"),
                  description: t("returnDescription"),
                  confirm: t("return"),
                }}
              />
            ) : null}
            {v.permissions.canCancel ? (
              <ValuationAction
                path={`/valuations/${v.id}/cancel`}
                entity="valuation"
                body={{ version: v.version }}
                reason
                destructive
                text={{
                  button: t("cancel"),
                  title: t("cancelTitle"),
                  description: t("cancelDescription"),
                  confirm: t("cancel"),
                }}
              />
            ) : null}
          </>
        }
      />
      {v.preview ? (
        <p className="rounded-xl border border-info/30 bg-info/10 p-3 text-sm">
          {t("previewNote")}
        </p>
      ) : null}
      {v.status === "submitted" ? (
        <p className="rounded-xl border p-3 text-sm">
          {t("submittedNote", {
            name: v.submittedBy?.displayName ?? "—",
            when: v.submittedAt ? formatDateTime(v.submittedAt) : "—",
          })}
        </p>
      ) : null}
      {v.status === "certified" && v.certifiedBy && v.certifiedAt ? (
        <p className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm">
          {t("certifiedNote", {
            name: v.certifiedBy.displayName,
            when: formatDateTime(v.certifiedAt),
          })}
        </p>
      ) : null}
      {v.returnReason && v.status === "draft" ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("returned", { reason: v.returnReason })}
        </p>
      ) : null}
      {v.cancelReason ? (
        <p className="text-sm">{t("cancelled", { reason: v.cancelReason })}</p>
      ) : null}
      {v.warnings.length ? (
        <ul className="space-y-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {v.warnings.map((warning) => (
            <li key={warning.code}>{tWarn(warning.code, { count: warning.count })}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(["en", "sw"] as const).map((locale) => (
          <Button key={locale} asChild size="sm" variant="outline">
            <a href={`/api/v1/valuations/${v.id}/export/pdf?locale=${locale}`} download>
              <Download aria-hidden /> {t(`downloadPdf.${locale}`)}
            </a>
          </Button>
        ))}
        <Button asChild size="sm" variant="outline">
          <a href={`/api/v1/valuations/${v.id}/export/xlsx`} download>
            <Download aria-hidden /> {t("downloadExcel")}
          </a>
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("summaryTitle")}</h2>
          <ScrollTable label={t("summaryTitle")} minWidth={320}>
            <tbody>
              {summary.map((row) => (
                <tr key={row.label} className="border-b last:border-0">
                  <th
                    scope="row"
                    className={`py-2 pl-4 text-left ${row.strong ? "font-semibold" : "font-normal"}`}
                  >
                    {row.label}
                  </th>
                  <td
                    className={`py-2 pr-4 text-right whitespace-nowrap tabular-nums ${row.strong ? "font-semibold" : ""}`}
                  >
                    {formatKES(row.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          <p className="text-xs text-muted-foreground">{t("netNote")}</p>
        </section>
        <section
          aria-labelledby="certificate-terms"
          className="space-y-2 rounded-xl border p-4 text-sm"
        >
          <h2 id="certificate-terms" className="font-semibold">
            {t("termsTitle")}
          </h2>
          {v.contractSum ? (
            <dl className="space-y-1">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">{t("originalSum")}</dt>
                <dd className="tabular-nums">{formatKES(v.contractSum.originalMinor)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">
                  {t("revisedSum", { version: v.contractSum.revisedVersionNo })}
                </dt>
                <dd className="tabular-nums">{formatKES(v.contractSum.revisedMinor)}</dd>
              </div>
            </dl>
          ) : null}
          <p>
            {t("terms", {
              retention: terms.retentionPercent,
              cap: terms.retentionCapPercent ?? "—",
              vat: terms.vatPercent,
              materials: terms.materialsPercent,
              release: terms.practicalReleasePercent,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("rule", { rule: terms.ruleVersion, version: terms.settingsVersion })}
          </p>
          {v.digest ? (
            <p className="text-xs break-all text-muted-foreground">
              {t("digest", { digest: v.digest.slice(0, 16) })}
            </p>
          ) : null}
        </section>
      </div>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("itemsTitle")}</h2>
        {v.lines.items.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noItems")}</p>
        ) : (
          <ScrollTable label={t("itemsTitle")} minWidth={880}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.item")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.toDate")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.rate")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.previous")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.thisPeriod")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.valueToDate")}
                </th>
              </tr>
            </thead>
            <tbody>
              {v.lines.items.map((line) => (
                <tr key={line.lineNo} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-normal">
                    <span className="font-medium">{itemLabel(line.bqItem)}</span>
                    <span className="block max-w-sm text-xs text-muted-foreground">
                      {line.bqItem.description}
                    </span>
                    {line.overMeasured ? (
                      <StatusBadge tone="warning" className="mt-1">
                        {t("overMeasured")}
                      </StatusBadge>
                    ) : null}
                    {line.measurementId ? (
                      <Link
                        href={`/valuations/projects/${v.project.id}/measurements/${line.measurementId}`}
                        className="mt-1 block text-xs underline underline-offset-4"
                      >
                        {t("measuredOn", { date: formatCalendarDate(line.measuredOn!) })}
                      </Link>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {line.quantityToDate === null
                      ? "—"
                      : line.basis === "percent"
                        ? `${formatDecimalString(line.quantityToDate)}%`
                        : `${formatDecimalString(line.quantityToDate)} ${line.bqItem.unit ?? ""}`}
                    {line.percentComplete ? (
                      <span className="block text-xs text-muted-foreground">
                        {line.percentComplete}%
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {line.rate ? formatDecimalString(line.rate) : "—"}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(line.previousMinor)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(line.thisPeriodMinor)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatKES(line.toDateMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>
      {v.lines.materials.length || v.inputs.materials.length ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("materialsTitle")}</h2>
          <ScrollTable label={t("materialsTitle")} minWidth={640}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.description")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.source")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.quantity")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.atCost")}
                </th>
              </tr>
            </thead>
            <tbody>
              {v.lines.materials.map((line) => (
                <tr key={line.lineNo} className="border-b last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-normal">
                    {line.description}
                    {line.bqItem ? (
                      <span className="block text-xs text-muted-foreground">
                        {itemLabel(line.bqItem)}
                      </span>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2">
                    {tSource(line.source)}
                    {line.store ? (
                      <span className="block text-xs text-muted-foreground">{line.store.name}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {line.quantity === null
                      ? "—"
                      : `${formatDecimalString(line.quantity)} ${line.unit ?? ""}`}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatKES(line.amountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          {v.permissions.canEdit && v.inputs.materials.length ? (
            <ul className="flex flex-wrap gap-2">
              {v.inputs.materials.map((input) => (
                <li key={input.id}>
                  <ValuationAction
                    path={`/valuations/${v.id}/materials/${input.id}?version=${v.version}`}
                    entity="valuation"
                    method="DELETE"
                    destructive
                    text={{
                      button: t("removeMaterial", { name: input.description }),
                      title: t("removeTitle"),
                      description: input.description,
                      confirm: t("remove"),
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {v.lines.adjustments.length || v.inputs.adjustments.length ? (
        <section aria-labelledby="certificate-adjustments" className="space-y-2">
          <h2 id="certificate-adjustments" className="text-lg font-semibold">
            {t("adjustmentsTitle")}
          </h2>
          <ul className="space-y-1 rounded-xl border p-3 text-sm">
            {v.lines.adjustments.map((line) => (
              <li key={line.lineNo} className="flex flex-wrap justify-between gap-2">
                <span>
                  {tAdjust(line.kind)}: {line.description}
                </span>
                <span className="tabular-nums">{formatKES(line.amountMinor)}</span>
              </li>
            ))}
          </ul>
          {v.permissions.canEdit && v.inputs.adjustments.length ? (
            <ul className="flex flex-wrap gap-2">
              {v.inputs.adjustments.map((input) => (
                <li key={input.id}>
                  <ValuationAction
                    path={`/valuations/${v.id}/adjustments/${input.id}?version=${v.version}`}
                    entity="valuation"
                    method="DELETE"
                    destructive
                    text={{
                      button: t("removeAdjustment", { name: input.description }),
                      title: t("removeTitle"),
                      description: input.description,
                      confirm: t("remove"),
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {v.permissions.canEdit ? (
        <DraftEditor
          valuationId={v.id}
          version={v.version}
          interim={v.kind === "interim"}
          valuationDate={v.valuationDate}
          notes={v.notes}
          materialsFromStores={v.materialsFromStores}
          items={measurable}
        />
      ) : null}
    </div>
  );
}
