import { getTranslations } from "next-intl/server";
import { requisitionsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RfqForm } from "@/components/procurement/p2p/rfq-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { isUuid, pickParam } from "@/lib/p2p";
import { loadOrRedirect, projectOptions } from "@/lib/p2p-server";
import { supplierPicker } from "@/lib/procurement-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.rfqs.form");
  return { title: t("title") };
}

/** Create an RFQ from approved requisitions that are not on a live RFQ yet (D5.2). */
export default async function NewRfqPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const project = pickParam(raw, "project");
  const requisition = pickParam(raw, "requisition");
  const path = "/procurement/rfqs/new";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [approved, projects, suppliers] = await Promise.all([
    loadOrRedirect(
      "/procurement/requisitions?status=approved&limit=200",
      requisitionsResponseSchema,
      path,
    ),
    projectOptions(),
    supplierPicker(),
  ]);
  if (!approved.ok)
    return approved.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.rfqs");
  const requisitions = approved.data.requisitions
    .filter((entry) => entry.rfq === null)
    .map((entry) => ({
      id: entry.id,
      number: entry.number,
      projectId: entry.project.id,
      lineCount: entry.lineCount,
      neededBy: entry.neededBy,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/rfqs", label: t("title") }} />}
        title={t("form.title")}
        description={t("form.description")}
      />
      <RfqForm
        projects={projects}
        requisitions={requisitions}
        suppliers={suppliers}
        defaultProjectId={isUuid(project) ? project : undefined}
        preselected={isUuid(requisition) ? requisition : undefined}
      />
    </div>
  );
}
