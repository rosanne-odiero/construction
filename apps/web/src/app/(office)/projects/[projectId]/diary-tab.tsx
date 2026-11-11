import {
  diariesResponseSchema,
  diaryListQuerySchema,
  sitesResponseSchema,
} from "@pm-buddy/validation";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DiariesPanel } from "@/components/projects/diaries-panel";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { loadLive } from "@/lib/server-api";

export async function DiaryTab({
  projectId,
  userId,
  canWrite,
  canReview,
  returnTo,
  cursor,
}: {
  projectId: string;
  userId: string;
  canWrite: boolean;
  canReview: boolean;
  returnTo: string;
  cursor?: string | string[];
}) {
  const parsed = diaryListQuerySchema.safeParse(cursor === undefined ? {} : { cursor });
  if (!parsed.success) notFound();
  const query = parsed.data.cursor ? `?cursor=${parsed.data.cursor}` : "";
  const [diaries, sites] = await Promise.all([
    loadLive(`/projects/${projectId}/diaries${query}`, diariesResponseSchema, returnTo),
    loadLive(`/projects/${projectId}/sites`, sitesResponseSchema, returnTo),
  ]);
  if ((!diaries.ok && diaries.status === 403) || (!sites.ok && sites.status === 403))
    return <LiveForbidden />;
  if (!diaries.ok || !sites.ok) return <LiveUnavailable retryHref={returnTo} />;
  const t = await getTranslations("liveDiary");
  return (
    <div className="space-y-4">
      <DiariesPanel
        projectId={projectId}
        userId={userId}
        diaries={diaries.data.diaries}
        sites={sites.data.sites}
        canWrite={canWrite}
        canReview={canReview}
      />
      <nav aria-label={t("pages")} className="flex flex-wrap gap-4 text-sm">
        {parsed.data.cursor ? (
          <Link className="underline" href={`/projects/${projectId}?tab=diary`}>
            {t("newest")}
          </Link>
        ) : null}
        {diaries.data.nextCursor ? (
          <Link
            className="underline"
            href={`/projects/${projectId}?tab=diary&cursor=${diaries.data.nextCursor}`}
          >
            {t("older")}
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
