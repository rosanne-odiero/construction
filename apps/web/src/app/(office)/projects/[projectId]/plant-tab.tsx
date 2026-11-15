import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { projectPlantResponseSchema, type Project } from "@pm-buddy/validation";
import { PlantCard } from "@/components/plant/plant-card";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { loadLive } from "@/lib/server-api";

/**
 * The project's plant (D8.3): the items on its sites today, whether today's usage is logged and the
 * fuel issued, and links to the phone forms for usage and fuel.
 */
export async function PlantTab({
  project,
  saved,
  returnTo,
}: {
  project: Project;
  saved: string | undefined;
  returnTo: string;
}) {
  const t = await getTranslations("plant");
  const result = await loadLive(
    `/projects/${project.id}/plant`,
    projectPlantResponseSchema,
    returnTo,
  );
  if (!result.ok) return <LiveUnavailable retryHref={returnTo} />;
  const { items, permissions } = result.data;
  const base = `/projects/${project.id}/plant`;
  return (
    <section aria-labelledby="plant-tab-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h2 id="plant-tab-heading" className="text-base font-semibold">
            {t("tab.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("tab.hint")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {permissions.canRecordUsage && items.length ? (
            <Button asChild>
              <Link href={`${base}/usage`}>{t("actions.recordUsage")}</Link>
            </Button>
          ) : null}
          {permissions.canRecordFuel && items.some((item) => item.fuelType !== "none") ? (
            <Button asChild variant="secondary">
              <Link href={`${base}/fuel`}>{t("actions.recordFuel")}</Link>
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href={`/plant?projectId=${project.id}`}>{t("tab.register")}</Link>
          </Button>
        </div>
      </div>
      {saved === "usage" || saved === "fuel" ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t(`tab.saved.${saved}`)}
        </p>
      ) : null}
      {items.length ? (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <li key={item.id}>
              <PlantCard
                item={item}
                extra={
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusBadge tone={item.today.usageRecorded ? "success" : "neutral"}>
                      {item.today.usageRecorded ? t("tab.usageToday") : t("tab.noUsageToday")}
                    </StatusBadge>
                    {item.today.litres !== "0.0" ? (
                      <StatusBadge tone="info">
                        {t("tab.fuelToday", { litres: item.today.litres })}
                      </StatusBadge>
                    ) : null}
                    {item.operators.length ? (
                      <span className="text-muted-foreground">
                        {t("tab.operators", {
                          names: item.operators.map((operator) => operator.name).join(", "),
                        })}
                      </span>
                    ) : null}
                    {permissions.canRecordUsage ? (
                      <Link className="underline" href={`${base}/usage?plantId=${item.id}`}>
                        {t("tab.logUsage", { code: item.code })}
                      </Link>
                    ) : null}
                    {permissions.canRecordFuel && item.fuelType !== "none" ? (
                      <Link className="underline" href={`${base}/fuel?plantId=${item.id}`}>
                        {t("tab.logFuel", { code: item.code })}
                      </Link>
                    ) : null}
                  </div>
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">{t("tab.empty")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("alerts.estimateNote")}</p>
    </section>
  );
}
