import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { plantOptionsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { PlantForm } from "@/components/plant/plant-form";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { calendarInput } from "@/lib/project-input";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/plant/new";

export async function generateMetadata() {
  const t = await getTranslations("plant");
  return { title: t("register.new") };
}

/** Register an owned or hired plant item (plant.manage). */
export default async function NewPlantPage() {
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const options = await loadLive("/plant/options", plantOptionsResponseSchema, PATH);
  if (!options.ok)
    return options.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={PATH} />;
  const t = await getTranslations("plant");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/plant" className="hover:underline">
            {t("title")}
          </Link>
        }
        title={t("register.new")}
        description={t("register.newHint")}
      />
      <PlantForm options={options.data} today={calendarInput(nairobiDate())} />
    </div>
  );
}
