import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { History } from "lucide-react";
import {
  bqResponseSchema,
  projectDetailResponseSchema,
  variationResponseSchema,
} from "@pm-buddy/validation";
import { BqEyebrow, BqSubnav } from "@/components/bq/bq-subnav";
import { VariationEditor } from "@/components/bq/variation-editor";
import { VariationClientPanel } from "@/components/client-portal/variation-client-panel";
import { VariationStatusBadge } from "@/components/bq/variation-status-badge";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatKES } from "@/lib/format";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("variationDetail");
  return { title: t("metaTitle") };
}

/** One Variation Order: lines, totals, snapshot, decision, history and the allowed commands. */
export default async function VariationPage({
  params,
}: {
  params: Promise<{ projectId: string; variationId: string }>;
}) {
  const { projectId, variationId } = await params;
  if (!UUID.test(projectId) || !UUID.test(variationId)) notFound();
  const path = `/projects/${projectId}/bq/variations/${variationId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [detail, result, bq] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(`/projects/${projectId}/bq/variations/${variationId}`, variationResponseSchema),
    serverApi(`/projects/${projectId}/bq`, bqResponseSchema),
  ]);
  for (const response of [detail, result, bq]) {
    if (response.ok) continue;
    if (response.status === 401) redirect(signInHref(path));
    if (response.status === 404) notFound();
    if (response.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!detail.ok || !result.ok || !bq.ok) return <LiveUnavailable retryHref={path} />;
  const { project } = detail.data;
  const { variation } = result.data;
  const t = await getTranslations("variationDetail");
  const tStatus = await getTranslations("variations.status");
  const tVariations = await getTranslations("variations");
  // The editor picks items from the base version, which is the current one unless stale.
  const bills =
    bq.data.bq && bq.data.bq.version.id === variation.baseVersion.id ? bq.data.bq.bills : [];
  const totals = [
    { key: "additions", value: variation.totals.additionsMinor },
    { key: "omissions", value: -variation.totals.omissionsMinor },
    { key: "net", value: variation.totals.netMinor, strong: true },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <BqEyebrow
            project={project}
            trail={{ href: `/projects/${project.id}/bq/variations`, label: tVariations("title") }}
          />
        }
        title={`${variation.number} · ${variation.title}`}
        description={variation.description ?? undefined}
        actions={
          <>
            <VariationStatusBadge status={variation.status} />
            {variation.stale ? (
              <StatusBadge tone="warning">{tVariations("stale")}</StatusBadge>
            ) : null}
          </>
        }
      />
      <BqSubnav projectId={project.id} current="variations" />
      {variation.stale ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("staleNote", {
            base: variation.baseVersion.versionNo,
            latest: variation.latestVersion.versionNo,
          })}
        </p>
      ) : null}
      {variation.permissions.approvalBlocker === "maker" ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("makerNote")}
        </p>
      ) : null}
      {variation.permissions.approvalBlocker === "client" ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("clientNote")}
        </p>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>{t("summary.title")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("summary.instruction")}</dt>
                <dd>
                  <Link
                    href={`/projects/${project.id}/bq/instructions`}
                    className="underline underline-offset-4"
                  >
                    <span className="font-mono">{variation.instruction.number}</span>
                  </Link>{" "}
                  · {variation.instruction.subject}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("summary.base")}</dt>
                <dd>
                  {tVariations("versionNo", { version: variation.baseVersion.versionNo })}
                  {variation.resultVersion
                    ? ` → ${tVariations("versionNo", { version: variation.resultVersion.versionNo })}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("summary.raisedBy")}</dt>
                <dd>
                  {variation.createdBy.displayName} · {formatDateTime(variation.createdAt)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("summary.snapshot")}</dt>
                <dd className="break-all">
                  {variation.snapshot ? (
                    <>
                      <span className="font-mono text-xs">
                        {variation.snapshot.digest.slice(0, 16)}…
                      </span>{" "}
                      {t("summary.submittedBy", {
                        name: variation.snapshot.submittedBy.displayName,
                        date: formatDateTime(variation.snapshot.submittedAt),
                      })}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t("summary.notSubmitted")}</span>
                  )}
                </dd>
              </div>
              {variation.decision ? (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">{t("summary.decision")}</dt>
                  <dd>
                    {t(`summary.${variation.decision.outcome}`, {
                      name: variation.decision.by.displayName,
                      date: formatDateTime(variation.decision.at),
                    })}
                    {variation.decision.reason ? ` — ${variation.decision.reason}` : ""}
                  </dd>
                </div>
              ) : null}
              {variation.cancelReason ? (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">{t("summary.cancelled")}</dt>
                  <dd>{variation.cancelReason}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("totals.title")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1 text-sm">
              {totals.map((row) => (
                <div
                  key={row.key}
                  className={`flex justify-between gap-4 border-b py-1 ${"strong" in row ? "font-semibold" : ""}`}
                >
                  <dt>{t(`totals.${row.key}`)}</dt>
                  <dd className="tabular-nums">{formatKES(row.value)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-4 border-b py-1">
                <dt className="text-muted-foreground">
                  {t("totals.base", { version: variation.baseVersion.versionNo })}
                </dt>
                <dd className="tabular-nums">{formatKES(variation.baseTotals.grandTotalMinor)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b py-1">
                <dt className="text-muted-foreground">
                  {t("totals.vat", { rate: variation.vatRatePercent })}
                </dt>
                <dd className="tabular-nums">{formatKES(variation.projected.vatMinor)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b py-1 font-semibold">
                <dt>{t("totals.projected")}</dt>
                <dd className="tabular-nums">{formatKES(variation.projected.grandTotalMinor)}</dd>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-muted-foreground">{t("totals.effect")}</dt>
                <dd className="tabular-nums">{formatKES(variation.grandTotalEffectMinor)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">{t("totals.note")}</p>
          </CardContent>
        </Card>
      </div>
      <VariationEditor
        key={variation.version}
        projectId={project.id}
        variation={variation}
        bills={bills}
      />
      <VariationClientPanel projectId={project.id} variation={variation} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4" aria-hidden />
            <h2>{t("history.title")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            {variation.history.map((entry) => (
              <li key={`${entry.at}-${entry.action}`} className="border-l-2 pl-3">
                <p className="font-medium">
                  {t(`history.${entry.action}`, { to: tStatus(entry.to) })}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("history.by", { name: entry.by.displayName, date: formatDateTime(entry.at) })}
                </p>
                {entry.reason ? <p className="mt-1">{entry.reason}</p> : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
