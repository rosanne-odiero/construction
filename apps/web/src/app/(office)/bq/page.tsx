import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Layers } from "lucide-react";
import { projectsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveUnavailable } from "@/components/projects/live-state";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { Button } from "@/components/ui/button";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("bqIndex");
  return { title: t("title") };
}

/** Entry point for "BQ and variations": each project's BQ pages and the company library. */
export default async function BqIndexPage() {
  const path = "/bq";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi("/projects", projectsResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("bqIndex");
  const tNav = await getTranslations("bqNav");
  const { projects } = result.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild variant="outline">
            <Link href="/rate-buildups">
              <Layers aria-hidden /> {tNav("buildups")}
            </Link>
          </Button>
        }
      />
      {projects.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id} className="space-y-2 rounded-xl border p-4">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{project.code}</span>
                <span className="font-medium">{project.name}</span>
                <ProjectStatusBadge status={project.status} />
              </p>
              <nav aria-label={t("projectLinks", { name: project.name })}>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {(["bq", "variations", "instructions", "versions"] as const).map((section) => (
                    <li key={section}>
                      <Link
                        href={
                          section === "bq"
                            ? `/projects/${project.id}/bq`
                            : `/projects/${project.id}/bq/${section}`
                        }
                        className="underline underline-offset-4"
                      >
                        {tNav(section)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      )}
    </div>
  );
}
