import { getTranslations } from "next-intl/server";
import { CircleAlert, ShieldCheck } from "lucide-react";
import type { BqResponse } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatKES } from "@/lib/format";

type Bq = NonNullable<BqResponse["bq"]>;
const KIND_ORDER = [
  "measured",
  "preliminaries",
  "pcSums",
  "pcAttendanceProfit",
  "provisionalSums",
  "contingencies",
  "dayworks",
] as const;

/** Grand summary: every bill, the special categories, subtotal, VAT and grand total. */
export async function BqSummaryCard({ bq }: { bq: Bq }) {
  const t = await getTranslations("liveBq.summary");
  const tKinds = await getTranslations("liveBq.kinds");
  const { version } = bq;
  const difference =
    bq.contractSumMinor === null ? null : version.grandTotalMinor - bq.contractSumMinor;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-6 font-medium">
                  {t("bills")}
                </th>
                <th scope="col" className="py-2 pr-6 text-right font-medium">
                  {t("amount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {bq.bills.map((bill) => (
                <tr key={bill.id} className="border-b">
                  <th scope="row" className="py-2 pl-6 text-left font-normal">
                    {t("bill", { number: bill.number, title: bill.title })}{" "}
                    <span className="text-xs text-muted-foreground">({tKinds(bill.kind)})</span>
                  </th>
                  <td className="py-2 pr-6 text-right tabular-nums">
                    {formatKES(bill.totalMinor)}
                  </td>
                </tr>
              ))}
              <tr className="border-b font-medium">
                <th scope="row" className="py-2 pl-6 text-left">
                  {t("subtotal")}
                </th>
                <td className="py-2 pr-6 text-right tabular-nums">
                  {formatKES(version.subtotalMinor)}
                </td>
              </tr>
              <tr className="border-b">
                <th scope="row" className="py-2 pl-6 text-left font-normal">
                  {t("vat", { rate: version.vatRatePercent })}
                  <span className="block text-xs text-muted-foreground">{t("vatReview")}</span>
                </th>
                <td className="py-2 pr-6 text-right tabular-nums">{formatKES(version.vatMinor)}</td>
              </tr>
              <tr className="bg-accent/50 font-semibold">
                <th scope="row" className="py-2 pl-6 text-left">
                  {t("grandTotal")}
                </th>
                <td className="py-2 pr-6 text-right tabular-nums">
                  {formatKES(version.grandTotalMinor)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 className="mt-4 px-6 text-sm font-medium">{t("breakdown")}</h3>
        <dl className="mt-2 grid gap-x-6 gap-y-1 px-6 text-sm sm:grid-cols-2">
          {KIND_ORDER.map((kind) => (
            <div key={kind} className="flex justify-between gap-4 border-b py-1">
              <dt className="text-muted-foreground">{t(`kinds.${kind}`)}</dt>
              <dd className="tabular-nums">{formatKES(bq.byKind[kind])}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-b py-1">
            <dt className="text-muted-foreground">{t("contractSum")}</dt>
            <dd className="tabular-nums">
              {bq.contractSumMinor === null ? t("unavailable") : formatKES(bq.contractSumMinor)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-b py-1">
            <dt className="text-muted-foreground">{t("contractDifference")}</dt>
            <dd className="tabular-nums">
              {difference === null ? t("unavailable") : formatKES(difference)}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Where the version came from: the source file, the validation outcome and row decisions. */
export async function BqSourceCard({ bq }: { bq: Bq }) {
  const t = await getTranslations("liveBq.source");
  const tIssues = await getTranslations("bqIssues.titles");
  const { source } = bq;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("draftNote")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {source ? (
          <>
            <dl className="space-y-1">
              <div>
                <dt className="text-xs text-muted-foreground">{t("file")}</dt>
                <dd className="font-medium break-all">{source.fileName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("committedLabel")}</dt>
                <dd>
                  {t("committed", {
                    date: formatDateTime(source.committedAt),
                    name: source.committedBy.displayName,
                  })}
                </dd>
              </div>
            </dl>
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t("accepted")}</h3>
              {source.accepted.length ? (
                <ul className="space-y-1">
                  {source.accepted.map((entry) => (
                    <li key={entry.code} className="flex gap-2">
                      <CircleAlert
                        className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning"
                        aria-hidden
                      />
                      <span>
                        {tIssues(entry.code)}{" "}
                        <span className="text-muted-foreground">
                          ({source.counts[entry.code] ?? 0}) ·{" "}
                          {t("reason", { reason: entry.reason })}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <ShieldCheck className="size-4 text-success" aria-hidden /> {t("none")}
                </p>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t("overrides")}</h3>
              {source.overrides.length ? (
                <ul className="space-y-2">
                  {source.overrides.map((entry) => (
                    <li key={`${entry.sheet}:${entry.row}`} className="rounded-md border p-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {t("row", { sheet: entry.sheet, row: entry.row })}
                          {entry.ref ? ` · ${entry.ref}` : ""}
                        </span>
                        <StatusBadge tone={entry.action === "exclude" ? "neutral" : "warning"}>
                          {t(`actions.${entry.action}`)}
                        </StatusBadge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {entry.codes.map((code) => tIssues(code)).join(", ")}
                        {entry.reason ? ` · ${t("reason", { reason: entry.reason })}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{t("noOverrides")}</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">{t("unavailable")}</p>
        )}
      </CardContent>
    </Card>
  );
}
