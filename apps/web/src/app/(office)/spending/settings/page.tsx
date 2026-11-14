import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { COST_CATEGORIES } from "@pm-buddy/types";
import { costCodesResponseSchema, spendingSettingsResponseSchema } from "@pm-buddy/validation";
import { listHrefs, Pager } from "@/components/procurement/p2p/list-filters";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SettingsForm } from "@/components/spending/settings-form";
import { SpendingAction } from "@/components/spending/spending-action";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("spending.settings");
  return { title: t("title") };
}

/** Company spending settings and cost codes (D5.4). */
export default async function SpendingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const search = pickParam(raw, "search")?.slice(0, 60);
  const cursorParam = pickParam(raw, "cursor");
  const cursor = cursorParam && /^[A-Z0-9-]{1,40}$/.test(cursorParam) ? cursorParam : undefined;
  const path = "/spending/settings";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const query = new URLSearchParams({ includeInactive: "true", limit: "50" });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  const [result, codes] = await Promise.all([
    loadOrRedirect("/spending/settings", spendingSettingsResponseSchema, path),
    serverApi(`/cost-codes?${query.toString()}`, costCodesResponseSchema),
  ]);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.settings");
  const tCategory = await getTranslations("spending.categories");
  const { settings, permissions } = result.data;
  const canManage = codes.ok && codes.data.permissions.canManage;
  const hrefs = listHrefs(
    "/spending/settings",
    { search },
    codes.ok ? codes.data.page.nextCursor : null,
  );
  const categoryOptions = COST_CATEGORIES.map((value) => ({ value, label: tCategory(value) }));

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="settings" />
      <section aria-labelledby="rules" className="space-y-3">
        <h2 id="rules" className="text-lg font-semibold">
          {t("rulesTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {settings.updatedAt
            ? t("updated", { when: formatDateTime(settings.updatedAt) })
            : t("defaults")}
        </p>
        <SettingsForm settings={settings} canEdit={permissions.canEdit} />
      </section>
      <section aria-labelledby="cost-codes" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cost-codes" className="text-lg font-semibold">
            {t("codesTitle")}
          </h2>
          {canManage ? (
            <span className="flex flex-wrap gap-2">
              <SpendingAction
                path="/cost-codes/defaults"
                entity="costCodeDefaults"
                text={{
                  button: t("loadDefaults"),
                  title: t("loadDefaultsTitle"),
                  description: t("loadDefaultsDescription"),
                  confirm: t("loadDefaults"),
                }}
              />
              <SpendingAction
                path="/cost-codes"
                entity="costCode"
                primary
                fields={[
                  { kind: "text", name: "code", label: t("code"), maxLength: 20 },
                  { kind: "text", name: "name", label: t("name"), maxLength: 120 },
                  {
                    kind: "select",
                    name: "category",
                    label: t("category"),
                    options: categoryOptions,
                  },
                ]}
                text={{
                  button: t("addCode"),
                  title: t("addCodeTitle"),
                  description: t("addCodeDescription"),
                  confirm: t("addCode"),
                }}
              />
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{t("codesHint")}</p>
        <form
          method="get"
          action="/spending/settings"
          role="search"
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
            <label htmlFor="codes-search" className="block text-sm font-medium">
              {t("search")}
            </label>
            <Input id="codes-search" name="search" defaultValue={search ?? ""} maxLength={60} />
          </div>
          <Button type="submit" variant="secondary">
            {t("apply")}
          </Button>
          {search ? (
            <Button asChild variant="ghost">
              <Link href="/spending/settings">{t("clear")}</Link>
            </Button>
          ) : null}
        </form>
        {!codes.ok || codes.data.costCodes.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noCodes")}</p>
        ) : (
          <ScrollTable label={t("codesTitle")} minWidth={600}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("code")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("name")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("category")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("state")}
                </th>
              </tr>
            </thead>
            <tbody>
              {codes.data.costCodes.map((code) => (
                <tr key={code.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-mono font-medium">
                    {code.code}
                  </th>
                  <td className="py-2 pr-2">{code.name}</td>
                  <td className="py-2 pr-2">{tCategory(code.category)}</td>
                  <td className="py-2 pr-4">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={code.active ? "success" : "neutral"}>
                        {code.active ? t("active") : t("inactive")}
                      </StatusBadge>
                      {canManage ? (
                        <SpendingAction
                          path={`/cost-codes/${code.id}`}
                          method="PATCH"
                          entity="costCode"
                          body={{ version: code.version, active: !code.active }}
                          text={{
                            button: code.active ? t("deactivate") : t("activate"),
                            title: t(code.active ? "deactivateTitle" : "activateTitle", {
                              code: code.code,
                            }),
                            description: t(
                              code.active ? "deactivateDescription" : "activateDescription",
                            ),
                            confirm: code.active ? t("deactivate") : t("activate"),
                          }}
                        />
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        <Pager
          label={t("codesTitle")}
          firstHref={hrefs.first}
          nextHref={hrefs.next}
          paged={Boolean(cursor)}
        />
      </section>
    </div>
  );
}
