import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { REQUISITION_STATUSES, type RequisitionStatus } from "@pm-buddy/types";
import { requisitionsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, ListFilters, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { P2pEyebrow, P2pSubnav } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import { isUuid, pickParam, requisitionTone } from "@/lib/p2p";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.requisitions");
  return { title: t("title") };
}

const isStatus = (value: string | undefined): value is RequisitionStatus =>
  (REQUISITION_STATUSES as readonly string[]).includes(value ?? "");

/** Requisitions on projects the caller can see, filtered by project and status (D5.2). */
export default async function RequisitionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const status = isStatus(pickParam(raw, "status")) ? pickParam(raw, "status") : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/procurement/requisitions${apiQuery({ project, status, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/procurement/requisitions${apiQuery({ projectId: project, status, cursor })}`,
      requisitionsResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.requisitions");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status.requisition");
  const { requisitions, page, permissions } = result.data;
  const hrefs = listHrefs("/procurement/requisitions", { project, status }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow />}
        title={t("title")}
        description={t("description")}
        actions={
          permissions.canCreate ? (
            <Button asChild>
              <Link href={`/procurement/requisitions/new${project ? `?project=${project}` : ""}`}>
                <Plus aria-hidden /> {t("new")}
              </Link>
            </Button>
          ) : null
        }
      />
      <P2pSubnav current="requisitions" />
      <ListFilters
        action="/procurement/requisitions"
        projects={projects}
        statuses={REQUISITION_STATUSES.map((value) => ({ value, label: tStatus(value) }))}
        project={project}
        status={status}
      />
      <p className="text-sm text-muted-foreground" role="status">
        {tCommon("count", { count: requisitions.length })}
      </p>
      {requisitions.length === 0 ? (
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
          <table className="w-full min-w-[760px] text-sm">
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
                  {t("cols.neededBy")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.lines")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.raisedBy")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.next")}
                </th>
              </tr>
            </thead>
            <tbody>
              {requisitions.map((row) => (
                <tr key={row.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/procurement/requisitions/${row.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.number}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    <span className="font-mono text-xs">{row.project.code}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.site?.name ?? tCommon("noSite")}
                    </span>
                  </td>
                  <td className="py-2 pr-2">{formatCalendarDate(row.neededBy)}</td>
                  <td className="py-2 pr-2">{t("linesCount", { count: row.lineCount })}</td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={requisitionTone[row.status]}>
                      {tStatus(row.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-2">{row.createdBy.displayName}</td>
                  <td className="py-2 pr-4">
                    {row.rfq ? (
                      <Link href={`/procurement/rfqs/${row.rfq.id}`} className="hover:underline">
                        {row.rfq.number}
                      </Link>
                    ) : (
                      "—"
                    )}
                    {row.lpo ? (
                      <>
                        {" · "}
                        <Link href={`/procurement/lpos/${row.lpo.id}`} className="hover:underline">
                          {row.lpo.number}
                        </Link>
                      </>
                    ) : null}
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
