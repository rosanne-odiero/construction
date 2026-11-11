import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { UserPlus } from "lucide-react";
import { LABOURER_STATUSES } from "@pm-buddy/types";
import {
  accreditationAlertsResponseSchema,
  gangsResponseSchema,
  labourerResponseSchema,
  labourersResponseSchema,
  labourSetupResponseSchema,
  labourViewsResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  AccreditationBadge,
  ConsentBadge,
  DoNotRehireBadge,
  LabourerStatusBadge,
  localName,
} from "@/components/labour/labour-badges";
import { LabourNav } from "@/components/labour/labour-nav";
import { RegistryFilterForm } from "@/components/labour/registry-filter-form";
import { DeleteViewButton, SaveViewButton } from "@/components/labour/saved-views";
import { WorkerPanel } from "@/components/labour/worker-panel";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  activeView,
  filtersFromSearchParams,
  LABOUR_PAGE_SIZE,
  labourQuery,
  registryHref,
  viewFilters,
} from "@/lib/labour";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

export default async function LabourPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const filters = filtersFromSearchParams(raw);
  const offsetValue = typeof raw.offset === "string" ? Number(raw.offset) : 0;
  const offset = Number.isInteger(offsetValue) && offsetValue > 0 ? offsetValue : 0;
  const worker = typeof raw.worker === "string" && UUID.test(raw.worker) ? raw.worker : undefined;
  const path = registryHref(filters, { offset: offset || undefined, worker });
  // An identifier typed into the address bar is dropped and removed from the URL, so it is not
  // forwarded to the API, kept in sign-in redirects or left on screen (review finding).
  if (typeof raw.search === "string" && raw.search.trim() && !filters.search) redirect(path);

  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const list = await loadLive(
    `/labour/labourers?${labourQuery(filters, { limit: LABOUR_PAGE_SIZE, offset })}`,
    labourersResponseSchema,
    path,
  );
  if (!list.ok)
    return list.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const [setup, views, gangs, alerts, detail] = [
    await serverApi("/labour/setup", labourSetupResponseSchema),
    await serverApi("/labour/views", labourViewsResponseSchema),
    await serverApi("/labour/gangs", gangsResponseSchema),
    await serverApi("/labour/accreditation-alerts", accreditationAlertsResponseSchema),
    worker ? await serverApi(`/labour/labourers/${worker}`, labourerResponseSchema) : null,
  ];
  const t = await getTranslations("labourLive");
  const locale = await getLocale();
  const { labourers, total, permissions } = list.data;
  const trades = setup.ok ? setup.data.trades : [];
  const skillLevels = setup.ok ? setup.data.skillLevels : [];
  const viewList = views.ok ? views.data.views : [];
  const current = activeView(viewList, filters);
  const filtered = labourQuery(filters) !== "";
  // Saved views keep structured filters only, never search text.
  const savable = labourQuery(viewFilters(filters)) !== "";
  const projects = new Map<string, string>();
  for (const row of labourers)
    for (const project of row.projects) projects.set(project.projectId, project.code);
  if (filters.projectId && !projects.has(filters.projectId)) projects.set(filters.projectId, "…");
  const closeHref = registryHref(filters, { offset: offset || undefined });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("title")}
        description={t("description", { company: session.company.name })}
        actions={
          permissions.canRegister ? (
            <Button asChild>
              <Link href="/labour/register">
                <UserPlus aria-hidden /> {t("actions.register")}
              </Link>
            </Button>
          ) : null
        }
      />
      <LabourNav current="registry" alerts={alerts.ok ? alerts.data.alerts.length : undefined} />

      <section aria-labelledby="views-heading" className="space-y-2">
        <h2 id="views-heading" className="text-sm font-medium">
          {t("views.label")}
        </h2>
        <ul className="flex flex-wrap items-center gap-2">
          {viewList.map((view) => {
            const selected = current?.id === view.id;
            return (
              <li key={view.id} className="flex items-center">
                <Link
                  href={registryHref(view.filters)}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center rounded-full border px-3 text-sm",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {view.builtIn ? t(`views.${view.id as "all"}`) : view.name}
                </Link>
                {!view.builtIn ? <DeleteViewButton id={view.id} name={view.name} /> : null}
              </li>
            );
          })}
          {savable && !current ? (
            <li>
              <SaveViewButton filters={viewFilters(filters)} />
            </li>
          ) : null}
        </ul>
      </section>

      {/* Keyed by the query so uncontrolled fields reset after "Clear filters" or back/forward. */}
      <RegistryFilterForm key={labourQuery(filters)} filters={filters} filtered={filtered}>
        <FilterSelect
          id="labour-status"
          name="status"
          label={t("filters.status")}
          value={filters.status}
        >
          <option value="">{t("filters.anyStatus")}</option>
          {LABOURER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`status.${status}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          id="labour-trade"
          name="tradeId"
          label={t("filters.trade")}
          value={filters.tradeId}
        >
          <option value="">{t("filters.anyTrade")}</option>
          {trades.map((trade) => (
            <option key={trade.id} value={trade.id}>
              {localName(trade, locale)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          id="labour-skill"
          name="skillLevelId"
          label={t("filters.skill")}
          value={filters.skillLevelId}
        >
          <option value="">{t("filters.anySkill")}</option>
          {skillLevels.map((level) => (
            <option key={level.id} value={level.id}>
              {localName(level, locale)}
            </option>
          ))}
        </FilterSelect>
        {gangs.ok && gangs.data.gangs.length ? (
          <FilterSelect
            id="labour-gang"
            name="gangId"
            label={t("filters.gang")}
            value={filters.gangId}
          >
            <option value="">{t("filters.anyGang")}</option>
            {gangs.data.gangs.map((gang) => (
              <option key={gang.id} value={gang.id}>
                {gang.projectCode} · {gang.name}
              </option>
            ))}
          </FilterSelect>
        ) : null}
        <FilterSelect
          id="labour-accreditation"
          name="accreditation"
          label={t("filters.accreditation")}
          value={filters.accreditation}
        >
          <option value="">{t("filters.anyAccreditation")}</option>
          {(["attention", "expiring", "expired", "missing", "valid"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`filters.accreditationValues.${value}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          id="labour-consent"
          name="consent"
          label={t("filters.consent")}
          value={filters.consent}
        >
          <option value="">{t("filters.anyConsent")}</option>
          <option value="withdrawn">{t("consentStatus.withdrawn")}</option>
          <option value="outdated">{t("consentStatus.outdated")}</option>
        </FilterSelect>
        {filters.projectId ? (
          <input type="hidden" name="projectId" value={filters.projectId} />
        ) : null}
        {filters.doNotRehire ? <input type="hidden" name="doNotRehire" value="true" /> : null}
      </RegistryFilterForm>

      <p className="text-sm text-muted-foreground" role="status">
        {t("count", { count: total })}
        {total > LABOUR_PAGE_SIZE
          ? ` · ${t("showing", {
              from: offset + 1,
              to: Math.min(offset + LABOUR_PAGE_SIZE, total),
              total,
            })}`
          : null}
      </p>

      <div className="relative overflow-x-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">{t("table.caption")}</TableCaption>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("table.worker")}</TableHead>
              <TableHead>{t("table.trade")}</TableHead>
              <TableHead>{t("table.projects")}</TableHead>
              <TableHead>{t("table.nca")}</TableHead>
              <TableHead>{t("table.consent")}</TableHead>
              <TableHead>{t("table.phone")}</TableHead>
              <TableHead>{t("table.id")}</TableHead>
              <TableHead>{t("table.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {labourers.map((row) => (
              <TableRow key={row.id} data-state={row.id === worker ? "selected" : undefined}>
                <TableCell>
                  <Link
                    href={registryHref(filters, { offset: offset || undefined, worker: row.id })}
                    scroll={false}
                    className="font-medium hover:underline"
                  >
                    {row.fullName}
                  </Link>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {row.workerNo}
                  </span>
                  {row.doNotRehire ? (
                    <span className="mt-1 block">
                      <DoNotRehireBadge />
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span className="block text-sm">{localName(row.trade, locale)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {localName(row.skillLevel, locale)}
                  </span>
                </TableCell>
                <TableCell className="text-sm">
                  {row.projects.length ? (
                    <span className="font-mono text-xs">
                      {row.projects.map((project) => project.code).join(", ")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("table.noProjects")}</span>
                  )}
                  {row.gang ? (
                    <span className="block text-xs text-muted-foreground">{row.gang.name}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <AccreditationBadge accreditation={row.accreditation} />
                </TableCell>
                <TableCell>
                  <ConsentBadge consent={row.consent} />
                </TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  {row.phoneMasked ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  {row.idNumberMasked}
                </TableCell>
                <TableCell>
                  <LabourerStatusBadge status={row.status} />
                </TableCell>
              </TableRow>
            ))}
            {labourers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  {filtered ? t("table.emptyFiltered") : t("table.empty")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      {total > LABOUR_PAGE_SIZE ? (
        <nav aria-label={t("table.pages")} className="flex justify-between gap-2">
          {offset > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={registryHref(filters, {
                  offset: Math.max(0, offset - LABOUR_PAGE_SIZE) || undefined,
                })}
              >
                {t("table.previous")}
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {offset + LABOUR_PAGE_SIZE < total ? (
            <Button asChild variant="outline" size="sm">
              <Link href={registryHref(filters, { offset: offset + LABOUR_PAGE_SIZE })}>
                {t("table.next")}
              </Link>
            </Button>
          ) : null}
        </nav>
      ) : null}

      <p className="text-sm text-muted-foreground">
        <Link href="/prototype/labour" className="underline underline-offset-4">
          {t("actions.prototypeLink")}
        </Link>
      </p>

      {detail ? (
        detail.ok ? (
          <WorkerPanel
            key={`${detail.data.labourer.id}:${detail.data.labourer.version}`}
            labourer={detail.data.labourer}
            closeHref={closeHref}
            setup={setup.ok ? setup.data : null}
          />
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t("panel.unavailable")}
          </p>
        )
      ) : null}
    </div>
  );
}

function FilterSelect({
  id,
  name,
  label,
  value,
  children,
}: {
  id: string;
  name: string;
  label: string;
  value: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value ?? ""} className={selectClass}>
        {children}
      </select>
    </div>
  );
}
