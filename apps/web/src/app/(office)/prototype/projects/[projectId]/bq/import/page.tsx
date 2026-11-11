import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getProject } from "@/mocks/projects";
import { ImportWizard } from "./import-wizard";

export async function generateMetadata() {
  const t = await getTranslations("bqImport");
  return { title: t("title") };
}

export default async function BqImportPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();
  const t = await getTranslations("bqImport");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href={`/prototype/projects/${project.id}/bq`} className="hover:underline">
            {project.name} · BQ
          </Link>
        }
        title={t("title")}
        description={t("description")}
      />
      <ImportWizard projectId={project.id} />
    </div>
  );
}
