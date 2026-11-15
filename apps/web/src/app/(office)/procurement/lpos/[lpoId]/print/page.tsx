import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import { lpoDetailResponseSchema } from "@pm-buddy/validation";
import { PrintButton } from "@/components/procurement/p2p/lpo-panels";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatDate, formatKES } from "@/lib/format";
import { formatQuantity, isUuid } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.lpos");
  return { title: t("title") };
}

/** A printable LPO (browser print; the print stylesheet hides the app's navigation). */
export default async function LpoPrintPage({ params }: { params: Promise<{ lpoId: string }> }) {
  const { lpoId } = await params;
  if (!isUuid(lpoId)) notFound();
  const detailPath = `/procurement/lpos/${lpoId}`;
  const path = `${detailPath}/print`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(detailPath, lpoDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { lpo, lines } = result.data;
  const t = await getTranslations("p2p.lpos");
  const tCommon = await getTranslations("p2p.common");
  const tEtims = await getTranslations("suppliers.etims");
  const tVat = await getTranslations("catalogue.detail.vat");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);

  return (
    <article className="mx-auto max-w-3xl space-y-6 bg-background text-foreground print:max-w-none">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button asChild variant="outline">
          <Link href={detailPath}>{t("print.back")}</Link>
        </Button>
        <PrintButton />
      </div>
      <header className="space-y-1 border-b pb-4">
        <p className="text-sm text-muted-foreground">
          {t("print.company", { company: session.company.name })}
        </p>
        <h1 className="text-2xl font-semibold">{t("print.title", { number: lpo.number })}</h1>
        <p className="text-sm">
          {lpo.approvedAt && lpo.approvedBy
            ? t("print.issued", {
                date: formatDate(lpo.approvedAt),
                name: lpo.approvedBy.displayName,
              })
            : t("print.notApproved")}
        </p>
      </header>
      <div className="grid gap-4 text-sm sm:grid-cols-2">
        <section aria-labelledby="print-to">
          <h2 id="print-to" className="font-semibold">
            {t("print.to")}
          </h2>
          <p>
            {lpo.supplier.name} ({lpo.supplier.code})
          </p>
          <p>
            {t("detail.kraPin")}: {lpo.supplier.kraPinMasked ?? t("detail.noPin")}
          </p>
          <p>
            {t("detail.etims")}: {tEtims(lpo.supplier.etimsStatus)}
          </p>
          <p>{t("detail.creditDays", { days: lpo.creditDays })}</p>
        </section>
        <section aria-labelledby="print-deliver">
          <h2 id="print-deliver" className="font-semibold">
            {t("print.deliverTo")}
          </h2>
          <p>
            {lpo.project.code} · {lpo.project.name}
          </p>
          <p>{lpo.deliverySite?.name ?? tCommon("noSite")}</p>
          <p>
            {t("detail.deliveryDate")}:{" "}
            {lpo.deliveryDate ? formatCalendarDate(lpo.deliveryDate) : t("detail.notSet")}
          </p>
        </section>
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">{t("detail.lines")}</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-1">
              {tCommon("material")}
            </th>
            <th scope="col" className="py-1">
              {tCommon("quantity")}
            </th>
            <th scope="col" className="py-1">
              {t("detail.price")}
            </th>
            <th scope="col" className="py-1 text-right">
              {t("detail.net")}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b align-top">
              <th scope="row" className="py-1 text-left font-normal">
                {line.material.code} · {line.material.name}
              </th>
              <td className="py-1 tabular-nums">
                {formatQuantity(line.quantity)} {label(line.unit)}
              </td>
              <td className="py-1 tabular-nums">
                {tCommon("perUnit", {
                  price: formatKES(line.unitPriceMinor),
                  unit: label(line.priceUnit),
                })}{" "}
                ({tVat(line.vatTreatment)})
              </td>
              <td className="py-1 text-right tabular-nums">{formatKES(line.netAmountMinor)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="tabular-nums">
          <tr>
            <th scope="row" colSpan={3} className="py-1 text-right font-normal">
              {tCommon("subtotal")}
            </th>
            <td className="py-1 text-right">{formatKES(lpo.subtotalMinor)}</td>
          </tr>
          <tr>
            <th scope="row" colSpan={3} className="py-1 text-right font-normal">
              {tCommon("vat", { rate: lpo.vatRatePercent })}
            </th>
            <td className="py-1 text-right">{formatKES(lpo.vatMinor)}</td>
          </tr>
          <tr>
            <th scope="row" colSpan={3} className="py-1 text-right font-semibold">
              {tCommon("total")}
            </th>
            <td className="py-1 text-right font-semibold">{formatKES(lpo.totalMinor)}</td>
          </tr>
        </tfoot>
      </table>
      {lpo.terms ? (
        <section aria-labelledby="print-terms" className="text-sm">
          <h2 id="print-terms" className="font-semibold">
            {t("detail.terms")}
          </h2>
          <p className="whitespace-pre-line">{lpo.terms}</p>
        </section>
      ) : null}
      <p className="border-t pt-3 text-xs text-muted-foreground">{t("print.footer")}</p>
    </article>
  );
}
