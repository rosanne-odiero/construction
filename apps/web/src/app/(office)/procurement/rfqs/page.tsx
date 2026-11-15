import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { RFQ_STATUSES, type RfqStatus } from "@pm-buddy/types";
import { rfqsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, ListFilters, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { P2pEyebrow, P2pSubnav } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { isUuid, pickParam, rfqTone } from "@/lib/p2p";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.rfqs");
  return { title: t("title") };
}

const isStatus = (value: string | undefined): value is RfqStatus =>
  (RFQ_STATUSES as readonly string[]).includes(value ?? "");

/** Requests for quotation on projects the caller can see (D5.2). */
export default async function RfqsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const status = isStatus(pickParam(raw, "status")) ? pickParam(raw, "status") : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/procurement/rfqs${apiQuery({ project, status, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/procurement/rfqs${apiQuery({ projectId: project, status, cursor })}`,
      rfqsResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.rfqs");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status.rfq");
  const tException = await getTranslations("p2p.status.exception");
  const { rfqs, page, permissions } = result.data;
  const hrefs = listHrefs("/procurement/rfqs", { project, status }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow />}
        title={t("title")}
        description={t("description")}
        actions={
          permissions.canCreate ? (
            <Button asChild>
              <Link href={`/procurement/rfqs/new${project ? `?project=${project}` : ""}`}>
                <Plus aria-hidden /> {t("new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <P2pSubnav current="rfqs" />
      <ListFilters
        action="/procurement/rfqs"
        projects={projects}
        statuses={RFQ_STATUSES.map((value) => ({ value, label: tStatus(value) }))}
        project={project}
        status={status}
      />
      <p className="text-sm text-muted-foreground" role="status">
        {tCommon("count", { count: rfqs.length })}
      </p>
      {rfqs.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">
          {project || status ? tCommon("noMatches") : tCommon("empty")}
        </p>
      ) : (
        <div
          role="region"
          tabIndex={0}
          aria-label={t("title")}
          className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.number")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.project")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.requisitions")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.quotations")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.lpo")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((row) => (
                <tr key={row.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/procurement/rfqs/${row.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.number}
                    </Link>
                  </th>
                  <td className="py-2 pr-2 font-mono text-xs">{row.project.code}</td>
                  <td className="py-2 pr-2">
                    {row.requisitions.map((entry) => entry.number).join(", ")}
                  </td>
                  <td className="py-2 pr-2 tabular-nums">
                    {row.quotationCount} / {row.suppliers.length}
                  </td>
                  <td className="py-2 pr-2">
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge tone={rfqTone[row.status]}>{tStatus(row.status)}</StatusBadge>
                      {row.exception.status !== "none" ? (
                        <StatusBadge
                          tone={row.exception.status === "approved" ? "success" : "warning"}
                        >
                          {tException(row.exception.status)}
                        </StatusBadge>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    {row.lpo ? (
                      <Link href={`/procurement/lpos/${row.lpo.id}`} className="hover:underline">
                        {row.lpo.number}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label={t("title")}
        firstHref={hrefs.first}
        nextHref={hrefs.next}
        paged={Boolean(cursor)}
      />
    </div>
  );
}
