import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Landmark, Smartphone } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { clientPayResponseSchema } from "@pm-buddy/validation";
import {
  ClientProjectHeader,
  ConversionNote,
  Money,
} from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { certificateTone, currencySearch, parseCurrency } from "@/lib/client-portal";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatCalendarDate } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.pay");
  return { title: t("title") };
}

/**
 * How to pay: the contractor's M-Pesa Paybill (C2B) with the account number for each certificate
 * still owed, bank details when given, and Pay with M-Pesa (STK Push) shown as not available yet
 * (D4.2). A payment shows as received only once the contractor records it.
 */
export default async function ClientPayPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const currency = parseCurrency((await searchParams)["currency"]);
  const path = `/portal/projects/${projectId}/pay`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/pay${currencySearch(currency)}`,
    clientPayResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.pay");
  const { project, instructions, certificates, totals, stk, display } = page.data;
  const today = nairobiDate();
  const route = instructions?.paybillNumber ?? instructions?.tillNumber ?? null;
  return (
    <div className="space-y-6">
      <ClientProjectHeader
        project={project}
        current="pay"
        title={t("title")}
        description={t("description")}
      />
      <ConversionNote display={display} />
      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm text-muted-foreground">{t("outstanding")}</p>
        <p className="text-2xl font-semibold">
          <Money minor={Math.max(totals.outstandingMinor, 0)} display={display} today={today} />
        </p>
        {totals.overdueMinor > 0 ? (
          <StatusBadge tone="danger" className="mt-2">
            {t("overdue")}
          </StatusBadge>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("paybillTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {route ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-2">
                {instructions?.paybillNumber ? (
                  <div>
                    <dt className="text-muted-foreground">{t("paybillNumber")}</dt>
                    <dd className="font-mono text-xl font-semibold">
                      {instructions.paybillNumber}
                    </dd>
                  </div>
                ) : null}
                {instructions?.tillNumber ? (
                  <div>
                    <dt className="text-muted-foreground">{t("tillNumber")}</dt>
                    <dd className="font-mono text-xl font-semibold">{instructions.tillNumber}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-muted-foreground">{t("accountName")}</dt>
                  <dd>{instructions?.accountName}</dd>
                </div>
              </dl>
              <ol className="list-decimal space-y-1 pl-5">
                <li>{t("steps.menu")}</li>
                <li>
                  {instructions?.paybillNumber
                    ? t("steps.paybill", { number: instructions.paybillNumber })
                    : t("steps.till", { number: instructions?.tillNumber ?? "" })}
                </li>
                {instructions?.paybillNumber ? <li>{t("steps.account")}</li> : null}
                <li>{t("steps.amount")}</li>
                <li>{t("steps.pin")}</li>
              </ol>
            </>
          ) : (
            <p className="text-muted-foreground">{t("noInstructions")}</p>
          )}
          {instructions?.bankInstructions ? (
            <div className="flex gap-2 rounded-md border bg-background p-3">
              <Landmark className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <p className="font-medium">{t("bankTitle")}</p>
                <p className="whitespace-pre-wrap">{instructions.bankInstructions}</p>
              </div>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("afterPaying")}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("certificatesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {certificates.length ? (
            <ul className="space-y-3">
              {certificates.map((row) => (
                <li key={row.id} className="space-y-2 rounded-md border bg-background p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">{row.number}</h3>
                    <StatusBadge tone={certificateTone(row.state, row.overdue)}>
                      {row.overdue
                        ? t("overdueSince", { date: formatCalendarDate(row.dueDate) })
                        : t("dueOn", { date: formatCalendarDate(row.dueDate) })}
                    </StatusBadge>
                  </div>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{t("toPay")}</dt>
                      <dd className="font-semibold">
                        <Money minor={row.outstandingMinor} display={display} today={today} />
                      </dd>
                    </div>
                    {row.accountReference && instructions?.paybillNumber ? (
                      <div>
                        <dt className="text-muted-foreground">{t("accountNumber")}</dt>
                        <dd className="font-mono text-base font-semibold">
                          {row.accountReference}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("nothingOwed")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("stkTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Button type="button" disabled aria-describedby="stk-unavailable">
            <Smartphone aria-hidden /> {t("stkButton")}
          </Button>
          <p id="stk-unavailable" role="status" className="rounded-md border bg-background p-3">
            {stk.available ? t("stkAvailable") : t("stkUnavailable")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
