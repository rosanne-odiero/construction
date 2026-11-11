import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buildupResponseSchema, buildupVersionResponseSchema } from "@pm-buddy/validation";
import { BuildupAssumptions } from "@/components/bq/buildup-assumptions";
import { BuildupEditor } from "@/components/bq/buildup-editor";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatDecimalString, formatKES } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("rateBuildUps");
  return { title: t("title") };
}

/** One build-up: a version's resource lines and rate, the version history and the editor. */
export default async function BuildupPage({
  params,
  searchParams,
}: {
  params: Promise<{ buildupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { buildupId } = await params;
  if (!UUID.test(buildupId)) notFound();
  const { version: rawVersion } = await searchParams;
  const path = `/rate-buildups/${buildupId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi(`/rate-buildups/${buildupId}`, buildupResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404) notFound();
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const data = result.data;
  const requested =
    typeof rawVersion === "string" && /^\d{1,9}$/.test(rawVersion) ? Number(rawVersion) : null;
  let shown = data.current;
  if (requested && requested !== data.current.versionNo) {
    const other = await serverApi(
      `/rate-buildups/${buildupId}/versions/${requested}`,
      buildupVersionResponseSchema,
    );
    if (other.ok) shown = other.data.version;
  }
  const t = await getTranslations("rateBuildUps");
  const tKinds = await getTranslations("rateBuildUps.kinds");
  const tUnits = await getTranslations("liveBq.units");
  const unit = tUnits(shown.unit);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/rate-buildups" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={`${data.buildup.code} · ${shown.name}`}
        description={t("perUnit", { unit })}
        actions={
          <StatusBadge tone={shown.versionNo === data.current.versionNo ? "info" : "neutral"}>
            {t("versionNo", { version: shown.versionNo })}
          </StatusBadge>
        }
      />
      <BuildupAssumptions />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>{t("detail.lines", { version: shown.versionNo })}</h2>
            </CardTitle>
            <CardDescription>{shown.assumptions ?? t("detail.noAssumptions")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <caption className="sr-only">
                  {t("detail.lines", { version: shown.versionNo })}
                </caption>
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pl-6 font-medium">
                      {t("detail.cols.resource")}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {t("detail.cols.quantity", { unit })}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {t("detail.cols.waste")}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      {t("detail.cols.cost")}
                    </th>
                    <th scope="col" className="py-2 pr-6 text-right font-medium">
                      {t("detail.cols.amount")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.lines.map((line) => (
                    <tr key={line.lineNo} className="border-b last:border-0">
                      <th scope="row" className="py-2 pl-6 text-left font-normal">
                        {line.resourceName}
                        <span className="block text-xs text-muted-foreground">
                          {tKinds(line.kind)}
                        </span>
                      </th>
                      <td className="py-2 text-right tabular-nums">
                        {formatDecimalString(line.quantity)} {line.unit}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {line.wastePercent === null ? "—" : `${line.wastePercent}%`}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {line.unitCostMinor === null
                          ? t("detail.unpriced")
                          : formatKES(line.unitCostMinor)}
                      </td>
                      <td className="py-2 pr-6 text-right tabular-nums">
                        {line.amountMinor === null
                          ? t("detail.unpriced")
                          : formatKES(line.amountMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-accent/40 font-semibold">
                    <td colSpan={4} className="py-2 pl-6">
                      {t("detail.rate", { unit })}
                    </td>
                    <td className="py-2 pr-6 text-right tabular-nums" data-testid="buildup-rate">
                      {shown.rateMinor === null
                        ? t("unavailable", { count: shown.unpricedLines })
                        : formatKES(shown.rateMinor)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("detail.versions")}</h2>
            </CardTitle>
            <CardDescription>{t("detail.versionsNote")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {data.versions.map((version) => (
                <li
                  key={version.id}
                  className="flex items-start justify-between gap-2 border-b pb-2"
                >
                  <span>
                    <Link
                      href={`/rate-buildups/${buildupId}?version=${version.versionNo}`}
                      aria-current={version.versionNo === shown.versionNo ? "page" : undefined}
                      className="font-medium underline underline-offset-4"
                    >
                      {t("versionNo", { version: version.versionNo })}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {t("detail.by", {
                        name: version.createdBy.displayName,
                        date: formatDateTime(version.createdAt),
                      })}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {version.rateMinor === null ? "—" : formatKES(version.rateMinor)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("linkCount", { count: data.buildup.linkCount })}
            </p>
          </CardContent>
        </Card>
      </div>
      {data.permissions.canEdit ? (
        <BuildupEditor key={data.buildup.version} existing={data} />
      ) : null}
    </div>
  );
}
