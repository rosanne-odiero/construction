import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PLANT_CATEGORIES, PLANT_STATUSES } from "@pm-buddy/types";
import {
  plantAlertsResponseSchema,
  plantListQuerySchema,
  plantListResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { PlantCard } from "@/components/plant/plant-card";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Pager } from "@/components/safety/common";
import { selectClass } from "@/components/schedule/use-schedule-mutation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { alertTone } from "@/lib/plant";
import { loadLive, requireSession } from "@/lib/server-api";

const PATH = "/plant";
type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

export async function generateMetadata() {
  const t = await getTranslations("plant");
  return { title: t("title") };
}

/** Plant and equipment (D8.3): what needs attention and the company register. */
export default async function PlantPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = plantListQuerySchema.safeParse({
    status: one(params["status"]),
    category: one(params["category"]),
    ownership: one(params["ownership"]),
    projectId: one(params["projectId"]),
    attention: one(params["attention"]),
    search: one(params["search"]),
    cursor: one(params["cursor"]),
  });
  const values = filters.success ? filters.data : { limit: 30 };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && key !== "limit") query.set(key, String(value));
  const session = await requireSession(PATH);
  if (!session) return <LiveUnavailable retryHref={PATH} />;
  const [list, alerts] = await Promise.all([
    loadLive(`/plant${query.size ? `?${query.toString()}` : ""}`, plantListResponseSchema, PATH),
    loadLive("/plant/alerts?limit=8", plantAlertsResponseSchema, PATH),
  ]);
  if (!list.ok || !alerts.ok)
    return (!list.ok && list.status === 403) || (!alerts.ok && alerts.status === 403) ? (
      <LiveForbidden />
    ) : (
      <LiveUnavailable retryHref={PATH} />
    );
  const t = await getTranslations("plant");
  const tProject = await getTranslations("projectDetail");
  const { counts, permissions, items, nextCursor } = list.data;
  const kept = new URLSearchParams(query);
  kept.delete("cursor");
  const page = (cursor: number | null) => {
    const next = new URLSearchParams(kept);
    if (cursor) next.set("cursor", String(cursor));
    return `${PATH}${next.size ? `?${next.toString()}` : ""}`;
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        eyebrow={<StatusBadge tone="info">{tProject("live")}</StatusBadge>}
        actions={
          <>
            {permissions.canRegister ? (
              <Button asChild>
                <Link href="/plant/new">{t("register.new")}</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href="/plant/settings">{t("settings.title")}</Link>
            </Button>
          </>
        }
      />
      <ul className="flex flex-wrap gap-2" aria-label={t("register.countsLabel")}>
        {(
          [
            ["total", counts.total, "neutral"],
            ["onSite", counts.onSite, "success"],
            ["available", counts.available, "info"],
            ["underRepair", counts.underRepair, counts.underRepair ? "warning" : "neutral"],
            ["hired", counts.hired, "neutral"],
            ["attention", counts.attention, counts.attention ? "danger" : "neutral"],
          ] as const
        ).map(([key, count, tone]) => (
          <li key={key}>
            <StatusBadge tone={tone} className="h-auto whitespace-normal">
              {t(`register.counts.${key}`, { count })}
            </StatusBadge>
          </li>
        ))}
      </ul>

      <section aria-labelledby="plant-alerts" className="space-y-3">
        <h2 id="plant-alerts" className="text-base font-semibold">
          {t("alerts.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("alerts.estimateNote")}</p>
        {alerts.data.alerts.length ? (
          <ul className="divide-y rounded-md border">
            {alerts.data.alerts.map((alert) => (
              <li
                key={`${alert.plantId}-${alert.kind}`}
                className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
              >
                <Link
                  href={`/plant/${alert.plantId}`}
                  className="underline-offset-2 hover:underline"
                >
                  <span className="mr-2 font-mono">{alert.code}</span>
                  {alert.name}
                  {alert.location
                    ? ` · ${alert.location.projectCode} ${alert.location.siteName}`
                    : ""}
                </Link>
                <StatusBadge tone={alertTone[alert.severity]} className="h-auto whitespace-normal">
                  {t(`alertKind.${alert.kind}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("alerts.none")}</p>
        )}
      </section>

      <section aria-labelledby="plant-register" className="space-y-3">
        <h2 id="plant-register" className="text-base font-semibold">
          {t("register.title")}
        </h2>
        <form
          method="get"
          action={PATH}
          className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_2fr_auto] lg:items-end"
        >
          <Field>
            <FieldLabel htmlFor="plant-status">{t("filters.status")}</FieldLabel>
            <select
              id="plant-status"
              name="status"
              className={selectClass}
              defaultValue={values.status ?? ""}
            >
              <option value="">{t("filters.all")}</option>
              <option value="active">{t("filters.active")}</option>
              {PLANT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="plant-category">{t("form.category")}</FieldLabel>
            <select
              id="plant-category"
              name="category"
              className={selectClass}
              defaultValue={values.category ?? ""}
            >
              <option value="">{t("filters.all")}</option>
              {PLANT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`category.${category}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="plant-ownership">{t("form.ownership")}</FieldLabel>
            <select
              id="plant-ownership"
              name="ownership"
              className={selectClass}
              defaultValue={values.ownership ?? ""}
            >
              <option value="">{t("filters.all")}</option>
              <option value="owned">{t("ownership.owned")}</option>
              <option value="hired">{t("ownership.hired")}</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="plant-search">{t("filters.search")}</FieldLabel>
            <Input
              id="plant-search"
              name="search"
              type="search"
              maxLength={100}
              defaultValue={values.search ?? ""}
              placeholder={t("filters.searchPlaceholder")}
            />
          </Field>
          <Button type="submit" variant="outline">
            {t("filters.apply")}
          </Button>
          <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-5">
            <input
              type="checkbox"
              name="attention"
              value="true"
              defaultChecked={values.attention === "true"}
              className="size-4 accent-primary"
            />
            {t("filters.attention")}
          </label>
        </form>
        {items.length ? (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {items.map((item) => (
              <li key={item.id}>
                <PlantCard item={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{t("register.empty")}</p>
        )}
        <Pager
          label={t("register.pages")}
          firstHref={values.cursor ? page(null) : null}
          nextHref={nextCursor ? page(nextCursor) : null}
          offset
        />
      </section>
      <p className="text-xs text-muted-foreground">{t("complianceNote")}</p>
    </div>
  );
}
