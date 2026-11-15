import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { JOURNAL_STATUSES, type JournalStatus } from "@pm-buddy/types";
import { journalsResponseSchema } from "@pm-buddy/validation";
import { apiQuery, listHrefs, ListFilters, Pager } from "@/components/procurement/p2p/list-filters";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { JournalForm } from "@/components/spending/journal-form";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession } from "@/lib/server-api";
import { journalTone } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.journals");
  return { title: t("title") };
}

/** Manual cost journals and reversals, each approved by a second finance manager (D5.4). */
export default async function JournalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = isUuid(pickParam(raw, "project")) ? pickParam(raw, "project") : undefined;
  const statusParam = pickParam(raw, "status");
  const status = JOURNAL_STATUSES.includes(statusParam as JournalStatus) ? statusParam : undefined;
  const cursor = isUuid(pickParam(raw, "cursor")) ? pickParam(raw, "cursor") : undefined;
  const path = `/spending/journals${apiQuery({ project, status, cursor })}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, projects] = await Promise.all([
    loadOrRedirect(
      `/cost-journals${apiQuery({ projectId: project, status, cursor, limit: "30" })}`,
      journalsResponseSchema,
      path,
    ),
    projectOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.journals");
  const tStatus = await getTranslations("spending.status");
  const { journals, page, permissions } = result.data;
  const hrefs = listHrefs("/spending/journals", { project, status }, page.nextCursor);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="journals" />
      <ListFilters
        action="/spending/journals"
        projects={projects}
        statuses={JOURNAL_STATUSES.map((value) => ({ value, label: tStatus(`journal.${value}`) }))}
        project={project}
        status={status}
      />
      {journals.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {journals.map((journal) => (
            <li
              key={journal.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <span className="min-w-0">
                <Link
                  href={`/spending/journals/${journal.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {journal.number}
                </Link>{" "}
                · {t(`kinds.${journal.kind}`)} · {journal.project.code}
                <span className="block text-xs text-muted-foreground">
                  {journal.reason} ·{" "}
                  {t("proposedBy", {
                    name: journal.createdBy.displayName,
                    when: formatDateTime(journal.createdAt),
                  })}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums">{formatKES(journal.totalMinor)}</span>
                <StatusBadge tone={journalTone[journal.status]}>
                  {tStatus(`journal.${journal.status}`)}
                </StatusBadge>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pager
        label={t("title")}
        firstHref={hrefs.first}
        nextHref={hrefs.next}
        paged={Boolean(cursor)}
      />
      {permissions.canCreate && projects.length ? <JournalForm projects={projects} /> : null}
    </div>
  );
}
