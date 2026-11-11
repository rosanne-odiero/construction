import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buildupsResponseSchema } from "@pm-buddy/validation";
import { BuildupAssumptions } from "@/components/bq/buildup-assumptions";
import { BuildupEditor } from "@/components/bq/buildup-editor";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("rateBuildUps");
  return { title: t("new") };
}

export default async function NewBuildupPage() {
  const path = "/rate-buildups/new";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await serverApi("/rate-buildups", buildupsResponseSchema);
  if (!result.ok) {
    if (result.status === 401) redirect(signInHref(path));
    if (result.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  if (!result.data.permissions.canEdit) return <LiveForbidden />;
  const t = await getTranslations("rateBuildUps");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/rate-buildups" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={t("new")}
      />
      <BuildupAssumptions />
      <BuildupEditor />
    </div>
  );
}
