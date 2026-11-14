import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  projectDetailResponseSchema,
  projectPlantOptionsResponseSchema,
  projectPlantResponseSchema,
  type ProjectPlantOptionsResponse,
  type ProjectPlantResponse,
} from "@pm-buddy/validation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { plantTabHref } from "@/lib/plant";
import { signInHref } from "@/lib/safe-next";
import { requireSession, serverApi } from "@/lib/server-api";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads a project's plant form page: the project, its plant tab and the form choices. */
export async function loadPlantFormPage(
  path: string,
  projectId: string,
): Promise<
  | {
      ok: true;
      code: string;
      plant: ProjectPlantResponse;
      options: ProjectPlantOptionsResponse;
    }
  | { ok: false; element: React.ReactElement }
> {
  const session = await requireSession(path);
  if (!session) return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  const [project, plant, options] = await Promise.all([
    serverApi(`/projects/${projectId}`, projectDetailResponseSchema),
    serverApi(`/projects/${projectId}/plant`, projectPlantResponseSchema),
    serverApi(`/projects/${projectId}/plant/options`, projectPlantOptionsResponseSchema),
  ]);
  for (const result of [project, plant, options]) {
    if (result.ok) continue;
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 404 || result.status === 400) notFound();
    if (result.status === 403) return { ok: false, element: <LiveForbidden /> };
    return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  }
  if (!project.ok || !plant.ok || !options.ok)
    return { ok: false, element: <LiveUnavailable retryHref={path} /> };
  return { ok: true, code: project.data.project.code, plant: plant.data, options: options.data };
}

/** Project code / Plant breadcrumb. */
export async function PlantEyebrow({ projectId, code }: { projectId: string; code: string }) {
  const t = await getTranslations("plant");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link href={`/projects/${projectId}`} className="hover:underline">
        <span className="font-mono">{code}</span>
      </Link>
      <span aria-hidden>/</span>
      <Link href={plantTabHref(projectId)} className="hover:underline">
        {t("tab.title")}
      </Link>
    </span>
  );
}
