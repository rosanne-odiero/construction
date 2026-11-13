import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Truck } from "lucide-react";
import { grnsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { apiQuery, listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { P2pEyebrow, P2pSubnav } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { grnTone, isUuid, locationTone, pickParam } from "@/lib/p2p";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.grns");
  return { title: t("title") };
}

const selectClass =
  "h-9 max-w-[16rem] rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Goods Received Notes on projects the caller can see (D5.2). */
export default async function GrnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const lpo = isUuid(pickParam(raw, "lpo")) ? pickParam(raw, "lpo") : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/procurement/grns${apiQuery({ project, lpo, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/procurement/grns${apiQuery({ projectId: project, lpoId: lpo, cursor })}`,
      grnsResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.grns");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status");
  const { grns, page } = result.data;
  const hrefs = listHrefs("/procurement/grns", { project, lpo }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow />}
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild>
            <Link href="/procurement/grns/new">
              <Truck aria-hidden /> {t("new")}
            </Link>
          </Button>
        }
      />
      <P2pSubnav current="grns" />
      <form
        method="get"
        action="/procurement/grns"
        className="flex flex-wrap items-end gap-3"
        role="search"
      >
        <div className="space-y-1.5">
          <label htmlFor="grn-filter-project" className="block text-sm font-medium">
            {tCommon("project")}
          </label>
          <select
            id="grn-filter-project"
            name="project"
            defaultValue={project ?? ""}
            className={selectClass}
          >
            <option value="">{tCommon("allProjects")}</option>
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {tCommon("apply")}
        </Button>
        {project || lpo ? (
          <Button asChild variant="ghost">
            <Link href="/procurement/grns">{tCommon("clear")}</Link>
          </Button>
        ) : null}
      </form>
      <p className="text-sm text-muted-foreground" role="status">
        {tCommon("count", { count: grns.length })}
      </p>
      {grns.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center font-medium">
          {project || lpo ? tCommon("noMatches") : tCommon("empty")}
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
                  {t("cols.lpo")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.supplier")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.received")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.location")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {grns.map((row) => (
                <tr key={row.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link
                      href={`/procurement/grns/${row.id}`}
                      className="underline underline-offset-4"
                    >
                      {row.number}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">
                    <Link href={`/procurement/lpos/${row.lpo.id}`} className="hover:underline">
                      {row.lpo.number}
                    </Link>
                  </td>
                  <td className="py-2 pr-2">{row.supplier.name}</td>
                  <td className="py-2 pr-2">{formatDateTime(row.receivedAt)}</td>
                  <td className="py-2 pr-2">
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge tone={locationTone[row.location.state]}>
                        {tStatus(`location.${row.location.state}`)}
                      </StatusBadge>
                      {row.overDelivery ? (
                        <StatusBadge tone="warning">{t("overDelivery")}</StatusBadge>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <StatusBadge tone={grnTone[row.status]}>
                      {tStatus(`grn.${row.status}`)}
                    </StatusBadge>
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
