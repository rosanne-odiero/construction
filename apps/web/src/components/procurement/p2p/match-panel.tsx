import { getTranslations } from "next-intl/server";
import { CheckCircle2, CircleAlert, CircleMinus, XCircle } from "lucide-react";
import type { MatchHeaderReason, StandardUnitCode } from "@pm-buddy/types";
import type { ThreeWayMatchWire, UnitWire } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, formatKES } from "@/lib/format";
import { formatQuantity } from "@/lib/p2p";
import { formatComparedPrices, unitLabel } from "@/lib/procurement";
import { cn } from "@/lib/utils";

const QUANTITY_REASONS = new Set(["not-received", "qty-exceeds-received", "qty-exceeds-ordered"]);
const HEADER_CHECKS = [
  "total-arithmetic",
  "subtotal-mismatch",
  "vat-mismatch",
  "total-exceeds-order",
  "etims-missing",
] as const satisfies readonly MatchHeaderReason[];

async function Check({ state }: { state: "pass" | "fail" | "none" }) {
  const t = await getTranslations("p2p.match");
  if (state === "none")
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
        <CircleMinus className="size-4" aria-hidden /> {t("notBilled")}
      </span>
    );
  return state === "pass" ? (
    <StatusBadge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
      {t("pass")}
    </StatusBadge>
  ) : (
    <StatusBadge tone="danger" icon={<XCircle className="size-3.5" aria-hidden />}>
      {t("fail")}
    </StatusBadge>
  );
}

/**
 * The three-way match screen (D5.2 acceptance): per LPO line the ordered, received (accepted)
 * and invoiced quantities and prices with the tolerances, earlier billing, a pass/fail per check
 * with the API's explicit reasons, the invoice-level checks, totals, warnings and whether the
 * stored match is still current. Pass and fail are written out, never shown by colour alone.
 */
export async function MatchPanel({
  match,
  units,
  rematch,
}: {
  match: ThreeWayMatchWire | null;
  units: UnitWire[];
  /** The "run again" command (shown when the match is out of date). */
  rematch?: React.ReactNode;
}) {
  const t = await getTranslations("p2p.match");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);

  if (!match)
    return (
      <section
        aria-labelledby="three-way-match"
        className="space-y-2"
        data-testid="three-way-match"
      >
        <h2 id="three-way-match" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("notRun")}</p>
      </section>
    );

  const verdict = !match.passing
    ? { tone: "danger" as const, text: t("blocked") }
    : match.exception
      ? { tone: "info" as const, text: t("excepted") }
      : { tone: "success" as const, text: t("passing") };
  const failing = new Set(match.headerReasons);

  return (
    <section aria-labelledby="three-way-match" className="space-y-4" data-testid="three-way-match">
      <div className="space-y-1">
        <h2 id="three-way-match" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div
        role="status"
        data-testid="match-verdict"
        className={cn(
          "flex items-start gap-2 rounded-lg border p-3 text-sm font-medium",
          verdict.tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive",
          verdict.tone === "success" && "border-success/40 bg-success/10 text-success",
          verdict.tone === "info" && "border-info/40 bg-info/10 text-info",
        )}
      >
        {match.passing ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div className="space-y-1">
          <p>{verdict.text}</p>
          {match.reasons.length ? (
            <ul className="list-disc pl-5 font-normal">
              {match.reasons.map((reason) => (
                <li key={reason}>{t(`reasons.${reason}`)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {!match.current ? (
        <div
          role="alert"
          data-testid="match-stale"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/15 p-3 text-sm text-warning-foreground dark:text-warning"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          <p className="flex-1">
            {t("stale", {
              reasons: match.staleReasons.map((reason) => t(`staleReasons.${reason}`)).join("; "),
            })}
          </p>
          {rematch}
        </div>
      ) : null}
      {match.exception ? (
        <p className="text-sm" data-testid="match-exception">
          {t("exception.approvedBy", {
            name: match.exception.approvedBy.displayName,
            date: formatDateTime(match.exception.approvedAt),
            reason: match.exception.reason,
          })}
        </p>
      ) : null}

      <div
        role="region"
        tabIndex={0}
        aria-label={t("title")}
        className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <table className="w-full min-w-[1100px] text-sm" data-testid="match-lines">
          <caption className="sr-only">{t("title")}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pl-4 font-medium">
                {t("cols.line")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.ordered")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.received")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.previously")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.invoiced")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.allowed")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.quantityCheck")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.orderPrice")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.invoicePrice")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.allowedPrice")}
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                {t("cols.priceCheck")}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {t("cols.reasons")}
              </th>
            </tr>
          </thead>
          <tbody>
            {match.lines.map((line) => {
              const unit = line.material ? label(line.material.baseUnit) : "";
              const billed = /[1-9]/.test(line.invoicedQuantity);
              const quantityFails = line.reasons.some((reason) => QUANTITY_REASONS.has(reason));
              const priceFails = line.reasons.includes("price-above-order");
              const failed = line.reasons.length > 0;
              const [orderPrice, allowedPrice, invoicePrice] = formatComparedPrices([
                line.orderNetUnitPriceMinor,
                line.allowedNetUnitPriceMinor,
                ...(line.invoiceNetUnitPriceMinor ? [line.invoiceNetUnitPriceMinor] : []),
              ]);
              return (
                <tr
                  key={line.lpoLineId}
                  className={cn("border-b align-top last:border-0", failed && "bg-destructive/5")}
                >
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    {line.lineNo > 0 ? `${line.lineNo}. ` : ""}
                    {line.material?.name ?? "—"}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t("perBase", { unit })}
                    </span>
                  </th>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {formatQuantity(line.orderedQuantity)}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {formatQuantity(line.receivedQuantity)}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {formatQuantity(line.previouslyInvoicedQuantity)}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {formatQuantity(line.invoicedQuantity)}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {formatQuantity(line.allowedQuantity)}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap">
                    <Check state={!billed && !failed ? "none" : quantityFails ? "fail" : "pass"} />
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">{orderPrice}</td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">
                    {invoicePrice ?? "—"}
                  </td>
                  <td className="py-2 pr-2 whitespace-nowrap tabular-nums">{allowedPrice}</td>
                  <td className="py-2 pr-2 whitespace-nowrap">
                    <Check state={!billed && !failed ? "none" : priceFails ? "fail" : "pass"} />
                  </td>
                  <td className="py-2 pr-4">
                    {line.reasons.length || line.warnings.length ? (
                      <ul className="space-y-0.5 text-xs">
                        {line.reasons.map((reason) => (
                          <li key={reason} className="text-destructive">
                            {t(`reasons.${reason}`)}
                          </li>
                        ))}
                        {line.warnings.map((warning) => (
                          <li key={warning} className="text-muted-foreground">
                            {t(`warnings.${warning}`)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="match-header" className="space-y-2">
          <h3 id="match-header" className="font-semibold">
            {t("headerTitle")}
          </h3>
          <ul className="space-y-1.5 text-sm" data-testid="match-checks">
            {HEADER_CHECKS.map((check) => {
              const fails = failing.has(check);
              return (
                <li key={check} className="flex flex-wrap items-center gap-2">
                  <Check state={fails ? "fail" : "pass"} />
                  <span>{fails ? t(`reasons.${check}`) : t(`checks.${check}`)}</span>
                </li>
              );
            })}
          </ul>
          {match.warnings.length ? (
            <div className="space-y-1">
              <h3 className="font-semibold">{t("warningsTitle")}</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {match.warnings.map((warning) => (
                  <li key={warning}>{t(`warnings.${warning}`)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <section aria-labelledby="match-totals" className="space-y-2">
          <h3 id="match-totals" className="font-semibold">
            {t("totalsTitle")}
          </h3>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <td />
                <th scope="col" className="py-1 text-right font-medium">
                  {t("totals.stated")}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t("totals.computed")}
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  [
                    "subtotal",
                    match.totals.statedSubtotalMinor,
                    match.totals.computedSubtotalMinor,
                  ],
                  ["vat", match.totals.statedVatMinor, match.totals.computedVatMinor],
                  ["total", match.totals.statedTotalMinor, match.totals.computedTotalMinor],
                ] as const
              ).map(([key, stated, computed]) => (
                <tr key={key} className="border-t">
                  <th scope="row" className="py-1 text-left font-normal">
                    {t(`totals.${key}`)}
                  </th>
                  <td className={cn("py-1 text-right", stated !== computed && "font-semibold")}>
                    {formatKES(stated)}
                  </td>
                  <td className="py-1 text-right">{formatKES(computed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            {t("totals.allowance", { amount: formatKES(match.totals.roundingAllowanceMinor) })}{" "}
            {t("totals.order", {
              order: formatKES(match.totals.orderSubtotalMinor),
              previous: formatKES(match.totals.previouslyInvoicedSubtotalMinor),
              allowed: formatKES(match.totals.allowedSubtotalMinor),
            })}
          </p>
        </section>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("tolerances", {
          qty: match.tolerances.qtyPercent,
          price: match.tolerances.pricePercent,
          etims: match.tolerances.blockWithoutEtims ? t("etimsBlocks") : t("etimsWarns"),
        })}{" "}
        {t("computed", {
          name: match.computedBy.displayName,
          date: formatDateTime(match.computedAt),
          grns: match.grnCount,
        })}
      </p>
    </section>
  );
}
