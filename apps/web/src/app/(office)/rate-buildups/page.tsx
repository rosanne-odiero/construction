import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { buildupsResponseSchema } from "@pm-buddy/validation";
import { BuildupAssumptions } from "@/components/bq/buildup-assumptions";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatKES } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("rateBuildUps");
  return { title: t("title") };
}

/** The company's rate build-up library (D2.3). */
export default async function RateBuildupsPage() {
  const path = "/rate-buildups";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi("/rate-buildups", buildupsResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("rateBuildUps");
  const tUnits = await getTranslations("liveBq.units");
  const { buildups, permissions } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          permissions.canEdit ? (
            <Button asChild>
              <Link href="/rate-buildups/new">
                <Plus aria-hidden /> {t("new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <BuildupAssumptions />
      {buildups.length ? (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.code")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.name")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.version")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.links")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.rate")}
                </th>
              </tr>
            </thead>
            <tbody>
              {buildups.map((buildup) => (
                <tr key={buildup.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/rate-buildups/${buildup.id}`}
                      className="underline underline-offset-4"
                    >
                      {buildup.code}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    {buildup.name}
                    <span className="block text-xs text-muted-foreground">
                      {t("updated", { date: formatDateTime(buildup.updatedAt) })}
                    </span>
                  </td>
                  <td className="py-2 pr-2">
                    {t("versionNo", { version: buildup.currentVersionNo })}
                  </td>
                  <td className="py-2 pr-2">{t("linkCount", { count: buildup.linkCount })}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {buildup.rateMinor === null ? (
                      <StatusBadge tone="warning">
                        {t("unavailable", { count: buildup.unpricedLines })}
                      </StatusBadge>
                    ) : (
                      `${formatKES(buildup.rateMinor)} / ${tUnits(buildup.unit)}`
                    )}
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
    </div>
  );
}
