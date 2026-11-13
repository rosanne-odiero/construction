import { getTranslations } from "next-intl/server";
import { receivableLposResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { GrnCapture } from "@/components/procurement/p2p/grn-capture";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { isUuid, pickParam } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.grns.capture");
  return { title: t("title") };
}

/** Record a delivery against an approved LPO, built for a phone on site (D5.2). */
export default async function NewGrnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const lpo = pickParam(raw, "lpo");
  const path = `/procurement/grns/new${isUuid(lpo) ? `?lpo=${lpo}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect("/procurement/grns/receivable", receivableLposResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.grns");

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/grns", label: t("title") }} />}
        title={t("capture.title")}
        description={t("capture.description")}
      />
      <GrnCapture
        lpos={result.data.lpos}
        units={units}
        defaultLpoId={isUuid(lpo) ? lpo : undefined}
        receivedByDefault={session.user.displayName}
      />
    </div>
  );
}
