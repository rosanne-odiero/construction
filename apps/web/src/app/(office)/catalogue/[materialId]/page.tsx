import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Calculator } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { materialDetailResponseSchema, unitsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import {
  ConversionDialogButton,
  EndConversionButton,
} from "@/components/procurement/conversion-dialog";
import { MaterialFormButton } from "@/components/procurement/material-form";
import { PriceHistoryChart } from "@/components/procurement/price-chart";
import { PriceDialogButton } from "@/components/procurement/price-dialog";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { alertTone } from "@/components/procurement/tones";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCalendarDate, formatKES } from "@/lib/format";
import {
  formatChange,
  formatFactor,
  formatMinorDecimal,
  minorDecimalToShillings,
  unitLabel,
} from "@/lib/procurement";
import { supplierPicker } from "@/lib/procurement-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("catalogue");
  return { title: t("title") };
}

/** One material: details, standard and explicit conversions, and the price history (D5.1). */
export default async function MaterialPage({
  params,
}: {
  params: Promise<{ materialId: string }>;
}) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) notFound();
  const path = `/catalogue/${materialId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, unitsResult, supplierRefs] = await Promise.all([
    serverApi(`/materials/${materialId}`, materialDetailResponseSchema),
    serverApi("/units", unitsResponseSchema),
    supplierPicker(),
  ]);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404) notFound();
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const units = unitsResult.ok ? unitsResult.data.units : [];
  const t = await getTranslations("catalogue.detail");
  const tCatalogue = await getTranslations("catalogue");
  const tCategories = await getTranslations("catalogue.categories");
  const tUnits = await getTranslations("catalogue.units");
  const tForm = await getTranslations("catalogue.form");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const data = result.data;
  const { material } = data;
  const canManage = data.permissions.canManage;
  const base = label(material.baseUnit);
  const attributes = Object.entries(material.attributes).filter(([, value]) => value !== undefined);
  const live = data.prices.filter((price) => price.correctedById === null);
  const chartPoints = live
    .filter((price) => price.comparable)
    .map((price) => ({
      date: price.effectiveOn,
      label: formatCalendarDate(price.effectiveOn),
      supplierId: price.supplier.id,
      shillings: minorDecimalToShillings(price.comparable!.unitPriceMinor),
    }));
  const chartSuppliers = data.suppliers.filter((supplier) =>
    chartPoints.some((point) => point.supplierId === supplier.id),
  );
  const conversionLabel = (from: string, factor: string, to: string) =>
    t("factor", { from: label(from), factor: formatFactor(factor), to: label(to) });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/catalogue" className="hover:underline">
            {tCatalogue("title")}
          </Link>
        }
        title={`${material.code} · ${material.name}`}
        description={`${tCategories(material.category)} · ${t("baseUnit")}: ${base}`}
        actions={
          <>
            {material.status === "archived" ? (
              <StatusBadge tone="neutral">{tCatalogue("statuses.archived")}</StatusBadge>
            ) : null}
            {material.alertCount ? (
              <StatusBadge tone="warning">
                {tCatalogue("alertCount", { count: material.alertCount })}
              </StatusBadge>
            ) : null}
            <Button asChild variant="outline">
              <Link href={`/catalogue/convert?materialId=${material.id}`}>
                <Calculator aria-hidden /> {tCatalogue("nav.convert")}
              </Link>
            </Button>
            {canManage ? <MaterialFormButton units={units} material={material} /> : null}
          </>
        }
      />
      <CatalogueSubnav current="materials" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("overview")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("code")}</dt>
              <dd className="font-mono">{material.code}</dd>
              <dt className="text-muted-foreground">{t("nameSw")}</dt>
              <dd lang="sw">{material.nameSw ?? t("none")}</dd>
              <dt className="text-muted-foreground">{t("category")}</dt>
              <dd>{tCategories(material.category)}</dd>
              <dt className="text-muted-foreground">{t("baseUnit")}</dt>
              <dd>{base}</dd>
              <dt className="text-muted-foreground">{t("spec")}</dt>
              <dd>{material.spec ?? t("none")}</dd>
              <dt className="text-muted-foreground">{t("attributes")}</dt>
              <dd>
                {attributes.length ? (
                  <ul>
                    {attributes.map(([key, value]) => (
                      <li key={key}>
                        {tForm(key as "diameterMm")}:{" "}
                        {key === "diameterMm"
                          ? tForm("diameterOption", { diameter: Number(value) })
                          : String(value)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("none")
                )}
              </dd>
              {material.notes ? (
                <>
                  <dt className="text-muted-foreground">{t("notes")}</dt>
                  <dd className="whitespace-pre-line">{material.notes}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>{t("standardTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("standardDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.standardConversions.length ? (
              <ul className="space-y-1 text-sm" data-testid="standard-conversions">
                {data.standardConversions.map((factor) => (
                  <li key={`${factor.from}-${factor.to}`}>
                    <span className="font-medium tabular-nums">
                      {conversionLabel(factor.from, factor.factor, factor.to)}
                    </span>{" "}
                    <span className="text-muted-foreground">({t(`rules.${factor.rule}`)})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noStandard")}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle>
              <h2>{t("conversionsTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("conversionsDescription")}</CardDescription>
          </div>
          {canManage && material.status === "active" ? (
            <ConversionDialogButton
              materialId={material.id}
              units={units}
              suppliers={supplierRefs}
            />
          ) : null}
        </CardHeader>
        <CardContent>
          {data.conversions.length ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <caption className="sr-only">{t("conversionsTitle")}</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      {t("cols.factor")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("cols.scope")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("cols.from")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("cols.to")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("cols.note")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("cols.state")}
                    </th>
                    {canManage ? (
                      <th scope="col" className="py-2 text-right font-medium">
                        {t("cols.actions")}
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.conversions.map((conversion) => {
                    const factor = conversionLabel(
                      conversion.fromUnit,
                      conversion.factor,
                      conversion.toUnit,
                    );
                    const state = conversion.inForce
                      ? "inForce"
                      : conversion.effectiveTo
                        ? "ended"
                        : "notYet";
                    return (
                      <tr key={conversion.id} className="border-b align-top last:border-0">
                        <th scope="row" className="py-2 pr-2 text-left font-medium tabular-nums">
                          {factor}
                        </th>
                        <td className="py-2 pr-2">
                          {conversion.supplier ? conversion.supplier.name : t("allSuppliers")}
                        </td>
                        <td className="py-2 pr-2">
                          {formatCalendarDate(conversion.effectiveFrom)}
                        </td>
                        <td className="py-2 pr-2">
                          {conversion.effectiveTo
                            ? formatCalendarDate(conversion.effectiveTo)
                            : "—"}
                        </td>
                        <td className="py-2 pr-2 text-muted-foreground">
                          {conversion.note ?? "—"}
                        </td>
                        <td className="py-2 pr-2">
                          <StatusBadge tone={state === "inForce" ? "success" : "neutral"}>
                            {t(state)}
                          </StatusBadge>
                        </td>
                        {canManage ? (
                          <td className="py-2 text-right">
                            {conversion.effectiveTo ? null : (
                              <EndConversionButton
                                materialId={material.id}
                                conversionId={conversion.id}
                                factorLabel={factor}
                              />
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noConversions")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle>
              <h2>{t("pricesTitle")}</h2>
            </CardTitle>
            <CardDescription>
              {t("pricesDescription", { unit: base, threshold: data.priceChangeAlertPercent })}
            </CardDescription>
          </div>
          {canManage && material.status === "active" ? (
            <PriceDialogButton
              materialId={material.id}
              baseUnit={material.baseUnit}
              units={units}
              suppliers={supplierRefs}
              vatRatePercent={data.vatRatePercent}
            />
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {chartPoints.length ? (
            <div>
              <h3 className="text-sm font-medium">{t("chartTitle", { unit: base })}</h3>
              <p className="text-xs text-muted-foreground">{t("chartDescription")}</p>
              <PriceHistoryChart
                points={chartPoints}
                suppliers={chartSuppliers}
                title={t("chartTitle", { unit: base })}
                unitLabel={base}
              />
            </div>
          ) : null}
          {data.prices.length ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <caption className="sr-only">{t("pricesTitle")}</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 font-medium">
                      {t("priceCols.date")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("priceCols.supplier")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("priceCols.price")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("priceCols.vat")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("priceCols.comparable", { unit: base })}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("priceCols.change")}
                    </th>
                    {canManage ? (
                      <th scope="col" className="py-2 text-right font-medium">
                        {t("priceCols.actions")}
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.prices.map((price) => (
                    <tr
                      key={price.id}
                      className={`border-b align-top last:border-0 ${price.correctedById ? "text-muted-foreground line-through decoration-1" : ""}`}
                    >
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        {formatCalendarDate(price.effectiveOn)}
                      </th>
                      <td className="py-2 pr-2">{price.supplier.name}</td>
                      <td className="py-2 pr-2 tabular-nums">
                        {formatKES(price.unitPriceMinor)}{" "}
                        {t("perUnit", { unit: label(price.unit) })}
                      </td>
                      <td className="py-2 pr-2">{t(`vat.${price.vatTreatment}`)}</td>
                      <td className="py-2 pr-2 tabular-nums">
                        {price.comparable
                          ? formatMinorDecimal(price.comparable.unitPriceMinor)
                          : t("notComparable", { unit: base })}
                      </td>
                      <td className="py-2 pr-2 no-underline">
                        <span className="flex flex-wrap items-center gap-1">
                          {price.change ? (
                            <span className="tabular-nums">
                              {formatChange(price.change.percent)}
                            </span>
                          ) : null}
                          <StatusBadge tone={alertTone[price.alertState]}>
                            {t(`alertStates.${price.alertState}`)}
                          </StatusBadge>
                          {price.correctedById ? (
                            <StatusBadge tone="neutral">{t("corrected")}</StatusBadge>
                          ) : null}
                        </span>
                        {price.correctionReason ? (
                          <span className="block text-xs text-muted-foreground">
                            {t("correctionOf", { reason: price.correctionReason })}
                          </span>
                        ) : null}
                      </td>
                      {canManage ? (
                        <td className="py-2 text-right">
                          {price.correctedById || material.status !== "active" ? null : (
                            <PriceDialogButton
                              materialId={material.id}
                              baseUnit={material.baseUnit}
                              units={units}
                              suppliers={supplierRefs}
                              vatRatePercent={data.vatRatePercent}
                              correcting={price}
                            />
                          )}
                        </td>
                      ) : null}
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
