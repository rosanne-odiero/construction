import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight, ClipboardList, Receipt, Settings, Truck } from "lucide-react";
import {
  commitmentsResponseSchema,
  inboxResponseSchema,
  invoicesResponseSchema,
  lposResponseSchema,
  requisitionsResponseSchema,
  rfqsResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { P2pEyebrow, P2pSubnav } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatKES } from "@/lib/format";
import { loadOrRedirect, projectOptions, stageCount } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.home");
  return { title: t("title") };
}

const page = (data: { page: { hasMore: boolean } }, items: unknown[]) => ({
  count: items.length,
  more: data.page.hasMore,
});

/**
 * Procurement home (D5.2): what is waiting for the signed-in user (the API's inbox: only what
 * they may act on, maker-checker applied), counts per stage, and committed, accrued and paid
 * cost per project.
 */
export default async function ProcurementPage() {
  const path = "/procurement";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const inbox = await loadOrRedirect("/procurement/inbox", inboxResponseSchema, path);
  if (!inbox.ok)
    return inbox.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const q = "limit=200";
  const [stages, projects] = await Promise.all([
    Promise.all([
      stageCount(
        `/procurement/requisitions?status=submitted&${q}`,
        requisitionsResponseSchema,
        (data) => page(data, data.requisitions),
      ),
      stageCount(
        `/procurement/requisitions?status=approved&${q}`,
        requisitionsResponseSchema,
        (data) => page(data, data.requisitions),
      ),
      stageCount(`/procurement/rfqs?status=open&${q}`, rfqsResponseSchema, (data) =>
        page(data, data.rfqs),
      ),
      stageCount(`/procurement/lpos?status=submitted&${q}`, lposResponseSchema, (data) =>
        page(data, data.lpos),
      ),
      stageCount(`/procurement/lpos?status=approved&${q}`, lposResponseSchema, (data) =>
        page(data, data.lpos),
      ),
      stageCount(`/procurement/invoices?status=disputed&${q}`, invoicesResponseSchema, (data) =>
        page(data, data.invoices),
      ),
      stageCount(`/procurement/invoices?status=matched&${q}`, invoicesResponseSchema, (data) =>
        page(data, data.invoices),
      ),
      stageCount(`/procurement/invoices?status=approved&${q}`, invoicesResponseSchema, (data) =>
        page(data, data.invoices),
      ),
      stageCount(
        `/procurement/invoices?status=partly_settled&${q}`,
        invoicesResponseSchema,
        (data) => page(data, data.invoices),
      ),
    ]),
    projectOptions(),
  ]);
  const commitments = (
    await Promise.all(
      projects.slice(0, 30).map(async (project) => {
        const result = await serverApi(
          `/procurement/commitments?projectId=${project.id}`,
          commitmentsResponseSchema,
        );
        return result.ok ? result.data : null;
      }),
    )
  ).filter(
    (entry): entry is NonNullable<typeof entry> =>
      entry !== null &&
      (entry.totals.committedMinor > 0 ||
        entry.totals.accruedMinor > 0 ||
        entry.totals.paidMinor > 0),
  );
  const t = await getTranslations("p2p.home");
  const stageKeys = [
    ["requisitionsSubmitted", "/procurement/requisitions?status=submitted"],
    ["requisitionsApproved", "/procurement/requisitions?status=approved"],
    ["rfqsOpen", "/procurement/rfqs?status=open"],
    ["lposSubmitted", "/procurement/lpos?status=submitted"],
    ["lposApproved", "/procurement/lpos?status=approved"],
    ["invoicesDisputed", "/procurement/invoices?status=disputed"],
    ["invoicesMatched", "/procurement/invoices?status=matched"],
    ["invoicesApproved", "/procurement/invoices?status=approved"],
    ["invoicesPartly", "/procurement/invoices?status=partly_settled"],
  ] as const;
  const { items } = inbox.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow />}
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button asChild>
              <Link href="/procurement/requisitions/new">
                <ClipboardList aria-hidden /> {t("start.requisition")}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/procurement/grns/new">
                <Truck aria-hidden /> {t("start.delivery")}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/procurement/invoices/new">
                <Receipt aria-hidden /> {t("start.invoice")}
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/catalogue/alerts#procurement-settings">
                <Settings aria-hidden /> {t("start.settings")}
              </Link>
            </Button>
          </>
        }
      />
      <P2pSubnav current="home" />

      <Card data-testid="inbox">
        <CardHeader>
          <CardTitle>
            <h2>{t("inboxTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("inboxDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {items.length ? (
            <ul className="divide-y">
              {items.map((item) => (
                <li
                  key={`${item.kind}-${item.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                >
                  <StatusBadge
                    tone={
                      item.kind === "invoice-exception" || item.kind === "invoice-reapproval"
                        ? "danger"
                        : item.kind === "invoice-settlement"
                          ? "success"
                          : "info"
                    }
                  >
                    {t(`kinds.${item.kind}`)}
                  </StatusBadge>
                  <Link href={item.href} className="font-medium underline underline-offset-4">
                    {item.label}
                  </Link>
                  <span className="text-muted-foreground">
                    {item.project.code}
                    {item.supplier ? ` · ${item.supplier.name}` : ""}
                  </span>
                  {item.amountMinor !== null ? (
                    <span className="tabular-nums">{formatKES(item.amountMinor)}</span>
                  ) : null}
                  <span className="text-xs text-muted-foreground sm:ml-auto">
                    {t("since", { date: formatDate(item.since) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("inboxEmpty")}</p>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="stages" className="space-y-3">
        <h2 id="stages" className="text-base font-semibold">
          {t("stagesTitle")}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="stages">
          {stageKeys.map(([key, href], index) => {
            const stage = stages[index];
            return (
              <li key={key}>
                <Link
                  href={href}
                  className="flex items-center justify-between gap-3 rounded-xl border p-4 text-sm hover:bg-muted/50"
                >
                  <span>{t(`stages.${key}`)}</span>
                  <span className="flex items-center gap-2 text-lg font-semibold tabular-nums">
                    {stage ? (stage.more ? t("many", { count: stage.count }) : stage.count) : "—"}
                    <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="commitments" className="space-y-2">
        <h2 id="commitments" className="text-base font-semibold">
          {t("commitmentsTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("commitmentsDescription")}</p>
        {commitments.length ? (
          <div
            role="region"
            tabIndex={0}
            aria-label={t("commitmentsTitle")}
            className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <table className="w-full min-w-[640px] text-sm" data-testid="commitments">
              <caption className="sr-only">{t("commitmentsTitle")}</caption>
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pl-4 font-medium">
                    {t("cols.project")}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t("cols.committed")}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t("cols.accrued")}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t("cols.open")}
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    {t("cols.paid")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {commitments.map((entry) => (
                  <tr key={entry.project.id} className="border-b last:border-0">
                    <th scope="row" className="py-2 pl-4 text-left font-medium">
                      <Link
                        href={`/procurement/lpos?project=${entry.project.id}`}
                        className="hover:underline"
                      >
                        <span className="font-mono text-xs">{entry.project.code}</span> ·{" "}
                        {entry.project.name}
                      </Link>
                    </th>
                    <td className="py-2 text-right tabular-nums">
                      {formatKES(entry.totals.committedMinor)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatKES(entry.totals.accruedMinor)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatKES(entry.totals.openCommitmentMinor)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatKES(entry.totals.paidMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noCommitments")}</p>
        )}
      </section>
    </div>
  );
}
