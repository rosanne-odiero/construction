import { getTranslations } from "next-intl/server";
import { isProjectReadOnly } from "@pm-buddy/domain";
import { LiveForbidden } from "@/components/projects/live-state";
import { SiteEditor } from "@/components/projects/site-editor";
import { loadSitePage, SitePageHeader } from "../site-page-shell";

export async function generateMetadata() {
  const t = await getTranslations("sites.editor");
  return { title: t("newTitle") };
}

export default async function NewSitePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const loaded = await loadSitePage(projectId, `/projects/${projectId}/sites/new`);
  if (!loaded.ok) return loaded.element;
  const { detail } = loaded;
  if (!detail.permissions.includes("projects.manage") || isProjectReadOnly(detail.project.status))
    return <LiveForbidden />;
  const t = await getTranslations("sites.editor");
  const { project } = detail;
  return (
    <div className="space-y-6">
      <SitePageHeader detail={detail} title={t("newTitle")} />
      <SiteEditor
        projectId={project.id}
        site={null}
        fallbackCenter={
          project.latitude !== null && project.longitude !== null
            ? { lat: project.latitude, lng: project.longitude }
            : { lat: -1.286389, lng: 36.817223 }
        }
      />
    </div>
  );
}
