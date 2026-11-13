import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { PageHeader } from "@/components/page-header";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RequisitionForm } from "@/components/procurement/p2p/requisition-form";
import { LiveUnavailable } from "@/components/projects/live-state";
import { isUuid, pickParam } from "@/lib/p2p";
import { projectOptions, sitesByProject, unitOptions } from "@/lib/p2p-server";
import { materialPicker } from "@/lib/procurement-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.requisitions.form");
  return { title: t("newTitle") };
}

/** Raise a requisition (D5.2). */
export default async function NewRequisitionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = pickParam(raw, "project");
  const path = "/procurement/requisitions/new";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [projects, materials, units] = await Promise.all([
    projectOptions(),
    materialPicker(),
    unitOptions(),
  ]);
  const sites = await sitesByProject(projects.map((entry) => entry.id));
  const t = await getTranslations("p2p.requisitions");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/requisitions", label: t("title") }} />}
        title={t("form.newTitle")}
        description={t("form.description")}
      />
      <RequisitionForm
        projects={projects}
        sites={sites}
        materials={materials}
        units={units}
        defaultProjectId={isUuid(project) ? project : undefined}
        today={nairobiDate()}
      />
    </div>
  );
}
