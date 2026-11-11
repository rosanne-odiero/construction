import { milestonesResponseSchema, wbsResponseSchema, type Project } from "@pm-buddy/validation";
import { LiveUnavailable } from "@/components/projects/live-state";
import { MilestonesPanel } from "@/components/projects/milestones-panel";
import { WbsPanel } from "@/components/projects/wbs-panel";
import { loadLive } from "@/lib/server-api";

export async function WbsTab({
  project,
  canManage,
  returnTo,
}: {
  project: Project;
  canManage: boolean;
  returnTo: string;
}) {
  const [wbs, milestones] = await Promise.all([
    loadLive(`/projects/${project.id}/wbs`, wbsResponseSchema, returnTo),
    loadLive(`/projects/${project.id}/milestones`, milestonesResponseSchema, returnTo),
  ]);
  if (!wbs.ok || !milestones.ok) return <LiveUnavailable retryHref={returnTo} />;
  return (
    <div className="grid gap-6 2xl:grid-cols-2">
      <WbsPanel projectId={project.id} wbs={wbs.data} canManage={canManage} />
      <MilestonesPanel
        projectId={project.id}
        milestones={milestones.data.milestones}
        nodes={wbs.data.nodes}
        canManage={canManage}
      />
    </div>
  );
}
