import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import { unitsResponseSchema, type UnitWire } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import { UnitDialogButton, UnitStatusButton } from "@/components/procurement/unit-dialog";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { formatDecimalString } from "@/lib/format";
import { formatFactor } from "@/lib/procurement";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("catalogue.unitsPage");
  return { title: t("title") };
}

/** Standard units and the company's own units (D5.1). */
export default async function UnitsPage() {
  const path = "/catalogue/units";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi("/units", unitsResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("catalogue.unitsPage");
  const tCatalogue = await getTranslations("catalogue");
  const tDimensions = await getTranslations("catalogue.dimensions");
  const tUnits = await getTranslations("catalogue.units");
  const tStatuses = await getTranslations("catalogue.statuses");
  const { units, permissions } = result.data;
  const standard = units.filter((unit) => unit.standard);
  const company = units.filter((unit) => !unit.standard);
  const name = (unit: UnitWire) =>
    unit.standard ? tUnits(unit.code as StandardUnitCode) : (unit.name ?? unit.code);
  const size = (unit: UnitWire) =>
    unit.sizeInBase && unit.baseUnit
      ? t("sizeValue", {
          size: formatFactor(unit.sizeInBase),
          unit: tUnits(unit.baseUnit as StandardUnitCode),
        })
      : t("noSize");

  const table = (rows: UnitWire[], caption: string, withActions: boolean) => (
    <div className="relative overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pl-4 font-medium">
              {t("cols.code")}
            </th>
            <th scope="col" className="py-2 font-medium">
              {t("cols.name")}
            </th>
            <th scope="col" className="py-2 font-medium">
              {t("cols.dimension")}
            </th>
            <th scope="col" className="py-2 font-medium">
              {t("cols.size")}
            </th>
            {withActions ? (
              <>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.actions")}
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((unit) => (
            <tr key={unit.code} className="border-b align-top last:border-0">
              <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                {unit.code}
              </th>
              <td className="py-2 pr-2">
                {name(unit)}
                {unit.nameSw ? (
                  <span className="block text-xs text-muted-foreground" lang="sw">
                    {unit.nameSw}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-2">{tDimensions(unit.dimension)}</td>
              <td className="py-2 pr-2 tabular-nums">
                {unit.equalsQuantity && unit.equalsUnit
                  ? `${size(unit)} (${formatDecimalString(unit.equalsQuantity)} ${tUnits(unit.equalsUnit as StandardUnitCode)})`
                  : size(unit)}
              </td>
              {withActions ? (
                <>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={unit.status === "active" ? "success" : "neutral"}>
                      {tStatuses(unit.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {permissions.canManage ? <UnitStatusButton unit={unit} /> : null}
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{tCatalogue("live")}</StatusBadge>}
        title={t("title")}
        description={t("description")}
        actions={permissions.canManage ? <UnitDialogButton /> : null}
      />
      <CatalogueSubnav current="units" />
      <section className="space-y-2" aria-labelledby="company-units">
        <h2 id="company-units" className="text-lg font-semibold">
          {t("company")}
        </h2>
        {company.length ? (
          table(company, t("company"), true)
        ) : (
          <p className="text-sm text-muted-foreground">{t("noCompany")}</p>
        )}
      </section>
      <section className="space-y-2" aria-labelledby="standard-units">
        <h2 id="standard-units" className="text-lg font-semibold">
          {t("standard")}
        </h2>
        {table(standard, t("standard"), false)}
      </section>
    </div>
  );
}
