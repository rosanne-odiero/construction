import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { custodiansResponseSchema, floatsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SpendingAction } from "@/components/spending/spending-action";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("spending.pettyCash");
  return { title: t("title") };
}

/** Petty-cash floats per site with their custodian, balance and open items (D5.4). */
export default async function PettyCashPage() {
  const path = "/spending/petty-cash";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect("/petty-cash/floats", floatsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.pettyCash");
  const { floats, sitesWithoutFloat } = result.data;
  const creatable = [
    ...new Set(
      sitesWithoutFloat.filter((entry) => entry.canCreate).map((entry) => entry.project.id),
    ),
  ].slice(0, 30);
  const custodians = Object.fromEntries(
    await Promise.all(
      creatable.map(async (projectId) => {
        const people = await serverApi(
          `/petty-cash/floats/custodians?projectId=${projectId}`,
          custodiansResponseSchema,
        );
        return [projectId, people.ok ? people.data.people : []] as const;
      }),
    ),
  );

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="pettyCash" />
      <section aria-labelledby="floats" className="space-y-3">
        <h2 id="floats" className="text-lg font-semibold">
          {t("floatsTitle")}
        </h2>
        {floats.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("noFloats")}</p>
        ) : (
          <ScrollTable label={t("floatsTitle")} minWidth={760}>
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {t("cols.float")}
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  {t("cols.custodian")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.balance")}
                </th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.limit")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("cols.open")}
                </th>
              </tr>
            </thead>
            <tbody>
              {floats.map((float) => (
                <tr key={float.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    <Link
                      href={`/spending/petty-cash/${float.id}`}
                      className="underline underline-offset-4"
                    >
                      {float.name}
                    </Link>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {float.project.code} · {float.site.name}
                      {float.lastEntryAt
                        ? ` · ${t("lastEntry", { when: formatDateTime(float.lastEntryAt) })}`
                        : ""}
                    </span>
                  </th>
                  <td className="py-2 pr-2">{float.custodian.displayName}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(float.balanceMinor)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatKES(float.limitMinor)}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="flex flex-wrap gap-1">
                      {float.status === "closed" ? (
                        <StatusBadge tone="neutral">{t("closed")}</StatusBadge>
                      ) : null}
                      {float.submittedExpenses ? (
                        <StatusBadge tone="info">
                          {t("expensesWaiting", { count: float.submittedExpenses })}
                        </StatusBadge>
                      ) : null}
                      {float.openTopUps ? (
                        <StatusBadge tone="warning">
                          {t("topUpsOpen", { count: float.openTopUps })}
                        </StatusBadge>
                      ) : null}
                      {float.openCount ? (
                        <StatusBadge tone="info">{t("countOpen")}</StatusBadge>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </section>
      {sitesWithoutFloat.length ? (
        <section aria-labelledby="without-float" className="space-y-3">
          <h2 id="without-float" className="text-lg font-semibold">
            {t("withoutFloat")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("withoutFloatHint")}</p>
          <ul className="space-y-2">
            {sitesWithoutFloat.map((entry) => {
              const people = custodians[entry.project.id] ?? [];
              return (
                <li
                  key={entry.site.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                >
                  <span>
                    {entry.project.code} · {entry.site.name}
                  </span>
                  {entry.canCreate && people.length ? (
                    <SpendingAction
                      path="/petty-cash/floats"
                      entity="float"
                      body={{ siteId: entry.site.id }}
                      openResult
                      fields={[
                        { kind: "text", name: "name", label: t("floatName"), maxLength: 120 },
                        {
                          kind: "select",
                          name: "custodianUserId",
                          label: t("custodian"),
                          options: people.map((person) => ({
                            value: person.id,
                            label: person.displayName,
                          })),
                        },
                        { kind: "money", name: "limitMinor", label: t("limit") },
                      ]}
                      text={{
                        button: t("create"),
                        title: t("createTitle", { site: entry.site.name }),
                        description: t("createDescription"),
                        confirm: t("create"),
                      }}
                    />
                  ) : (
                    <span className="text-muted-foreground">
                      {entry.canCreate ? t("noCustodians") : t("noPermission")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
