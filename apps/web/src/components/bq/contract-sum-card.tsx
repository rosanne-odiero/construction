import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Scale } from "lucide-react";
import type { BqContractSumResponse } from "@pm-buddy/validation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatKES } from "@/lib/format";

/**
 * Original vs revised contract sum (grand totals with VAT): original is the approved baseline,
 * revised the newest approved version; submitted variations are shown apart as pending and are
 * never added into the revised sum. Anything not defined yet shows "unavailable".
 */
export async function ContractSumCard({
  sums,
  projectId,
}: {
  sums: BqContractSumResponse | null;
  projectId: string;
}) {
  const t = await getTranslations("contractSum");
  const unavailable = <span className="text-muted-foreground">{t("unavailable")}</span>;
  const money = (value: number | null) => (value === null ? unavailable : formatKES(value));
  const rows: { key: string; label: string; value: React.ReactNode; strong?: boolean }[] = sums
    ? [
        { key: "original", label: t("original"), value: money(sums.originalMinor) },
        {
          key: "approved",
          label: t("approvedVariations", { count: sums.approvedCount }),
          value: money(sums.approvedVariationsMinor),
        },
        { key: "revised", label: t("revised"), value: money(sums.revisedMinor), strong: true },
        {
          key: "pending",
          label: t("pending", { count: sums.pendingCount }),
          value: formatKES(sums.pendingMinor),
        },
      ]
    : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="size-4" aria-hidden />
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>
          {sums?.vatRatePercent ? t("vatNote", { rate: sums.vatRatePercent }) : t("description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!sums ? (
          <p className="text-muted-foreground">{t("noAccess")}</p>
        ) : sums.status === "no-bq" ? (
          <p className="text-muted-foreground">{t("noBq")}</p>
        ) : sums.status === "draft" ? (
          <p role="status" className="rounded-md border bg-muted p-2 text-xs">
            {t("draftNote", {
              total: sums.draftTotalMinor === null ? "—" : formatKES(sums.draftTotalMinor),
            })}
          </p>
        ) : (
          <>
            <dl className="space-y-1">
              {rows.map((row) => (
                <div
                  key={row.key}
                  data-testid={`contract-sum-${row.key}`}
                  className={`flex justify-between gap-4 border-b py-1 ${row.strong ? "font-semibold" : ""}`}
                >
                  <dt className={row.strong ? "" : "text-muted-foreground"}>{row.label}</dt>
                  <dd className="text-right tabular-nums">{row.value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">{t("pendingNote")}</p>
            {sums.currentVersionNo !== null ? (
              <p className="text-xs">
                <Link
                  href={`/projects/${projectId}/bq/versions`}
                  className="underline underline-offset-4"
                >
                  {t("currentVersion", { version: sums.currentVersionNo })}
                </Link>
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
