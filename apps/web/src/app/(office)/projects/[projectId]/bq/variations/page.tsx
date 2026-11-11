import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { VARIATION_STATUSES, type VariationStatus } from "@pm-buddy/types";
import {
  bqContractSumResponseSchema,
  instructionsResponseSchema,
  projectDetailResponseSchema,
  variationsResponseSchema,
} from "@pm-buddy/validation";
import { BqEyebrow, BqSubnav } from "@/components/bq/bq-subnav";
import { CreateVariationButton } from "@/components/bq/create-variation";
import { VariationStatusBadge } from "@/components/bq/variation-status-badge";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { formatKES } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";
import { cn } from "@/lib/utils";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("variations");
  return { title: t("title") };
}

/** The project's Variation Orders with a status filter (D2.3). */
export default async function VariationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const { status: rawStatus } = await searchParams;
  const status = VARIATION_STATUSES.find((candidate) => candidate === rawStatus) ?? null;
  const path = `/projects/${projectId}/bq/variations${status ? `?status=${status}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, list, instructions, sums] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(
      `/projects/${projectId}/bq/variations${status ? `?status=${status}` : ""}`,
      variationsResponseSchema,
    ),
    serverApi(`/projects/${projectId}/bq/instructions`, instructionsResponseSchema),
    serverApi(`/projects/${projectId}/bq/contract-sum`, bqContractSumResponseSchema),
  ]);
  for (const response of [detail, list, instructions]) {
    if (response.ok) continue;
    if (response.status === 401) redirect(signInHref(path));
    if (response.status === 404) notFound();
    if (response.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!detail.ok || !list.ok || !instructions.ok) return <LiveUnavailable retryHref={path} />;
  const { project } = detail.data;
  const t = await getTranslations("variations");
  const base = `/projects/${project.id}/bq/variations`;
  const filters: (VariationStatus | null)[] = [null, ...VARIATION_STATUSES];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BqEyebrow project={project} />}
        title={t("title")}
        description={t("description")}
        actions={
          list.data.permissions.canCreate && !list.data.createBlocker ? (
            <CreateVariationButton
              projectId={project.id}
              instructions={instructions.data.instructions}
              baseVersionNo={sums.ok ? sums.data.currentVersionNo : null}
            />
          ) : null
        }
      />
      <BqSubnav projectId={project.id} current="variations" />
      {list.data.createBlocker && list.data.createBlocker !== "permission" ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t(`createBlocker.${list.data.createBlocker}`)}
        </p>
      ) : null}
      <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-2">
        {filters.map((value) => (
          <Link
            key={value ?? "all"}
            href={value ? `${base}?status=${value}` : base}
            aria-current={value === status ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-full border px-3 text-sm",
              value === status
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
          >
            {value ? t(`status.${value}`) : t("all")}
          </Link>
        ))}
      </nav>
      {list.data.variations.length ? (
        <div className="relative overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">{t("tableCaption")}</caption>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.number")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.title")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.instruction")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.base")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("cols.status")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t("cols.net")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.effect")}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.variations.map((variation) => (
                <tr key={variation.id} className="border-b last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    <Link href={`${base}/${variation.id}`} className="underline underline-offset-4">
                      {variation.number}
                    </Link>
                  </th>
                  <td className="py-2 pr-2">{variation.title}</td>
                  <td className="py-2 pr-2 text-xs">
                    <span className="font-mono">{variation.instruction.number}</span>
                  </td>
                  <td className="py-2 pr-2 text-xs">
                    {t("versionNo", { version: variation.baseVersion.versionNo })}
                    {variation.stale ? (
                      <StatusBadge tone="warning" className="ml-1">
                        {t("stale")}
                      </StatusBadge>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2">
                    <VariationStatusBadge status={variation.status} />
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(variation.totals.netMinor)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatKES(variation.grandTotalEffectMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          {status ? t("emptyFiltered") : t("empty")}
        </p>
      )}
    </div>
  );
}
