import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isProjectReadOnly } from "@pm-buddy/domain";
import {
  bqImportResponseSchema,
  bqImportsResponseSchema,
  projectDetailResponseSchema,
} from "@pm-buddy/validation";
import { ImportWizard } from "@/components/bq/import-wizard";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

const PROTOTYPE_IDS = new Set(["ruiru-heights", "kitengela-bungalow"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations("bqWizard");
  return { title: t("title") };
}

/** The live BQ import wizard (D2.2). `?import=<id>` resumes an unfinished import. */
export default async function BqImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (PROTOTYPE_IDS.has(projectId)) redirect(`/prototype/projects/${projectId}/bq/import`);
  if (!UUID.test(projectId)) notFound();
  const { import: rawImport } = await searchParams;
  const importId = typeof rawImport === "string" && UUID.test(rawImport) ? rawImport : null;
  const path = `/projects/${projectId}/bq/import${importId ? `?import=${importId}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const detail = await serverApi(`/projects/${projectId}`, projectDetailResponseSchema);
  if (!detail.ok) {
    if (detail.status === 401) redirect(signInHref(path));
    if (detail.status === 404) notFound();
    if (detail.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const { project, permissions } = detail.data;
  if (!permissions.includes("bq.import")) return <LiveForbidden />;
  const t = await getTranslations("bqWizard");
  const [imports, current] = await Promise.all([
    serverApi(`/projects/${projectId}/bq/imports`, bqImportsResponseSchema),
    importId
      ? serverApi(`/projects/${projectId}/bq/imports/${importId}`, bqImportResponseSchema)
      : Promise.resolve(null),
  ]);
  if (!imports.ok) {
    if (imports.status === 401) redirect(signInHref(path));
    if (imports.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${project.id}`} className="hover:underline">
              <span className="font-mono">{project.code}</span> · {project.name}
            </Link>
            <span aria-hidden>/</span>
            <Link href={`/projects/${project.id}/bq`} className="hover:underline">
              {t("bqLink")}
            </Link>
          </span>
        }
        title={t("title")}
        description={t("description")}
      />
      {isProjectReadOnly(project.status) ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("readOnly")}
        </p>
      ) : (
        <ImportWizard
          projectId={project.id}
          initial={current?.ok ? current.data.import : null}
          imports={imports.data.imports}
        />
      )}
    </div>
  );
}
