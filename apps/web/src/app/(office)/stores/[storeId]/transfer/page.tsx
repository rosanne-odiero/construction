import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { issueOptionsResponseSchema, transferTargetsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StoresEyebrow } from "@/components/stores/stores-subnav";
import { TransferForm } from "@/components/stores/transfer-forms";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.transferForm");
  return { title: t("title") };
}

/** Send stock to another site's store (D5.3). */
export default async function TransferPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  if (!isUuid(storeId)) notFound();
  const path = `/stores/${storeId}/transfer`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, targets, units] = await Promise.all([
    loadOrRedirect(`/stores/${storeId}/issue-options`, issueOptionsResponseSchema, path),
    serverApi(`/stores/${storeId}/transfer-targets`, transferTargetsResponseSchema),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.transferForm");
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        eyebrow={
          <StoresEyebrow trail={{ href: `/stores/${storeId}`, label: result.data.store.name }} />
        }
        title={t("title")}
        description={t("description")}
      />
      <TransferForm
        options={result.data}
        targets={targets.ok ? targets.data.stores : []}
        units={units}
      />
    </div>
  );
}
