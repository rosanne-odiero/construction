import { getTranslations } from "next-intl/server";
import { clientPreferencesResponseSchema } from "@pm-buddy/validation";
import { CurrencyForm } from "@/components/client-portal/client-forms";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatRate } from "@/lib/client-portal";
import { formatCalendarDate } from "@/lib/format";

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.settings");
  return { title: t("title") };
}

/** The client's display currency, with the rates finance entered and what "indicative" means. */
export default async function ClientSettingsPage() {
  const page = await loadClientPage(
    "/portal/settings",
    "/portal/client/preferences",
    clientPreferencesResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref="/portal/settings" />;
  const t = await getTranslations("clientPortal.settings");
  const { displayCurrency, rates } = page.data;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("currency")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <CurrencyForm current={displayCurrency} />
          <p className="rounded-md border bg-muted p-3 text-sm">{t("disclaimer")}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("ratesTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("ratesDescription")}</p>
        </CardHeader>
        <CardContent>
          {rates.length ? (
            <ul className="space-y-3 text-sm">
              {rates.map((rate) => (
                <li key={rate.id} className="flex flex-wrap items-start justify-between gap-2">
                  <span>
                    <span className="block font-medium">
                      {t("rate", {
                        currency: rate.currency,
                        rate: formatRate(rate.kesPerUnit),
                        date: formatCalendarDate(rate.rateDate),
                      })}
                    </span>
                    <span className="text-muted-foreground">{rate.source}</span>
                  </span>
                  {rate.usable ? null : <StatusBadge tone="warning">{t("stale")}</StatusBadge>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noRates")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
