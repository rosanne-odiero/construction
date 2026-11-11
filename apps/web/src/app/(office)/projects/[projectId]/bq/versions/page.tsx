import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  bqCompareResponseSchema,
  bqVersionsResponseSchema,
  projectDetailResponseSchema,
  type BqItemDifferenceWire,
} from "@pm-buddy/validation";
import { BqEyebrow, BqSubnav } from "@/components/bq/bq-subnav";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

export async function generateMetadata() {
  const t = await getTranslations("bqVersions");
  return { title: t("title") };
}

/** BQ version history (never edited in place) and an item-by-item comparison of two versions. */
export default async function VersionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const query = await searchParams;
  const path = `/projects/${projectId}/bq/versions`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, result] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(`/projects/${projectId}/bq/versions`, bqVersionsResponseSchema),
  ]);
  for (const response of [detail, result]) {
    if (response.ok) continue;
    if (response.status === 401) redirect(signInHref(path));
    if (response.status === 404) notFound();
    if (response.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!detail.ok || !result.ok) return <LiveUnavailable retryHref={path} />;
  const { project } = detail.data;
  const { versions } = result.data;
  const t = await getTranslations("bqVersions");
  const tStatus = await getTranslations("liveBq.status");
  const ids = new Set(versions.map((version) => version.id));
  const to = ids.has(one(query["to"])) ? one(query["to"]) : (versions[0]?.id ?? "");
  const from = ids.has(one(query["from"]))
    ? one(query["from"])
    : (versions.find((version) => version.versionNo === 1)?.id ?? "");
  const compare =
    from && to && from !== to
      ? await serverApi(
          `/projects/${projectId}/bq/versions/compare?from=${from}&to=${to}`,
          bqCompareResponseSchema,
        )
      : null;
  const values = (entry: BqItemDifferenceWire["from"]) =>
    entry
      ? `${entry.quantity === null ? "—" : formatDecimalString(entry.quantity)} × ${
          entry.rate === null ? "—" : formatDecimalString(entry.rate)
        } = ${formatKES(entry.amountMinor)}`
      : "—";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BqEyebrow project={project} />}
        title={t("title")}
        description={t("description")}
      />
      <BqSubnav projectId={project.id} current="versions" />
      {versions.length ? (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.version")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.source")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.approved")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t("cols.subtotal")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.grand")}
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    {t("versionNo", { version: version.versionNo })}
                    {version.current ? (
                      <StatusBadge tone="info" className="ml-2">
                        {t("current")}
                      </StatusBadge>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2">
                    {version.variation ? (
                      <Link
                        href={`/projects/${project.id}/bq/variations/${version.variation.id}`}
                        className="underline underline-offset-4"
                      >
                        {t("fromVariation", { number: version.variation.number })}
                      </Link>
                    ) : (
                      t("fromImport")
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {t("createdBy", { name: version.createdBy.displayName })}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={version.status === "draft" ? "warning" : "success"}>
                      {tStatus(version.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-2 text-xs">
                    {version.approvedBy && version.approvedAt
                      ? t("approvedBy", {
                          name: version.approvedBy.displayName,
                          date: formatDateTime(version.approvedAt),
                        })
                      : t("notApproved")}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(version.subtotalMinor)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatKES(version.grandTotalMinor)}
                    <span className="block text-xs text-muted-foreground">
                      {t("vat", { rate: version.vatRatePercent })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      )}

      {versions.length > 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("compare.title")}</h2>
            </CardTitle>
            <CardDescription>{t("compare.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-0">
            <form method="get" className="flex flex-wrap items-end gap-3 px-6">
              {(["from", "to"] as const).map((side) => (
                <div key={side} className="space-y-1">
                  <label htmlFor={`compare-${side}`} className="block text-sm font-medium">
                    {t(`compare.${side}`)}
                  </label>
                  <select
                    id={`compare-${side}`}
                    name={side}
                    defaultValue={side === "from" ? from : to}
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {t("versionNo", { version: version.versionNo })}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <Button type="submit" variant="secondary">
                {t("compare.submit")}
              </Button>
            </form>
            {compare?.ok ? (
              <section aria-label={t("compare.result")} className="space-y-4">
                <dl className="grid gap-2 px-6 text-sm sm:grid-cols-3">
                  {(["subtotalMinor", "vatMinor", "grandTotalMinor"] as const).map((key) => (
                    <div key={key} className="rounded-md border p-3">
                      <dt className="text-xs text-muted-foreground">
                        {t(`compare.totals.${key}`)}
                      </dt>
                      <dd className="tabular-nums">
                        {formatKES(compare.data.totals.from[key])} →{" "}
                        {formatKES(compare.data.totals.to[key])}
                        <span className="block font-semibold">
                          {t("compare.difference", {
                            amount: formatKES(compare.data.totals.difference[key]),
                          })}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <caption className="px-6 pb-2 text-left text-sm font-medium">
                      {t("compare.bills")}
                    </caption>
                    <thead>
                      <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                        <th scope="col" className="py-2 pl-6 font-medium">
                          {t("compare.cols.bill")}
                        </th>
                        <th scope="col" className="py-2 text-right font-medium">
                          {t("compare.cols.from", { version: compare.data.from.versionNo })}
                        </th>
                        <th scope="col" className="py-2 text-right font-medium">
                          {t("compare.cols.to", { version: compare.data.to.versionNo })}
                        </th>
                        <th scope="col" className="py-2 pr-6 text-right font-medium">
                          {t("compare.cols.difference")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {compare.data.bills.map((bill) => (
                        <tr key={bill.lineageId} className="border-b last:border-0">
                          <th scope="row" className="py-2 pl-6 text-left font-normal">
                            {t("compare.bill", { number: bill.number, title: bill.title })}
                          </th>
                          <td className="py-2 text-right tabular-nums">
                            {bill.fromMinor === null ? "—" : formatKES(bill.fromMinor)}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {bill.toMinor === null ? "—" : formatKES(bill.toMinor)}
                          </td>
                          <td className="py-2 pr-6 text-right font-medium tabular-nums">
                            {formatKES(bill.differenceMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(["added", "changed", "removed"] as const).map((group) => (
                  <div key={group} className="relative overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <caption className="px-6 pb-2 text-left text-sm font-medium">
                        {t(`compare.${group}`, { count: compare.data[group].length })}
                      </caption>
                      {compare.data[group].length ? (
                        <>
                          <thead>
                            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                              <th scope="col" className="py-2 pl-6 font-medium">
                                {t("compare.cols.item")}
                              </th>
                              <th scope="col" className="py-2 font-medium">
                                {t("compare.cols.before")}
                              </th>
                              <th scope="col" className="py-2 font-medium">
                                {t("compare.cols.after")}
                              </th>
                              <th scope="col" className="py-2 pr-6 text-right font-medium">
                                {t("compare.cols.difference")}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {compare.data[group].map((entry) => (
                              <tr
                                key={entry.lineageId}
                                className="border-b align-top last:border-0"
                              >
                                <th scope="row" className="py-2 pr-2 pl-6 text-left font-normal">
                                  <span className="text-xs text-muted-foreground">
                                    {t("compare.billShort", { number: entry.billNumber })}
                                    {entry.ref ? ` · ${entry.ref}` : ""}
                                  </span>
                                  <span className="block">{entry.description}</span>
                                  {entry.fields.length ? (
                                    <span className="text-xs text-muted-foreground">
                                      {entry.fields
                                        .map((field) => t(`compare.fields.${field}`))
                                        .join(", ")}
                                    </span>
                                  ) : null}
                                </th>
                                <td className="py-2 pr-2 text-xs tabular-nums">
                                  {values(entry.from)}
                                </td>
                                <td className="py-2 pr-2 text-xs tabular-nums">
                                  {values(entry.to)}
                                </td>
                                <td className="py-2 pr-6 text-right font-medium tabular-nums">
                                  {formatKES(entry.differenceMinor)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </>
                      ) : null}
                    </table>
                  </div>
                ))}
              </section>
            ) : from === to ? (
              <p className="px-6 text-sm text-muted-foreground">{t("compare.same")}</p>
            ) : compare && !compare.ok ? (
              <p role="alert" className="px-6 text-sm text-destructive">
                {t("compare.failed")}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
