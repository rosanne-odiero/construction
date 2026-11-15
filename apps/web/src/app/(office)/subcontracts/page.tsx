import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Hammer } from "lucide-react";
import { subcontractsOverviewResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { SubcontractsEyebrow } from "@/components/subcontracts/subcontracts-nav";
import { formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.home");
  return { title: t("title") };
}

/**
 * Subcontracts home (D6.3 part B): every project where the caller reads subcontracts, with the
 * value committed, work certified, retention held and advances outstanding; the subcontractors
 * (D5.1 suppliers flagged as such); and the projects with piece-rate jobs the caller may see.
 */
export default async function SubcontractsPage() {
  const path = "/subcontracts";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect("/subcontracts", subcontractsOverviewResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("subcontracts.home");
  const { projects, subcontractors, pieceRateProjects } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<SubcontractsEyebrow />}
        title={t("title")}
        description={t("description")}
      />
      {projects.length === 0 && pieceRateProjects.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed p-6 text-sm">
          <p className="font-medium">{t("noProjects")}</p>
          <p className="text-muted-foreground">{t("noProjectsHint")}</p>
        </div>
      ) : null}
      {projects.length ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {projects.map((row) => (
            <li key={row.project.id} className="space-y-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 font-semibold">
                  <Link
                    href={`/subcontracts/projects/${row.project.id}`}
                    className="underline underline-offset-4"
                  >
                    {row.project.code} · {row.project.name}
                  </Link>
                </h2>
                <div className="flex flex-wrap gap-1">
                  {row.pendingApprovals ? (
                    <StatusBadge tone="info">
                      {t("pendingApprovals", { count: row.pendingApprovals })}
                    </StatusBadge>
                  ) : null}
                  {row.openCertificates ? (
                    <StatusBadge tone="neutral">
                      {t("openCertificates", { count: row.openCertificates })}
                    </StatusBadge>
                  ) : null}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("count", { count: row.subcontracts, live: row.live })}
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {(
                  [
                    ["committed", row.committedMinor],
                    ["certified", row.certifiedWorkMinor],
                    ["retention", row.retentionHeldMinor],
                    ["advances", row.advancesOutstandingMinor],
                  ] as const
                ).map(([key, amount]) => (
                  <div key={key}>
                    <dt className="text-muted-foreground">{t(`figures.${key}`)}</dt>
                    <dd className="tabular-nums">{formatKES(amount)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      {pieceRateProjects.length ? (
        <section aria-labelledby="piece-rate-projects" className="space-y-2">
          <h2 id="piece-rate-projects" className="text-lg font-semibold">
            {t("pieceRateTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("pieceRateHint")}</p>
          <ul className="flex flex-wrap gap-2">
            {pieceRateProjects.map((project) => (
              <li key={project.id}>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/subcontracts/projects/${project.id}/piece-rate`}>
                    <Hammer aria-hidden /> {project.code} · {project.name}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {subcontractors.length ? (
        <section aria-labelledby="subcontractors" className="space-y-2">
          <h2 id="subcontractors" className="text-lg font-semibold">
            {t("subcontractorsTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("subcontractorsHint")}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {subcontractors.map((row) => (
              <li key={row.id} className="rounded-lg border p-3 text-sm">
                <Link
                  href={`/suppliers/${row.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {row.code} · {row.name}
                </Link>
                <p className="text-muted-foreground">
                  {t("supplierLine", { pin: row.kraPinMasked ?? "—", etims: row.etimsStatus })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
