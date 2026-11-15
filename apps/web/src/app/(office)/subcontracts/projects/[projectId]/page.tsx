import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { projectSubcontractsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { NewSubcontractForm } from "@/components/subcontracts/subcontract-forms";
import {
  ProjectSubnav,
  SubcontractsEyebrow,
  type ProjectSection,
} from "@/components/subcontracts/subcontracts-nav";
import { formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import { subcontractStatusTone } from "@/lib/subcontracts";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.project");
  return { title: t("metaTitle") };
}

/**
 * A project's subcontracts (D6.3 part B): each with its subcontractor, status, value, what is
 * still committed and the statement position; the totals; and a new draft for bq.edit holders.
 */
export default async function ProjectSubcontractsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const path = `/subcontracts/projects/${projectId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/subcontracts/projects/${projectId}`,
    projectSubcontractsResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("subcontracts.project");
  const tStatus = await getTranslations("subcontracts.status");
  const tKind = await getTranslations("subcontracts.kinds");
  const { project, subcontracts, subcontractors, totals, permissions } = result.data;
  const sections: ProjectSection[] = permissions.canReadPieceRate
    ? ["subcontracts", "piece-rate", "output"]
    : ["subcontracts"];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<SubcontractsEyebrow trail={{ href: "/subcontracts", label: t("back") }} />}
        title={t("title", { code: project.code })}
        description={project.name}
      />
      <ProjectSubnav projectId={project.id} current="subcontracts" sections={sections} />
      <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4 text-sm sm:grid-cols-5">
        {(
          [
            ["committed", totals.committedMinor],
            ["certified", totals.certifiedWorkMinor],
            ["retention", totals.retentionHeldMinor],
            ["advances", totals.advancesOutstandingMinor],
            ["outstanding", totals.outstandingMinor],
          ] as const
        ).map(([key, amount]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{t(`totals.${key}`)}</dt>
            <dd className="font-medium tabular-nums">{formatKES(amount)}</dd>
          </div>
        ))}
      </dl>
      {subcontracts.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-sm">{t("empty")}</p>
      ) : (
        <ScrollTable label={t("tableLabel")} minWidth={760}>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                {t("columns.subcontract")}
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                {t("columns.subcontractor")}
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                {t("columns.status")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("columns.value")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("columns.committed")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("columns.certified")}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                {t("columns.outstanding")}
              </th>
            </tr>
          </thead>
          <tbody>
            {subcontracts.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  <Link
                    href={`/subcontracts/${row.id}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {row.code}
                  </Link>
                  <span className="block">{row.title}</span>
                  <span className="block text-xs text-muted-foreground">{tKind(row.kind)}</span>
                </th>
                <td className="px-4 py-2">{row.supplier.name}</td>
                <td className="px-4 py-2">
                  <StatusBadge tone={subcontractStatusTone[row.status]}>
                    {tStatus(row.status)}
                  </StatusBadge>
                  {row.openCertificate ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {row.openCertificate.code}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{formatKES(row.valueMinor)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatKES(row.committedMinor)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatKES(row.position.certifiedWorkMinor)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatKES(row.position.outstandingMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      <p className="text-xs text-muted-foreground">{t("committedNote")}</p>
      {permissions.canCreate ? (
        <NewSubcontractForm
          projectId={project.id}
          subcontractors={subcontractors.map((row) => ({
            id: row.id,
            code: row.code,
            name: row.name,
          }))}
        />
      ) : null}
    </div>
  );
}
