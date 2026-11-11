import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  diariesResponseSchema,
  sitePhotoListQuerySchema,
  sitePhotosResponseSchema,
  sitesResponseSchema,
} from "@pm-buddy/validation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { PhotosPanel } from "@/components/projects/photos-panel";
import { loadLive, serverApi } from "@/lib/server-api";

export async function PhotosTab({
  projectId,
  userId,
  canUpload,
  returnTo,
  cursor,
}: {
  projectId: string;
  userId: string;
  canUpload: boolean;
  returnTo: string;
  cursor?: string | string[];
}) {
  const parsed = sitePhotoListQuerySchema.safeParse(cursor === undefined ? {} : { cursor });
  if (!parsed.success) notFound();
  const query = parsed.data.cursor ? `?cursor=${parsed.data.cursor}` : "";
  const [photos, sites, diaries] = await Promise.all([
    loadLive(`/projects/${projectId}/photos${query}`, sitePhotosResponseSchema, returnTo),
    loadLive(`/projects/${projectId}/sites`, sitesResponseSchema, returnTo),
    // Only for offering "attach to my draft diary"; a role that cannot read diaries just gets none.
    canUpload
      ? serverApi(`/projects/${projectId}/diaries?limit=100`, diariesResponseSchema)
      : Promise.resolve(null),
  ]);
  if ((!photos.ok && photos.status === 403) || (!sites.ok && sites.status === 403))
    return <LiveForbidden />;
  if (!photos.ok || !sites.ok) return <LiveUnavailable retryHref={returnTo} />;
  const drafts =
    diaries?.ok === true
      ? diaries.data.diaries.filter(
          (diary) => diary.status === "draft" && diary.createdBy === userId,
        )
      : [];
  const t = await getTranslations("livePhotos");
  return (
    <div className="space-y-4">
      <PhotosPanel
        projectId={projectId}
        photos={photos.data.photos}
        sites={sites.data.sites}
        drafts={drafts}
        canUpload={canUpload}
      />
      <nav aria-label={t("pages")} className="flex flex-wrap gap-4 text-sm">
        {parsed.data.cursor ? (
          <Link className="underline" href={`/projects/${projectId}?tab=photos`}>
            {t("newest")}
          </Link>
        ) : null}
        {photos.data.nextCursor ? (
          <Link
            className="underline"
            href={`/projects/${projectId}?tab=photos&cursor=${photos.data.nextCursor}`}
          >
            {t("older")}
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
