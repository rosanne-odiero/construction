import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import type { RfqDetailResponse, UnitWire } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { formatKES } from "@/lib/format";
import { formatQuantity } from "@/lib/p2p";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { cn } from "@/lib/utils";

/**
 * The quotation comparison matrix (D5.2): one row per requested line, one column per received
 * quotation, each cell net of VAT per base unit with the line amount; the lowest price per line
 * and the lowest complete, unexpired total are marked in text, not only by colour.
 */
export async function ComparisonMatrix({
  detail,
  units,
}: {
  detail: RfqDetailResponse;
  units: UnitWire[];
}) {
  const t = await getTranslations("p2p.rfqs.matrix");
  const tCommon = await getTranslations("p2p.common");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const quotes = new Map(detail.quotations.map((quote) => [quote.id, quote]));
  const columns = detail.comparison.totals
    .map((total) => ({ total, quote: quotes.get(total.quotationId) }))
    .filter((entry) => entry.quote !== undefined);
  const lines = new Map(detail.lines.map((line) => [line.requisitionLineId, line]));

  return (
    <section aria-labelledby="comparison-matrix" className="space-y-2">
      <h2 id="comparison-matrix" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {columns.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div
          role="region"
          tabIndex={0}
          aria-label={t("title")}
          className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          data-testid="comparison-matrix"
        >
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("line")}
                </th>
                {columns.map(({ quote }) => (
                  <th key={quote!.id} scope="col" className="py-2 pr-3 font-medium">
                    <span className="block text-foreground">{quote!.supplier.name}</span>
                    <span className="font-mono">{quote!.supplier.code}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.comparison.lines.map((row) => {
                const line = lines.get(row.requisitionLineId);
                return (
                  <tr key={row.requisitionLineId} className="border-b align-top">
                    <th scope="row" className="py-2 pl-4 text-left font-medium">
                      {line?.material.name ?? "—"}
                      {line ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {formatQuantity(line.quantity)} {label(line.unit)} ·{" "}
                          {line.requisition.number}
                        </span>
                      ) : null}
                    </th>
                    {columns.map(({ quote }) => {
                      const cell = row.cells.find((entry) => entry.quotationId === quote!.id);
                      return (
                        <td
                          key={quote!.id}
                          className={cn("py-2 pr-3 tabular-nums", cell?.lowest && "bg-success/10")}
                        >
                          {cell?.netUnitPriceBaseMinor ? (
                            <>
                              <span className="block">
                                {t("perBase", {
                                  price: formatMinorDecimal(cell.netUnitPriceBaseMinor),
                                  unit: line ? label(line.material.baseUnit) : "",
                                })}
                              </span>
                              {cell.netAmountMinor !== null ? (
                                <span className="block text-xs text-muted-foreground">
                                  {t("amount", { amount: formatKES(cell.netAmountMinor) })}
                                </span>
                              ) : null}
                              {cell.lowest ? (
                                <StatusBadge tone="success" className="mt-1">
                                  {t("lowest")}
                                </StatusBadge>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground">{tCommon("noBid")}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted/30 align-top">
                <th scope="row" className="py-2 pl-4 text-left font-semibold">
                  {t("totals")}
                </th>
                {columns.map(({ quote, total }) => (
                  <td
                    key={quote!.id}
                    className={cn(
                      "py-2 pr-3 font-semibold tabular-nums",
                      total.lowest && "bg-success/10",
                    )}
                  >
                    {formatKES(total.netTotalMinor)}
                    <span className="mt-1 flex flex-wrap gap-1 font-normal">
                      {total.lowest ? (
                        <StatusBadge tone="success">{t("lowest")}</StatusBadge>
                      ) : null}
                      {!total.complete ? (
                        <StatusBadge tone="warning">{t("incomplete")}</StatusBadge>
                      ) : null}
                      {quote!.expired ? (
                        <StatusBadge tone="warning">{t("expired")}</StatusBadge>
                      ) : null}
                    </span>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
