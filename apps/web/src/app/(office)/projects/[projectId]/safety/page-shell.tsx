import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { z } from "zod";
import { projectDetailResponseSchema, type ProjectDetailResponse } from "@pm-buddy/validation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { safetyHref, type SafetyView } from "@/lib/safety";
import { signInHref } from "@/lib/safe-next";
import { requireSession, serverApi, type LiveSession } from "@/lib/server-api";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a project-scoped safety page: the session, the project and the page's own data, turning
 * 401 into sign-in, 404/400 into not found and 403 into the forbidden state.
 */
export async function loadSafetyPage<T>(
  path: string,
  projectId: string,
  apiPath: string,
  schema: z.ZodType<T>,
): Promise<
  | { ok: true; session: LiveSession; project: ProjectDetailResponse; data: T }
  | { ok: false; element: React.ReactElement }
> {
  const session = await requireSession(path);
  if (!session) return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  const [project, result] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(apiPath, schema),
  ]);
  if (!project.ok || !result.ok) {
    const status = result.ok ? (project.ok ? 200 : project.status) : result.status;
    if (status === 401) redirect(signInHref(path));
    if (status === 404 || status === 400) notFound();
    if (status === 403) return { ok: false, element: <LiveForbidden /> };
    return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  }
  return { ok: true, session, project: project.data, data: result.data };
}

/** Project code / Health and safety / record breadcrumb. */
export async function SafetyEyebrow({
  projectId,
  code,
  view,
  current,
}: {
  projectId: string;
  code: string;
  view: SafetyView;
  current?: string;
}) {
  const t = await getTranslations("safety");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link href={`/projects/${projectId}`} className="hover:underline">
        <span className="font-mono">{code}</span>
      </Link>
      <span aria-hidden>/</span>
      <Link href={safetyHref(projectId, view)} className="hover:underline">
        {t("title")}
      </Link>
      {current ? (
        <>
          <span aria-hidden>/</span>
          <span className="font-mono">{current}</span>
        </>
      ) : null}
    </span>
  );
}
