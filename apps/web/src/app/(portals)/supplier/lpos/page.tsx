import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, MapPin } from "lucide-react";
import { portalLposResponseSchema } from "@pm-buddy/validation";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import { PortalHeading, SupplierNav } from "@/components/supplier-portal/supplier-nav";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { deliveryTone, isUuid, lpoTone, pickParam } from "@/lib/p2p";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.lpos");
  return { title: t("title") };
}

/** The supplier's approved LPOs (D7.2), newest first, as cards that fit a 360 px phone. */
export default async function SupplierLposPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const cursor = pickParam(raw, "cursor");
  const query = new URLSearchParams();
  if (cursor && isUuid(cursor)) query.set("cursor", cursor);
  const path = `/supplier/lpos${query.size ? `?${query}` : ""}`;
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/lpos${query.size ? `?${query}` : ""}`,
    portalLposResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const t = await getTranslations("supplierPortal.lpos");
  const tStatus = await getTranslations("p2p.status");
  const { lpos, page: info } = page.data;
  return (
    <div className="space-y-6">
      <PortalHeading title={t("title")} description={t("description", { company: page.company })} />
      <SupplierNav current="lpos" />
      {lpos.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {lpos.map((lpo) => (
            <li key={lpo.id}>
              <Card className="h-full">
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="min-w-0">
                      <h2>
                        <Link href={`/supplier/lpos/${lpo.id}`} className="hover:underline">
                          {lpo.number}
                        </Link>
                      </h2>
                    </CardTitle>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge tone={lpoTone[lpo.status]}>
                        {t(`statuses.${lpo.status}`)}
                      </StatusBadge>
                      {lpo.status === "approved" ? (
                        <StatusBadge tone={deliveryTone[lpo.deliveryState]}>
                          {tStatus(`delivery.${lpo.deliveryState}`)}
                        </StatusBadge>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {lpo.project.code} · {lpo.project.name}
                  </p>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {lpo.deliverySite ? (
                    <p className="flex items-start gap-2">
                      <MapPin
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      {t("deliverTo", { site: lpo.deliverySite.name })}
                    </p>
                  ) : null}
                  <p className="flex items-start gap-2">
                    <CalendarDays
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    {lpo.deliveryDate
                      ? t("deliverBy", { date: formatCalendarDate(lpo.deliveryDate) })
                      : t("noDate")}
                  </p>
                  <p className="font-medium tabular-nums">
                    {t("total", { amount: formatKES(lpo.totalMinor) })}
                  </p>
                  <StatusBadge tone={lpo.acknowledgement ? "success" : "warning"}>
                    {lpo.acknowledgement ? t("acknowledged") : t("notAcknowledged")}
                  </StatusBadge>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
      {cursor || info.nextCursor ? (
        <nav aria-label={t("title")} className="flex flex-wrap gap-3 text-sm">
          {cursor ? (
            <Link href="/supplier/lpos" className="underline">
              {t("firstPage")}
            </Link>
          ) : null}
          {info.nextCursor ? (
            <Link href={`/supplier/lpos?cursor=${info.nextCursor}`} className="underline">
              {t("nextPage")}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
