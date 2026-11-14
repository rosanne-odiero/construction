import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { safetyOverviewResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/safety";

export async function generateMetadata() {
  const t = await getTranslations("safety");
  return { title: t("title") };
}

/** Health and safety (D8.2): the projects whose records the caller can read and what needs attention. */
export default async function SafetyPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const result = await loadLive("/safety/overview", safetyOverviewResponseSchema, PATH);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  const t = await getTranslations("safety");
  const tProject = await getTranslations("projectDetail");
  const { projects } = result.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("chooseProject")}
        eyebrow={<StatusBadge tone="info">{tProject("live")}</StatusBadge>}
        actions={
          <Button asChild variant="outline">
            <Link href="/safety/settings">{t("settingsLink")}</Link>
          </Button>
        }
      />
      {projects.length ? (
        <ul aria-label={t("overview.label")} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((project) => {
            const alerts = [
              project.openIncidents
                ? {
                    tone: "warning" as const,
                    text: t("overview.openIncidents", { count: project.openIncidents }),
                  }
                : null,
              project.overdueActions
                ? {
                    tone: "danger" as const,
                    text: t("overview.overdueActions", { count: project.overdueActions }),
                  }
                : null,
              project.flaggedLabourers
                ? {
                    tone: "danger" as const,
                    text: t("overview.flagged", { count: project.flaggedLabourers }),
                  }
                : null,
              project.ppeDue
                ? {
                    tone: "warning" as const,
                    text: t("overview.ppeDue", { count: project.ppeDue }),
                  }
                : null,
              project.kitsAttention
                ? {
                    tone: "warning" as const,
                    text: t("overview.kits", { count: project.kitsAttention }),
                  }
                : null,
            ].filter((alert) => alert !== null);
            return (
              <li key={project.id}>
                <Link
                  className="block space-y-2 rounded-md border p-4 hover:bg-muted"
                  href={`/projects/${project.id}?tab=safety`}
                >
                  <span className="block">
                    <span className="mr-2 font-mono text-sm text-muted-foreground">
                      {project.code}
                    </span>
                    <span className="font-medium">{project.name}</span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    {alerts.length ? (
                      alerts.map((alert) => (
                        <StatusBadge
                          key={alert.text}
                          tone={alert.tone}
                          className="h-auto whitespace-normal text-left"
                        >
                          {alert.text}
                        </StatusBadge>
                      ))
                    ) : (
                      <StatusBadge tone="success">{t("overview.allClear")}</StatusBadge>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>{t("noProjects")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("complianceNote")}</p>
    </div>
  );
}
