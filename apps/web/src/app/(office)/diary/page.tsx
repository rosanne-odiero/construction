import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { projectsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("liveDiary");
  return { title: t("title") };
}

export default async function DiaryPage() {
  const session = await requireSession("/diary");
  if (!session) return <LiveUnavailable retryHref="/diary" />;
  const result = await loadLive("/projects", projectsResponseSchema, "/diary");
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref="/diary" />;
  const t = await getTranslations("liveDiary");
  const tProject = await getTranslations("projectDetail");
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("chooseProject")}
        eyebrow={<StatusBadge tone="info">{tProject("live")}</StatusBadge>}
      />
      {result.data.projects.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {result.data.projects.map((project) => (
            <li key={project.id}>
              <Link
                className="block rounded-md border p-4 hover:bg-muted"
                href={`/projects/${project.id}?tab=diary`}
              >
                <span className="mr-2 font-mono text-sm text-muted-foreground">{project.code}</span>
                <span className="font-medium">{project.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("noProjects")}</p>
      )}
    </div>
  );
}
