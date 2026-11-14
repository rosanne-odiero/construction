import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import type { ProjectOption } from "@/lib/p2p-server";

const selectClass =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";

/** One more select on a list's filter form (e.g. the invoice source). */
export type ExtraFilter = {
  name: string;
  label: string;
  allLabel: string;
  options: { value: string; label: string }[];
  value?: string;
};

/** Project and status filters for a procure-to-pay list (a GET form; the URL keeps them). */
export async function ListFilters({
  action,
  projects,
  statuses,
  project,
  status,
  extra,
}: {
  action: string;
  projects: ProjectOption[];
  statuses: { value: string; label: string }[];
  project?: string;
  status?: string;
  extra?: ExtraFilter;
}) {
  const t = await getTranslations("p2p.common");
  const filtered = Boolean(project || status || extra?.value);
  return (
    <form
      key={`${project ?? ""}|${status ?? ""}|${extra?.value ?? ""}`}
      method="get"
      action={action}
      className="flex flex-wrap items-end gap-3 print:hidden"
      role="search"
    >
      <div className="space-y-1.5">
        <label htmlFor="filter-project" className="block text-sm font-medium">
          {t("project")}
        </label>
        <select
          id="filter-project"
          name="project"
          defaultValue={project ?? ""}
          className={`${selectClass} max-w-[16rem]`}
        >
          <option value="">{t("allProjects")}</option>
          {projects.map((option) => (
            <option key={option.id} value={option.id}>
              {option.code} · {option.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="filter-status" className="block text-sm font-medium">
          {t("status")}
        </label>
        <select
          id="filter-status"
          name="status"
          defaultValue={status ?? ""}
          className={selectClass}
        >
          <option value="">{t("allStatuses")}</option>
          {statuses.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {extra ? (
        <div className="space-y-1.5">
          <label htmlFor={`filter-${extra.name}`} className="block text-sm font-medium">
            {extra.label}
          </label>
          <select
            id={`filter-${extra.name}`}
            name={extra.name}
            defaultValue={extra.value ?? ""}
            className={selectClass}
          >
            <option value="">{extra.allLabel}</option>
            {extra.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Button type="submit" variant="secondary">
        {t("apply")}
      </Button>
      {filtered ? (
        <Button asChild variant="ghost">
          <Link href={action}>{t("clear")}</Link>
        </Button>
      ) : null}
    </form>
  );
}

/** First/next page links for a cursor-paged list. */
export async function Pager({
  label,
  firstHref,
  nextHref,
  paged,
}: {
  label: string;
  firstHref: string;
  nextHref: string | null;
  paged: boolean;
}) {
  const t = await getTranslations("p2p.common");
  if (!paged && !nextHref) return null;
  return (
    <nav className="flex gap-2 print:hidden" aria-label={label}>
      {paged ? (
        <Button asChild variant="outline">
          <Link href={firstHref}>{t("firstPage")}</Link>
        </Button>
      ) : null}
      {nextHref ? (
        <Button asChild variant="outline">
          <Link href={nextHref}>{t("nextPage")}</Link>
        </Button>
      ) : null}
    </nav>
  );
}

/** Builds list URLs that keep the filters. */
export function listHrefs(
  base: string,
  filters: Record<string, string | undefined>,
  nextCursor: string | null,
) {
  const params = new URLSearchParams(
    Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const first = `${base}${params.size ? `?${params.toString()}` : ""}`;
  if (!nextCursor) return { first, next: null };
  params.set("cursor", nextCursor);
  return { first, next: `${base}?${params.toString()}` };
}

/** API query string for a list: projectId/status/cursor (UUID and enum checked by the caller). */
export function apiQuery(filters: Record<string, string | undefined>) {
  const params = new URLSearchParams(
    Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return params.size ? `?${params.toString()}` : "";
}
