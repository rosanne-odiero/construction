import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import { portalDeliveriesResponseSchema } from "@pm-buddy/validation";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import { PortalHeading, SupplierNav } from "@/components/supplier-portal/supplier-nav";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { formatQuantity, grnTone, isUuid, pickParam } from "@/lib/p2p";
import { unitLabel } from "@/lib/procurement";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("supplierPortal.deliveries");
  return { title: t("title") };
}

/**
 * Deliveries recorded against the supplier's LPOs (D7.2): what was received, rejected and why,
 * with the delivery note and vehicle. Internal notes, photos, positions and the receiver's name
 * stay with the company.
 */
export default async function SupplierDeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["lpoId", "cursor"]) {
    const value = pickParam(raw, key);
    if (value && isUuid(value)) query.set(key, value);
  }
  const suffix = query.size ? `?${query}` : "";
  const path = `/supplier/deliveries${suffix}`;
  const page = await loadSupplierPage(
    path,
    `/portal/supplier/deliveries${suffix}`,
    portalDeliveriesResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref={path} />;
  const t = await getTranslations("supplierPortal.deliveries");
  const tStatus = await getTranslations("p2p.status");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit));
  const { deliveries, page: info } = page.data;
  const next = new URLSearchParams(query);
  if (info.nextCursor) next.set("cursor", info.nextCursor);
  const first = new URLSearchParams(query);
  first.delete("cursor");
  return (
    <div className="space-y-6">
      <PortalHeading title={t("title")} description={t("description", { company: page.company })} />
      <SupplierNav current="deliveries" />
      {deliveries.length ? (
        <ul className="space-y-4">
          {deliveries.map((delivery) => (
            <li key={delivery.id}>
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="min-w-0">
                      <h2>
                        {delivery.number} ·{" "}
                        <Link href={`/supplier/lpos/${delivery.lpo.id}`} className="underline">
                          {delivery.lpo.number}
                        </Link>
                      </h2>
                    </CardTitle>
                    <StatusBadge tone={grnTone[delivery.status]}>
                      {tStatus(`grn.${delivery.status}`)}
                    </StatusBadge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {delivery.project.code}
                    {delivery.site ? ` · ${delivery.site.name}` : ""} ·{" "}
                    {t("received", { date: formatDate(delivery.receivedAt) })}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {delivery.deliveryNoteNumber
                      ? t("deliveryNote", { number: delivery.deliveryNoteNumber })
                      : t("noDeliveryNote")}{" "}
                    · {t("vehicle", { registration: delivery.vehicleRegistration })}
                  </p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {delivery.status === "voided" ? (
                    <p className="text-sm text-muted-foreground">
                      {t("voided", { company: page.company })}
                    </p>
                  ) : null}
                  <ul className="space-y-2">
                    {delivery.lines.map((line) => (
                      <li key={line.lpoLineId} className="rounded-lg border p-3 text-sm">
                        <h3 className="font-medium">{line.material.name}</h3>
                        <dl className="mt-1 grid grid-cols-3 gap-2">
                          <div>
                            <dt className="text-xs text-muted-foreground">{t("cols.received")}</dt>
                            <dd>
                              {formatQuantity(line.receivedQuantity)} {label(line.unit)}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">{t("cols.rejected")}</dt>
                            <dd>
                              {formatQuantity(line.rejectedQuantity)} {label(line.unit)}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">{t("cols.accepted")}</dt>
                            <dd>
                              {formatQuantity(line.acceptedBaseQuantity)}{" "}
                              {label(line.material.baseUnit)}
                            </dd>
                          </div>
                        </dl>
                        {line.rejectionReason ? (
                          <p className="mt-1 text-xs break-words">
                            <span className="text-muted-foreground">{t("cols.reason")}:</span>{" "}
                            {line.rejectionReason}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
      {query.has("cursor") || info.nextCursor ? (
        <nav aria-label={t("title")} className="flex flex-wrap gap-3 text-sm">
          {query.has("cursor") ? (
            <Link
              href={`/supplier/deliveries${first.size ? `?${first}` : ""}`}
              className="underline"
            >
              {t("firstPage")}
            </Link>
          ) : null}
          {info.nextCursor ? (
            <Link href={`/supplier/deliveries?${next}`} className="underline">
              {t("nextPage")}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
