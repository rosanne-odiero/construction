import { getTranslations } from "next-intl/server";
import { projectTeamResponseSchema, type Project } from "@pm-buddy/validation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { TeamPanel } from "@/components/projects/team-panel";
import { serverApi } from "@/lib/server-api";

export async function TeamTab({ project, returnTo }: { project: Project; returnTo: string }) {
  const t = await getTranslations("team");
  const result = await serverApi(`/projects/${project.id}/team`, projectTeamResponseSchema);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={returnTo} />;
  return (
    <section aria-labelledby="team-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="team-heading" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <TeamPanel projectId={project.id} team={result.data} />
    </section>
  );
}
