import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { nairobiDate } from "@pm-buddy/domain";
import { clientVariationDetailResponseSchema } from "@pm-buddy/validation";
import { DecisionForm } from "@/components/client-portal/client-forms";
import {
  ClientProjectHeader,
  ConversionNote,
  Money,
} from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currencySearch, parseCurrency, requestTone } from "@/lib/client-portal";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatDateTime, formatDecimalString, formatKES } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.variations");
  return { title: t("detailTitle") };
}

/**
 * One variation as it was sent to the client: its lines (quantities, contract rates, amounts),
 * totals and the change to the contract sum, frozen when sent. The client approves or rejects it
 * once, on these figures.
 */
export default async function ClientVariationPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, requestId } = await params;
  if (!UUID.test(projectId) || !UUID.test(requestId)) notFound();
  const currency = parseCurrency((await searchParams)["currency"]);
  const path = `/portal/projects/${projectId}/variations/${requestId}`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/variations/${requestId}${currencySearch(currency)}`,
    clientVariationDetailResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.variations");
  const { project, request, display, approvalRequired } = page.data;
  const { view } = request;
  const today = nairobiDate();
  return (
    <div className="space-y-6">
      <ClientProjectHeader
        project={project}
        current="variations"
        title={`${view.number} · ${view.title}`}
      />
      <Link
        href={`/portal/projects/${project.id}/variations`}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t("all")}
      </Link>
      <ConversionNote display={display} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={requestTone[request.state]}>{t(`states.${request.state}`)}</StatusBadge>
        <span className="text-sm text-muted-foreground">
          {t("sentOnLine", { date: formatDateTime(request.sentAt) })} ·{" "}
          {t(`outcomes.${request.outcome}`)}
        </span>
      </div>
      {view.description ? <p className="whitespace-pre-wrap">{view.description}</p> : null}
      <p className="text-sm text-muted-foreground">
        {t("instruction", { number: view.instruction.number, subject: view.instruction.subject })}
      </p>
      {request.message ? (
        <blockquote className="rounded-md border-l-4 bg-background p-3 text-sm whitespace-pre-wrap">
          {t("message")}: {request.message}
        </blockquote>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("linesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {view.lines.map((line) => (
              <li
                key={line.lineNo}
                className="space-y-1 rounded-md border bg-background p-3 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-xs text-muted-foreground">
                      {t(`actions.${line.action}`)}
                      {line.ref ? ` · ${line.ref}` : ""}
                    </span>
                    <span className="block break-words">{line.description}</span>
                  </span>
                  <span className="text-right font-semibold tabular-nums">
                    {line.deltaMinor >= 0 ? "+" : ""}
                    {formatKES(line.deltaMinor)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {line.quantity !== null && line.rate !== null
                    ? t("quantityRate", {
                        quantity: formatDecimalString(line.quantity),
                        unit: line.unit ?? "",
                        rate: formatDecimalString(line.rate),
                      })
                    : t("amountOnly")}
                  {" · "}
                  {t("beforeAfter", {
                    before: formatKES(line.baseAmountMinor),
                    after: formatKES(line.newAmountMinor),
                  })}
                </p>
              </li>
            ))}
          </ul>
          <dl className="mt-4 grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("net")}</dt>
              <dd className="font-semibold">{formatKES(view.totals.netMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t("effectWithVat", { percent: view.vatRatePercent })}
              </dt>
              <dd className="font-semibold">
                <Money minor={view.grandTotalEffectMinor} display={display} today={today} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("contractBefore")}</dt>
              <dd>{formatKES(view.baseGrandTotalMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("contractAfter")}</dt>
              <dd>{formatKES(view.projectedGrandTotalMinor)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("decisionTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {approvalRequired ? t("approvalRequired") : t("approvalNotRequired")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {request.decision ? (
            <div className="space-y-1">
              <p className="font-medium">
                {t("decidedBy", {
                  decision: t(`states.${request.decision.decision}`),
                  name: request.decision.decidedBy.displayName,
                  date: formatDateTime(request.decision.decidedAt),
                })}
              </p>
              {request.decision.comment ? (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {request.decision.comment}
                </p>
              ) : null}
            </div>
          ) : request.canDecide ? (
            <DecisionForm
              projectId={project.id}
              requestId={request.id}
              clientDigest={request.clientDigest}
            />
          ) : (
            <p>{t("closed")}</p>
          )}
          <p className="text-xs break-all text-muted-foreground">
            {t("digest", { digest: request.clientDigest.slice(0, 16) })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
