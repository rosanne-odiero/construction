import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { projectsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("quality");
  return { title: t("title") };
}

/** Quality (D6.1): choose a project, or manage the company's checklist templates. */
export default async function QualityPage() {
  const session = await requireSession("/quality");
  if (!session) return <LiveUnavailable retryHref="/quality" />;
  const result = await loadLive("/projects", projectsResponseSchema, "/quality");
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref="/quality" />;
  const t = await getTranslations("quality");
  const tProject = await getTranslations("projectDetail");
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("chooseProject")}
        eyebrow={<StatusBadge tone="info">{tProject("live")}</StatusBadge>}
        actions={
          <Button asChild variant="outline">
            <Link href="/quality/templates">{t("templates.title")}</Link>
          </Button>
        }
      />
      {result.data.projects.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {result.data.projects.map((project) => (
            <li key={project.id}>
              <Link
                className="block rounded-md border p-4 hover:bg-muted"
                href={`/projects/${project.id}?tab=quality`}
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
