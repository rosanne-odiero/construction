import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { storeDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { ReorderLevelsForm } from "@/components/stores/stores-forms";
import { StoresEyebrow } from "@/components/stores/stores-subnav";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.reorder");
  return { title: t("title") };
}

/** Reorder levels per material of a store (D5.3): low stock when on hand ≤ level. */
export default async function ReorderLevelsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  if (!isUuid(storeId)) notFound();
  const path = `/stores/${storeId}/reorder-levels`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(`/stores/${storeId}`, storeDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  if (!result.data.permissions.canEditReorderLevels) return <LiveForbidden />;
  const t = await getTranslations("stores.reorder");
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        eyebrow={
          <StoresEyebrow trail={{ href: `/stores/${storeId}`, label: result.data.store.name }} />
        }
        title={t("title")}
        description={t("description")}
      />
      <ReorderLevelsForm storeId={storeId} balances={result.data.balances} units={units} />
    </div>
  );
}
