import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Settings2 } from "lucide-react";
import {
  accreditationAlertsResponseSchema,
  documentsOverviewResponseSchema,
} from "@pm-buddy/validation";
import { ComplianceStatusBadge } from "@/components/documents/compliance-status";
import { ReminderList } from "@/components/documents/reminder-list";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { complianceTypeLabel } from "@/lib/documents";
import { formatCalendarDate } from "@/lib/format";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

const PATH = "/documents";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("title") };
}

/**
 * Documents and compliance across the company (D8.4): the "expiring soon" list for every project
 * the caller can read, the company-level items, and each project's documents and register.
 */
export default async function DocumentsPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const [result, accreditation] = await Promise.all([
    loadLive(PATH, documentsOverviewResponseSchema, PATH),
    serverApi("/labour/accreditation-alerts", accreditationAlertsResponseSchema),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  const t = await getTranslations("documents");
  const tProject = await getTranslations("projectDetail");
  const { projects, companyItems, reminders, today } = result.data;
  const label = (type: { key: string; label: string | null }) =>
    complianceTypeLabel(type, (key) => t(key as never));
  const alerts = accreditation.ok ? accreditation.data.alerts : null;
  const alertCount = (kind: "expired" | "expiring" | "missing") =>
    alerts?.filter((alert) => alert.kind === kind).length ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
        eyebrow={<StatusBadge tone="info">{tProject("live")}</StatusBadge>}
        actions={
          <Button asChild variant="outline">
            <Link href="/documents/compliance-types">
              <Settings2 className="size-4" aria-hidden />
              {t("overview.typesLink")}
            </Link>
          </Button>
        }
      />

      <section aria-labelledby="reminders-heading" className="space-y-2">
        <h2 id="reminders-heading" className="text-lg font-semibold">
          {t("overview.remindersTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("overview.remindersHint")}{" "}
          <span className="tabular-nums">{formatCalendarDate(today)}</span>
        </p>
        <ReminderList reminders={reminders} showProject emptyText={t("overview.remindersEmpty")} />
        {alerts && alerts.length ? (
          <p className="rounded-md border p-3 text-sm" data-testid="accreditation-alerts">
            <span className="font-medium">{t("overview.accreditationsTitle")}: </span>
            {t("overview.accreditations", {
              expired: alertCount("expired"),
              expiring: alertCount("expiring"),
              missing: alertCount("missing"),
            })}{" "}
            <Link className="underline" href="/labour/alerts">
              {t("overview.accreditationsLink")}
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="company-heading" className="space-y-2">
        <h2 id="company-heading" className="text-lg font-semibold">
          {t("overview.companyTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("overview.companyHint")}</p>
        <div className="relative overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="company-items">
            <caption className="sr-only">{t("overview.companyTitle")}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-2 font-medium">
                  {t("overview.cols.item")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("overview.cols.status")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.reference")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.expires")}
                </th>
              </tr>
            </thead>
            <tbody>
              {companyItems.map((item) => (
                <tr key={item.type.id} className="border-t align-top" data-status={item.status}>
                  <th scope="row" className="p-2 text-left font-medium">
                    <Link
                      className="underline-offset-2 hover:underline"
                      href={`/documents/company/${item.type.id}`}
                    >
                      {label(item.type)}
                    </Link>
                  </th>
                  <td className="p-2">
                    <ComplianceStatusBadge status={item.status}>
                      {t(`complianceStatuses.${item.status}`)}
                    </ComplianceStatusBadge>
                  </td>
                  <td className="p-2">{item.current?.referenceNo ?? "—"}</td>
                  <td className="p-2 tabular-nums">
                    {item.current?.expiresOn ? formatCalendarDate(item.current.expiresOn) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="projects-heading" className="space-y-2">
        <h2 id="projects-heading" className="text-lg font-semibold">
          {t("overview.projectsTitle")}
        </h2>
        {projects.length ? (
          <div className="relative overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="document-projects">
              <caption className="sr-only">{t("overview.projectsTitle")}</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {t("overview.cols.project")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("overview.cols.documents")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("overview.cols.compliance")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("overview.cols.instructions")}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t("overview.cols.approvals")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} className="border-t align-top">
                    <th scope="row" className="p-2 text-left font-medium">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/projects/${project.id}?tab=documents`}
                      >
                        <span className="font-mono">{project.code}</span> · {project.name}
                      </Link>
                    </th>
                    <td className="p-2 tabular-nums">
                      {t("summary.documents", project.summary.documents)}
                    </td>
                    <td className="p-2">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/projects/${project.id}?tab=compliance`}
                      >
                        {t("overview.complianceCounts", project.summary.compliance)}
                      </Link>
                    </td>
                    <td className="p-2 tabular-nums">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/projects/${project.id}?tab=instructions`}
                      >
                        {project.summary.instructions.open}
                      </Link>
                    </td>
                    <td className="p-2 tabular-nums">
                      {project.summary.approvals.overdue ? (
                        <StatusBadge tone="danger">{project.summary.approvals.overdue}</StatusBadge>
                      ) : (
                        "0"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("overview.projectsEmpty")}</p>
        )}
      </section>
    </div>
  );
}
