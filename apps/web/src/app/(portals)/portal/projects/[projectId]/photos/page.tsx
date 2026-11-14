import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ShieldCheck, ShieldQuestion } from "lucide-react";
import { clientPhotosResponseSchema } from "@pm-buddy/validation";
import { ClientProjectHeader } from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { loadClientPage } from "@/lib/client-portal-server";
import { formatDateTime } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.photos");
  return { title: t("title") };
}

/**
 * The photo timeline: the project's general site photos, newest first, with the time the photo
 * says it was taken (Nairobi), when the server received it, the site and the server's checks —
 * an unverified photo is labelled as such, and "verified" is explained as evidence, not proof.
 */
export default async function ClientPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();
  const cursor = (await searchParams)["cursor"];
  const after = typeof cursor === "string" && UUID.test(cursor) ? cursor : undefined;
  const path = `/portal/projects/${projectId}/photos${after ? `?cursor=${after}` : ""}`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/photos${after ? `?cursor=${after}` : ""}`,
    clientPhotosResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.photos");
  const { project, photos, nextCursor, counts } = page.data;
  return (
    <div className="space-y-6">
      <ClientProjectHeader
        project={project}
        current="photos"
        title={t("title")}
        description={t("summary", counts)}
      />
      <details className="rounded-md border bg-background p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t("limitationsTitle")}</summary>
        <p className="mt-2 text-muted-foreground">{t("limitations")}</p>
      </details>
      {photos.length ? (
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((photo) => (
            <li key={photo.id}>
              <figure className="h-full space-y-2 rounded-xl border bg-card p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated API image without metadata */}
                <img
                  src={`/api/v1/portal/client/projects/${project.id}/photos/${photo.id}/image`}
                  alt={photo.caption ?? t("noCaption")}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  className="aspect-[4/3] w-full rounded-lg bg-muted object-cover"
                />
                <figcaption className="space-y-1 px-1 pb-1 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    {photo.verified ? (
                      <StatusBadge
                        tone="success"
                        icon={<ShieldCheck className="size-3" aria-hidden />}
                      >
                        {t("verified")}
                      </StatusBadge>
                    ) : (
                      <StatusBadge
                        tone="warning"
                        icon={<ShieldQuestion className="size-3" aria-hidden />}
                      >
                        {t("unverified")}
                      </StatusBadge>
                    )}
                    <span className="text-muted-foreground">{photo.siteName}</span>
                  </span>
                  {photo.caption ? (
                    <span className="block font-medium">{photo.caption}</span>
                  ) : null}
                  <span className="block text-xs text-muted-foreground">
                    {photo.capturedAt
                      ? t("captured", {
                          date: formatDateTime(photo.capturedAt),
                          source: t(`timeSource.${photo.timeSource ?? "assumed_nairobi"}`),
                        })
                      : t("noCaptureTime")}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("received", { date: formatDateTime(photo.uploadedAt) })}
                  </span>
                  {photo.verified ? null : (
                    <span className="block text-xs">
                      {t(`location.${photo.checks.location}`, {
                        metres: Math.round(photo.checks.distanceM ?? 0),
                      })}{" "}
                      {t(`time.${photo.checks.time}`)}
                    </span>
                  )}
                </figcaption>
              </figure>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
      {nextCursor ? (
        <Button asChild variant="outline">
          <Link href={`/portal/projects/${project.id}/photos?cursor=${nextCursor}`}>
            {t("older")}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
