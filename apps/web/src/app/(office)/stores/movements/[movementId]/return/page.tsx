import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { movementResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { ReturnForm } from "@/components/stores/return-form";
import { StoresEyebrow } from "@/components/stores/stores-subnav";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.returnForm");
  return { title: t("title") };
}

/** Return material from an issue to its store (D5.3). */
export default async function ReturnPage({ params }: { params: Promise<{ movementId: string }> }) {
  const { movementId } = await params;
  if (!isUuid(movementId)) notFound();
  const path = `/stores/movements/${movementId}/return`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(`/stock-movements/${movementId}`, movementResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  if (result.data.movement.kind !== "issue") notFound();
  if (!result.data.permissions.canReturn) return <LiveForbidden />;
  const t = await getTranslations("stores.returnForm");
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        eyebrow={
          <StoresEyebrow
            trail={{ href: `/stores/movements/${movementId}`, label: result.data.movement.number }}
          />
        }
        title={t("title")}
        description={t("description", { number: result.data.movement.number })}
      />
      <ReturnForm issue={result.data} units={units} />
    </div>
  );
}
