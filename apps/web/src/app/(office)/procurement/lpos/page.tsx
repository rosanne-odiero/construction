import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LPO_STATUSES, type LpoStatus } from "@pm-buddy/types";
import { lposResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, ListFilters, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { P2pEyebrow, P2pSubnav } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatKES } from "@/lib/format";
import { deliveryTone, isUuid, lpoTone, pickParam } from "@/lib/p2p";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.lpos");
  return { title: t("title") };
}

const isStatus = (value: string | undefined): value is LpoStatus =>
  (LPO_STATUSES as readonly string[]).includes(value ?? "");

/** LPOs on projects the caller can see, with their delivery progress (D5.2). */
export default async function LposPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const status = isStatus(pickParam(raw, "status")) ? pickParam(raw, "status") : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/procurement/lpos${apiQuery({ project, status, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/procurement/lpos${apiQuery({ projectId: project, status, cursor })}`,
      lposResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.lpos");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status");
  const { lpos, page } = result.data;
  const hrefs = listHrefs("/procurement/lpos", { project, status }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<P2pEyebrow />} title={t("title")} description={t("description")} />
      <P2pSubnav current="lpos" />
      <ListFilters
        action="/procurement/lpos"
        projects={projects}
        statuses={LPO_STATUSES.map((value) => ({ value, label: tStatus(`lpo.${value}`) }))}
        project={project}
        status={status}
      />
      <p className="text-sm text-muted-foreground" role="status">
        {tCommon("count", { count: lpos.length })}
      </p>
      {lpos.length === 0 ? (
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
                  {t("cols.supplier")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.delivery")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.deliveryDate")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.total")}
                </th>
              </tr>
            </thead>
            <tbody>
              {lpos.map((row) => (
                <tr key={row.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/procurement/lpos/${row.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.number}
                    </Link>
                  </th>
                  <td className="py-2 pr-2 font-mono text-xs">{row.project.code}</td>
                  <td className="py-2 pr-2">{row.supplier.name}</td>
                  <td className="py-2 pr-2">
                    <StatusBadge tone={lpoTone[row.status]}>
                      {tStatus(`lpo.${row.status}`)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 pr-2">
                    {row.status === "approved" ? (
                      <StatusBadge tone={deliveryTone[row.deliveryState]}>
                        {tStatus(`delivery.${row.deliveryState}`)}
                      </StatusBadge>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    {row.deliveryDate ? formatCalendarDate(row.deliveryDate) : "—"}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatKES(row.totalMinor)}</td>
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
