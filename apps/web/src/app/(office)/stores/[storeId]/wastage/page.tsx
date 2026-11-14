import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { issueOptionsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { MovementForm } from "@/components/stores/movement-form";
import { StoresEyebrow } from "@/components/stores/stores-subnav";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.movementForm");
  return { title: t("wastageTitle") };
}

/** Record wastage with a reason (D5.3); it leaves the store at its average cost. */
export default async function WastagePage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  if (!isUuid(storeId)) notFound();
  const path = `/stores/${storeId}/wastage`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(`/stores/${storeId}/issue-options`, issueOptionsResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.movementForm");
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        eyebrow={
          <StoresEyebrow trail={{ href: `/stores/${storeId}`, label: result.data.store.name }} />
        }
        title={t("wastageTitle")}
        description={t("wastageDescription")}
      />
      <MovementForm kind="wastage" options={result.data} units={units} />
    </div>
  );
}
