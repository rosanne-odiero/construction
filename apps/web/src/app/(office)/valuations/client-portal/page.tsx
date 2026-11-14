import { getTranslations } from "next-intl/server";
import { fxRatesResponseSchema, paymentInstructionsResponseSchema } from "@pm-buddy/validation";
import { FxRateForm, PaymentInstructionsForm } from "@/components/client-portal/staff-forms";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { formatRate } from "@/lib/client-portal";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";

export async function generateMetadata() {
  const t = await getTranslations("clientSettings");
  return { title: t("title") };
}

/**
 * Client portal settings for the company (D7.1): the Paybill instructions clients follow
 * (config.manage, versioned) and the indicative FX rates finance enters (dated, with a source).
 */
export default async function ClientPortalSettingsPage() {
  const path = "/valuations/client-portal";
  const [instructions, rates] = await Promise.all([
    loadOrRedirect("/client-portal/payment-instructions", paymentInstructionsResponseSchema, path),
    loadOrRedirect("/client-portal/fx-rates", fxRatesResponseSchema, path),
  ]);
  if (!instructions.ok || !rates.ok) {
    const status = !instructions.ok ? instructions.status : !rates.ok ? rates.status : 0;
    return status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("clientSettings");
  const current = instructions.data.instructions;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<ValuationsEyebrow trail={{ href: "/valuations", label: t("back") }} />}
        title={t("title")}
        description={t("description")}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("instructions.title")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {current
              ? t("instructions.version", {
                  version: current.version,
                  name: instructions.data.updatedBy?.displayName ?? "—",
                  at: formatDateTime(current.updatedAt),
                })
              : t("instructions.none")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {instructions.data.permissions.canEdit ? (
            <PaymentInstructionsForm instructions={current} />
          ) : current ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("instructions.paybill")}</dt>
                <dd className="font-mono">{current.paybillNumber ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("instructions.accountName")}</dt>
                <dd>{current.accountName}</dd>
              </div>
            </dl>
          ) : null}
          <p className="rounded-md border bg-muted p-3 text-xs">{t("instructions.stk")}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("rates.title")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("rates.description")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="grid gap-2 sm:grid-cols-3">
            {rates.data.current.map((row) => (
              <li key={row.currency} className="rounded-md border bg-background p-3 text-sm">
                <span className="block font-medium">{row.currency}</span>
                {row.rate ? (
                  <span>
                    {t("rates.current", {
                      rate: formatRate(row.rate.kesPerUnit),
                      currency: row.currency,
                      date: formatCalendarDate(row.rate.rateDate),
                    })}
                  </span>
                ) : (
                  <StatusBadge tone="warning">{t("rates.none")}</StatusBadge>
                )}
              </li>
            ))}
          </ul>
          {rates.data.permissions.canEnter ? <FxRateForm /> : null}
          {rates.data.rates.length ? (
            <div
              role="region"
              aria-label={t("rates.history")}
              tabIndex={0}
              className="overflow-x-auto"
            >
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="sr-only">{t("rates.history")}</caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t("rates.date")}
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t("rates.currency")}
                    </th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">
                      {t("rates.kesPerUnit")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("rates.source")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rates.data.rates.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">{formatCalendarDate(row.rateDate)}</td>
                      <td className="py-2 pr-3">{row.currency}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatRate(row.kesPerUnit)}
                      </td>
                      <td className="py-2">
                        {row.source}
                        <span className="block text-xs text-muted-foreground">
                          {row.enteredBy?.displayName ?? "—"} · {formatDateTime(row.enteredAt)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
