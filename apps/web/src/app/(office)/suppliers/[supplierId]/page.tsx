import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Pencil } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { supplierDetailResponseSchema, unitsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import { PayoutPanel } from "@/components/procurement/payout-panel";
import { RevealValue } from "@/components/procurement/reveal-value";
import { alertTone, etimsTone, supplierStatusTone } from "@/components/procurement/tones";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { unitLabel } from "@/lib/procurement";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("suppliers");
  return { title: t("title") };
}

/**
 * A supplier profile (D5.1): masked identifiers with reveal, eTIMS status as recorded, contacts,
 * terms, maker-checker payout details and recent prices.
 */
export default async function SupplierPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}) {
  const { supplierId } = await params;
  if (!UUID.test(supplierId)) notFound();
  const path = `/suppliers/${supplierId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, unitsResult] = await Promise.all([
    serverApi(path, supplierDetailResponseSchema),
    serverApi("/units", unitsResponseSchema),
  ]);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404) notFound();
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("suppliers.profile");
  const tSuppliers = await getTranslations("suppliers");
  const tStatuses = await getTranslations("suppliers.statuses");
  const tEtims = await getTranslations("suppliers.etims");
  const tDetail = await getTranslations("catalogue.detail");
  const tUnits = await getTranslations("catalogue.units");
  const tPriceCols = await getTranslations("catalogue.alerts.cols");
  const units = unitsResult.ok ? unitsResult.data.units : [];
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const detail = result.data;
  const { supplier, contacts, permissions } = detail;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/suppliers" className="hover:underline">
            {tSuppliers("title")}
          </Link>
        }
        title={`${supplier.code} · ${supplier.tradingName ?? supplier.legalName}`}
        description={supplier.tradingName ? supplier.legalName : undefined}
        actions={
          <>
            <StatusBadge tone={supplierStatusTone[supplier.status]}>
              {tStatuses(supplier.status)}
            </StatusBadge>
            {permissions.canManage ? (
              <Button asChild variant="outline">
                <Link href={`/suppliers/${supplier.id}/edit`}>
                  <Pencil aria-hidden /> {t("edit")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <CatalogueSubnav current="suppliers" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("identifiers")}</h2>
            </CardTitle>
            <CardDescription>{t("revealNote")}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">{t("kraPin")}</dt>
              <dd>
                {supplier.kraPinMasked ? (
                  <RevealValue
                    supplierId={supplier.id}
                    field="kraPin"
                    masked={supplier.kraPinMasked}
                    canReveal={permissions.canRevealIdentifiers}
                  />
                ) : (
                  t("none")
                )}
              </dd>
              <dt className="text-muted-foreground">{t("etims")}</dt>
              <dd className="space-y-1">
                <StatusBadge tone={etimsTone[supplier.etimsStatus]}>
                  {tEtims(supplier.etimsStatus)}
                </StatusBadge>
                {supplier.etimsCheckedOn ? (
                  <span className="block">
                    {t("etimsChecked", { date: formatCalendarDate(supplier.etimsCheckedOn) })}
                  </span>
                ) : null}
                <span className="block text-xs text-muted-foreground">{t("etimsUnverified")}</span>
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("terms")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("creditDays")}</dt>
              <dd>{tSuppliers("terms", { days: supplier.creditDays })}</dd>
              <dt className="text-muted-foreground">{t("creditLimit")}</dt>
              <dd className="tabular-nums">
                {supplier.creditLimitMinor === null
                  ? t("noLimit")
                  : formatKES(supplier.creditLimitMinor)}
              </dd>
              <dt className="text-muted-foreground">{t("status")}</dt>
              <dd>{tStatuses(supplier.status)}</dd>
              {supplier.statusReason ? (
                <>
                  <dt className="text-muted-foreground">{t("statusReason")}</dt>
                  <dd>{supplier.statusReason}</dd>
                </>
              ) : null}
              {supplier.notes ? (
                <>
                  <dt className="text-muted-foreground">{t("notes")}</dt>
                  <dd className="whitespace-pre-line">{supplier.notes}</dd>
                </>
              ) : null}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{t("later")}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("contacts")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {contacts.length ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {contacts.map((contact) => (
                <li key={contact.id} className="space-y-1 rounded-lg border p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {contact.name}
                    {contact.primary ? <StatusBadge tone="info">{t("primary")}</StatusBadge> : null}
                  </p>
                  {contact.role ? <p className="text-muted-foreground">{contact.role}</p> : null}
                  <p className="flex flex-wrap items-center gap-1">
                    <span className="text-muted-foreground">{t("phone")}:</span>
                    {contact.phoneMasked ? (
                      <RevealValue
                        supplierId={supplier.id}
                        field="contactPhone"
                        masked={contact.phoneMasked}
                        contactId={contact.id}
                        canReveal={permissions.canRevealIdentifiers}
                      />
                    ) : (
                      t("noPhone")
                    )}
                  </p>
                  {contact.email ? (
                    <p>
                      <span className="text-muted-foreground">{t("email")}:</span> {contact.email}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noContacts")}</p>
          )}
        </CardContent>
      </Card>
      <PayoutPanel detail={detail} />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("pricesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {detail.prices.length ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <caption className="sr-only">{t("pricesTitle")}</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      {tDetail("priceCols.date")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {tPriceCols("material")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {tDetail("priceCols.price")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {tDetail("priceCols.change")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.prices.map((price) => (
                    <tr key={price.id} className="border-b align-top last:border-0">
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        {formatCalendarDate(price.effectiveOn)}
                      </th>
                      <td className="py-2 pr-2">
                        <Link href={`/catalogue/${price.material.id}`} className="hover:underline">
                          {price.material.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-2 tabular-nums">
                        {formatKES(price.unitPriceMinor)}{" "}
                        {tDetail("perUnit", { unit: label(price.unit) })}
                      </td>
                      <td className="py-2 pr-2">
                        <StatusBadge tone={alertTone[price.alertState]}>
                          {price.correctedById
                            ? tDetail("corrected")
                            : tDetail(`alertStates.${price.alertState}`)}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noPrices")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
