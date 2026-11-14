import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { BUDGET_SOURCES } from "@pm-buddy/types";
import { budgetsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveUnavailable } from "@/components/projects/live-state";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { SpendingAction, spendingSelectClass } from "@/components/spending/spending-action";
import { SpendingEyebrow, SpendingSubnav } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatKES } from "@/lib/format";
import { projectOptions } from "@/lib/p2p-server";
import { pickParam } from "@/lib/p2p";
import { requireSession, serverApi } from "@/lib/server-api";
import { budgetStatusTone } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.budgets");
  return { title: t("title") };
}

/** A project's budget versions: the one in force, drafts being prepared and history (D5.4). */
export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const projects = await projectOptions();
  const chosen = pickParam(raw, "project");
  const project = isUuid(chosen) ? chosen : projects[0]?.id;
  const path = `/spending/budgets${project ? `?project=${project}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("spending.budgets");
  const tStatus = await getTranslations("spending.status");
  const result = project
    ? await serverApi(`/budgets?projectId=${project}`, budgetsResponseSchema)
    : null;
  if (result && !result.ok && result.status !== 403 && result.status !== 404)
    return <LiveUnavailable retryHref={path} />;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<SpendingEyebrow />} title={t("title")} description={t("description")} />
      <SpendingSubnav current="budgets" />
      <form
        method="get"
        action="/spending/budgets"
        role="search"
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-0 space-y-1.5">
          <label htmlFor="budgets-project" className="block text-sm font-medium">
            {t("project")}
          </label>
          <select
            id="budgets-project"
            name="project"
            defaultValue={project ?? ""}
            className={`${spendingSelectClass} max-w-xs`}
          >
            {projects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} · {option.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="secondary">
          {t("show")}
        </Button>
      </form>
      {!result ? (
        <p className="text-sm text-muted-foreground">{t("noProjects")}</p>
      ) : !result.ok ? (
        <SentenceBadge tone="warning">{t("forbidden")}</SentenceBadge>
      ) : (
        <section aria-labelledby="versions" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="versions" className="text-lg font-semibold">
              {t("versionsTitle", { code: result.data.project.code })}
            </h2>
            {result.data.permissions.canCreate ? (
              <SpendingAction
                path="/budgets"
                entity="budget"
                body={{ projectId: result.data.project.id }}
                openResult
                primary
                fields={[
                  { kind: "text", name: "name", label: t("name"), maxLength: 120 },
                  {
                    kind: "select",
                    name: "source",
                    label: t("source"),
                    defaultValue: "bq",
                    options: BUDGET_SOURCES.map((source) => ({
                      value: source,
                      label: t(`sources.${source}`),
                    })),
                  },
                ]}
                text={{
                  button: t("create"),
                  title: t("createTitle"),
                  description: t("createDescription"),
                  confirm: t("create"),
                }}
              />
            ) : null}
          </div>
          {result.data.budgets.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm">{t("empty")}</p>
          ) : (
            <ul className="space-y-2">
              {result.data.budgets.map((budget) => (
                <li
                  key={budget.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/spending/budgets/${budget.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {t("versionLabel", { version: budget.versionNo, name: budget.name })}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {t("lines", { count: budget.lineCount })} ·{" "}
                      {budget.approvedBy && budget.approvedAt
                        ? t("approvedBy", {
                            name: budget.approvedBy.displayName,
                            date: formatDate(budget.approvedAt),
                          })
                        : t("createdBy", {
                            name: budget.createdBy.displayName,
                            date: formatDate(budget.createdAt),
                          })}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{formatKES(budget.totalMinor)}</span>
                    <StatusBadge tone={budgetStatusTone[budget.status]}>
                      {tStatus(`budget.${budget.status}`)}
                    </StatusBadge>
                    {budget.current ? (
                      <StatusBadge tone="success">{t("inForce")}</StatusBadge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
