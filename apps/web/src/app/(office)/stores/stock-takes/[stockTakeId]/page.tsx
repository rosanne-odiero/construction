import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { stockTakeResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { StockTakeSheet } from "@/components/stores/stock-take-sheet";
import { StoresAction } from "@/components/stores/stores-action";
import { StoresEyebrow } from "@/components/stores/stores-subnav";
import { formatDateTime } from "@/lib/format";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid, stockTakeTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.stockTakes");
  return { title: t("title") };
}

/**
 * A stock take (D5.3): the count sheet, variances against the system quantity when each line was
 * counted, submission, and approval by someone who did not create, count or submit it.
 */
export default async function StockTakePage({
  params,
}: {
  params: Promise<{ stockTakeId: string }>;
}) {
  const { stockTakeId } = await params;
  if (!isUuid(stockTakeId)) notFound();
  const path = `/stores/stock-takes/${stockTakeId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(`/stock-takes/${stockTakeId}`, stockTakeResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.stockTakes");
  const tStatus = await getTranslations("stores.status");
  const { stockTake, permissions } = result.data;
  const base = `/stock-takes/${stockTake.id}`;
  const contributor = stockTake.contributors.some((person) => person.id === session.user.id);
  const action = (key: "submit" | "approve" | "return" | "cancel") => ({
    button: t(`${key}.button`),
    title: t(`${key}.title`, { number: stockTake.number }),
    description: t(`${key}.description`),
    confirm: t(`${key}.confirm`),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <StoresEyebrow
            trail={{ href: `/stores/${stockTake.store.id}`, label: stockTake.store.name }}
          />
        }
        title={t("detailTitle", { number: stockTake.number })}
        description={t("detailDescription", {
          who: stockTake.createdBy.displayName,
          when: formatDateTime(stockTake.createdAt),
        })}
        actions={
          <>
            {permissions.canSubmit ? (
              <StoresAction
                path={`${base}/submit`}
                entity="stockTake"
                body={{ version: stockTake.version }}
                primary
                text={action("submit")}
              />
            ) : null}
            {permissions.canApprove ? (
              <StoresAction
                path={`${base}/approve`}
                entity="stockTake"
                body={{ version: stockTake.version }}
                primary
                text={action("approve")}
              />
            ) : null}
            {permissions.canReturn ? (
              <StoresAction
                path={`${base}/return`}
                entity="stockTake"
                body={{ version: stockTake.version }}
                reason
                text={action("return")}
              />
            ) : null}
            {permissions.canCancel ? (
              <StoresAction
                path={`${base}/cancel`}
                entity="stockTake"
                body={{ version: stockTake.version }}
                reason
                destructive
                text={action("cancel")}
              />
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={stockTakeTone[stockTake.status]}>
          {tStatus(`stockTake.${stockTake.status}`)}
        </StatusBadge>
        {stockTake.status === "submitted" && contributor ? (
          <StatusBadge tone="info" className="h-auto whitespace-normal">
            {t("makerChecker")}
          </StatusBadge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t("howCounted")}</p>
      {result.data.uncoveredMaterials > 0 ? (
        <p className="rounded-xl border p-4 text-sm" role="status">
          {t("inTurns", { lines: stockTake.lineCount, left: result.data.uncoveredMaterials })}
        </p>
      ) : null}
      {stockTake.returnReason && stockTake.status === "draft" ? (
        <p className="rounded-xl border p-4 text-sm" role="status">
          {t("returned", { reason: stockTake.returnReason })}
        </p>
      ) : null}
      {stockTake.approvedBy ? (
        <p className="rounded-xl border p-4 text-sm" role="status">
          {t("approvedBy", {
            who: stockTake.approvedBy.displayName,
            when: stockTake.approvedAt ? formatDateTime(stockTake.approvedAt) : "",
          })}
        </p>
      ) : null}
      <StockTakeSheet take={result.data} units={units} />
    </div>
  );
}
