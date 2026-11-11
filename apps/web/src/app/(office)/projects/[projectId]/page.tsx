import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FileSpreadsheet } from "lucide-react";
import { isProjectReadOnly } from "@pm-buddy/domain";
import { projectDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { EditProjectButton } from "@/components/projects/project-form";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusChangeButton } from "@/components/projects/status-change";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { serverApi, requireSession } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";
import { OverviewTab } from "./overview-tab";
import { SitesTab } from "./sites-tab";
import { TeamTab } from "./team-tab";
import { WbsTab } from "./wbs-tab";

const TABS = ["overview", "sites", "team", "wbs"] as const;
type Tab = (typeof TABS)[number];
const PROTOTYPE_IDS = new Set(["ruiru-heights", "kitengela-bungalow"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const t = await getTranslations("projectDetail");
  if (!UUID.test(projectId)) return { title: t("title") };
  const detail = await serverApi(`/projects/${projectId}`, projectDetailResponseSchema);
  return { title: detail.ok ? detail.data.project.name : t("title") };
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  // The D0 prototype detail moved to /prototype/projects/…; keep its old links working.
  if (PROTOTYPE_IDS.has(projectId)) redirect(`/prototype/projects/${projectId}`);
  if (!UUID.test(projectId)) notFound();
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.find((candidate) => candidate === rawTab) ?? "overview";
  const path = `/projects/${projectId}${tab === "overview" ? "" : `?tab=${tab}`}`;

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi(`/projects/${projectId}`, projectDetailResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404) notFound();
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const detail = result.data;
  const { project } = detail;
  const t = await getTranslations("projectDetail");
  const canManage = detail.permissions.includes("projects.manage");
  const canViewBq = detail.permissions.includes("bq.view");
  const readOnly = isProjectReadOnly(project.status);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/projects" className="hover:underline">
              {t("breadcrumb")}
            </Link>
            <span aria-hidden>/</span>
            <span className="font-mono">{project.code}</span>
            <StatusBadge tone="info">{t("live")}</StatusBadge>
          </span>
        }
        title={project.name}
        description={project.description ?? undefined}
        actions={
          <>
            <ProjectStatusBadge status={project.status} />
            {canManage && !readOnly ? <EditProjectButton project={project} /> : null}
            {canManage ? <StatusChangeButton project={project} /> : null}
          </>
        }
      />
      {readOnly ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("readOnly")}
        </p>
      ) : null}
      <nav aria-label={t("sectionsLabel")} className="relative -mx-1 overflow-x-auto">
        <ul className="flex min-w-max gap-1 border-b px-1">
          {TABS.map((key) => (
            <li key={key}>
              <Link
                href={`/projects/${project.id}${key === "overview" ? "" : `?tab=${key}`}`}
                aria-current={key === tab ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                  key === tab
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`tabs.${key}`)}
              </Link>
            </li>
          ))}
          {canViewBq ? (
            <li>
              <Link
                href={`/projects/${project.id}/bq`}
                className="-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                <FileSpreadsheet className="size-4" aria-hidden />
                {t("tabs.bq")}
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>
      {tab === "overview" ? <OverviewTab detail={detail} /> : null}
      {tab === "sites" ? (
        <SitesTab project={project} canManage={canManage && !readOnly} returnTo={path} />
      ) : null}
      {tab === "team" ? <TeamTab project={project} returnTo={path} /> : null}
      {tab === "wbs" ? (
        <WbsTab project={project} canManage={canManage && !readOnly} returnTo={path} />
      ) : null}
    </div>
  );
}
