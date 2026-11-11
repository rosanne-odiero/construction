import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import {
  priceAlertsQuerySchema,
  priceAlertsResponseSchema,
  procurementSettingsResponseSchema,
  unitsResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import { ThresholdForm } from "@/components/procurement/unit-dialog";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { formatChange, unitLabel } from "@/lib/procurement";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("catalogue.alerts");
  return { title: t("title") };
}

/** Prices above the company's change threshold, and the threshold itself (D5.1). */
export default async function PriceAlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = priceAlertsQuerySchema.safeParse({
    cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
  });
  const cursor = parsed.success ? parsed.data.cursor : undefined;
  const path = `/catalogue/alerts${cursor ? `?cursor=${cursor}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, settings, unitsResult] = await Promise.all([
    serverApi(`/price-alerts${cursor ? `?cursor=${cursor}` : ""}`, priceAlertsResponseSchema),
    serverApi("/procurement/settings", procurementSettingsResponseSchema),
    serverApi("/units", unitsResponseSchema),
  ]);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("catalogue.alerts");
  const tCatalogue = await getTranslations("catalogue");
  const tDetail = await getTranslations("catalogue.detail");
  const tUnits = await getTranslations("catalogue.units");
  const units = unitsResult.ok ? unitsResult.data.units : [];
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { alerts, page, priceChangeAlertPercent } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{tCatalogue("live")}</StatusBadge>}
        title={t("title")}
        description={t("description", { threshold: priceChangeAlertPercent })}
      />
      <CatalogueSubnav current="alerts" />
      {settings.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("settingsTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("settingsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <ThresholdForm
              percent={settings.data.settings.priceChangeAlertPercent}
              version={settings.data.settings.version}
              canManage={settings.data.permissions.canManage}
            />
            <p className="text-xs text-muted-foreground">{t("notifyNote")}</p>
          </CardContent>
        </Card>
      ) : null}
      {alerts.length ? (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.material")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.supplier")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.date")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.price")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.change")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.recorded")}
                </th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    <Link
                      href={`/catalogue/${alert.material.id}`}
                      className="underline underline-offset-4"
                    >
                      <span className="font-mono">{alert.material.code}</span> ·{" "}
                      {alert.material.name}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    <Link href={`/suppliers/${alert.supplier.id}`} className="hover:underline">
                      {alert.supplier.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-2">{formatCalendarDate(alert.effectiveOn)}</td>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatKES(alert.unitPriceMinor)}{" "}
                    {tDetail("perUnit", { unit: label(alert.unit) })}
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone="warning">
                      {alert.change ? formatChange(alert.change.percent) : "—"}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-4">{alert.recordedBy.displayName}</td>
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
      {cursor || page.nextCursor ? (
        <nav className="flex gap-2" aria-label={t("title")}>
          {cursor ? (
            <Button asChild variant="outline">
              <Link href="/catalogue/alerts">{tCatalogue("firstPage")}</Link>
            </Button>
          ) : null}
          {page.nextCursor ? (
            <Button asChild variant="outline">
              <Link href={`/catalogue/alerts?cursor=${page.nextCursor}`}>
                {tCatalogue("nextPage")}
              </Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
