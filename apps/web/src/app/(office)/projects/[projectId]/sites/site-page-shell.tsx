import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { projectDetailResponseSchema, type ProjectDetailResponse } from "@pm-buddy/validation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session, project and permission checks shared by the site pages. */
export async function loadSitePage(
  projectId: string,
  path: string,
): Promise<
  { ok: true; detail: ProjectDetailResponse } | { ok: false; element: React.ReactElement }
> {
  if (!UUID.test(projectId)) notFound();
  const session = await requireSession(path);
  if (!session) return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  const result = await serverApi(`/projects/${projectId}`, projectDetailResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404) notFound();
    if (result.status === 403) return { ok: false, element: <LiveForbidden /> };
    return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  }
  return { ok: true, detail: result.data };
}

export async function SitePageHeader({
  detail,
  title,
}: {
  detail: ProjectDetailResponse;
  title: string;
}) {
  const t = await getTranslations("projectDetail");
  const tSites = await getTranslations("sites");
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:underline">
          {t("breadcrumb")}
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/projects/${detail.project.id}?tab=sites`} className="hover:underline">
          {detail.project.name}
        </Link>
        <span aria-hidden>/</span>
        <span>{tSites("title")}</span>
        <StatusBadge tone="info">{t("live")}</StatusBadge>
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    </div>
  );
}
