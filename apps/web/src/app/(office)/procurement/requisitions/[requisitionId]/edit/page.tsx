import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { requisitionDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RequisitionForm } from "@/components/procurement/p2p/requisition-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { isUuid } from "@/lib/p2p";
import { loadOrRedirect, sitesByProject, unitOptions } from "@/lib/p2p-server";
import { materialPicker } from "@/lib/procurement-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.requisitions");
  return { title: t("title") };
}

/** Edit a draft requisition (a new version; the API checks the version read here). */
export default async function EditRequisitionPage({
  params,
}: {
  params: Promise<{ requisitionId: string }>;
}) {
  const { requisitionId } = await params;
  if (!isUuid(requisitionId)) notFound();
  const detailPath = `/procurement/requisitions/${requisitionId}`;
  const path = `${detailPath}/edit`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(detailPath, requisitionDetailResponseSchema, path);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { requisition, lines, permissions } = result.data;
  if (requisition.status !== "draft" || !permissions.canEdit) redirect(detailPath);
  const [materials, units, sites] = await Promise.all([
    materialPicker(),
    unitOptions(),
    sitesByProject([requisition.project.id]),
  ]);
  for (const line of lines)
    if (!materials.some((material) => material.id === line.material.id))
      materials.unshift({ ...line.material });
  const t = await getTranslations("p2p.requisitions");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: detailPath, label: requisition.number }} />}
        title={t("form.editTitle", { number: requisition.number })}
        description={t("form.description")}
      />
      <RequisitionForm
        projects={[requisition.project]}
        sites={sites}
        materials={materials}
        units={units}
        today={nairobiDate()}
        initial={{
          id: requisition.id,
          number: requisition.number,
          version: requisition.version,
          projectId: requisition.project.id,
          siteId: requisition.site?.id ?? null,
          neededBy: requisition.neededBy,
          notes: requisition.notes,
          lines: lines.map((line) => ({
            materialId: line.material.id,
            quantity: line.quantity,
            unit: line.unit,
            bqItem: line.bqItem
              ? {
                  lineageId: line.bqItem.lineageId,
                  ref: line.bqItem.ref,
                  description: line.bqItem.description,
                }
              : null,
            note: line.note ?? "",
          })),
        }}
      />
    </div>
  );
}
