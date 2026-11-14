import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { clientDiariesResponseSchema } from "@pm-buddy/validation";
import { DiaryEntry } from "@/components/client-portal/client-sections";
import { ClientProjectHeader } from "@/components/client-portal/client-shell";
import { LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { loadClientPage } from "@/lib/client-portal-server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("clientPortal.diaries");
  return { title: t("title") };
}

/** Approved site diaries, newest day first (never drafts, reviewers or workers' names). */
export default async function ClientDiariesPage({
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
  const path = `/portal/projects/${projectId}/diaries${after ? `?cursor=${after}` : ""}`;
  const page = await loadClientPage(
    path,
    `/portal/client/projects/${projectId}/diaries${after ? `?cursor=${after}` : ""}`,
    clientDiariesResponseSchema,
  );
  if (page.kind !== "ok") return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("clientPortal.diaries");
  const { project, diaries, nextCursor } = page.data;
  return (
    <div className="space-y-6">
      <ClientProjectHeader
        project={project}
        current="diaries"
        title={t("title")}
        description={t("description")}
      />
      {diaries.length ? (
        <ol className="space-y-4">
          {diaries.map((diary) => (
            <li key={diary.id}>
              <DiaryEntry diary={diary} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center">{t("empty")}</p>
      )}
      {nextCursor ? (
        <Button asChild variant="outline">
          <Link href={`/portal/projects/${project.id}/diaries?cursor=${nextCursor}`}>
            {t("older")}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
