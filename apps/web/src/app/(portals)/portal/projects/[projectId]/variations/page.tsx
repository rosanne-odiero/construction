import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { clientVariationsResponseSchema } from "@pm-buddy/validation";
import {
  ClientProjectHeader,
  ConversionNote,
  Money,
} from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { currencySearch, parseCurrency, requestTone } from "@/lib/client-portal";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatDateTime } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.variations");
  return { title: t("title") };
}

/** Variations the contractor sent to the client: waiting for a decision first, then the rest. */
export default async function ClientVariationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const currency = parseCurrency((await searchParams)["currency"]);
  const path = `/portal/projects/${projectId}/variations`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/variations${currencySearch(currency)}`,
    clientVariationsResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.variations");
  const { project, requests, approvalRequired, display } = page.data;
  const today = nairobiDate();
  const ordered = [
    ...requests.filter((row) => row.state === "awaiting_decision"),
    ...requests.filter((row) => row.state !== "awaiting_decision"),
  ];
  return (
    <div className="space-y-6">
      <ClientProjectHeader
        project={project}
        current="variations"
        title={t("title")}
        description={approvalRequired ? t("approvalRequired") : t("approvalNotRequired")}
      />
      <ConversionNote display={display} />
      {ordered.length ? (
        <ul className="space-y-3">
          {ordered.map((row) => (
            <li key={row.id}>
              <Link
                href={`/portal/projects/${project.id}/variations/${row.id}`}
                className="block space-y-2 rounded-xl border bg-card p-4 hover:border-primary"
              >
                <span className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-muted-foreground">
                      {row.number}
                    </span>
                    <span className="block font-semibold break-words">{row.title}</span>
                  </span>
                  <StatusBadge tone={requestTone[row.state]}>
                    {t(`states.${row.state}`)}
                  </StatusBadge>
                </span>
                <span className="grid gap-2 text-sm sm:grid-cols-3">
                  <span>
                    <span className="block text-muted-foreground">{t("effect")}</span>
                    <Money minor={row.grandTotalEffectMinor} display={display} today={today} />
                  </span>
                  <span>
                    <span className="block text-muted-foreground">{t("sentOn")}</span>
                    {formatDateTime(row.sentAt)}
                  </span>
                  <span>
                    <span className="block text-muted-foreground">{t("outcomeLabel")}</span>
                    {t(`outcomes.${row.outcome}`)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
    </div>
  );
}
