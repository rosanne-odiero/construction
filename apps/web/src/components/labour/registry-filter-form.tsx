"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { isIdentifierSearch } from "@pm-buddy/domain";
import {
  labourersResponseSchema,
  labourRegistryFiltersSchema,
  type LabourerSummary,
  type LabourRegistryFilters,
} from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { registryHref } from "@/lib/labour";
import { DoNotRehireBadge, LabourerStatusBadge } from "./labour-badges";

type Matches = { labourers: LabourerSummary[] };

/**
 * The registry's filter bar. Selects and name/worker-number searches navigate (they are safe in
 * the URL); a term that could be an ID, phone or KRA PIN is sent only in the body of
 * `POST /labour/labourers/lookup` and its matches are shown here, so the identifier never appears
 * in the address bar, browser history, server logs or sign-in redirects (review finding). The
 * search box has no `name`, so even a native form submission cannot put it in the URL.
 */
export function RegistryFilterForm({
  filters,
  filtered,
  children,
}: {
  filters: LabourRegistryFilters;
  filtered: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("labourLive");
  const router = useRouter();
  const problem = useProblemMessage();
  const [search, setSearch] = useState(filters.search ?? "");
  const [matches, setMatches] = useState<Matches | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function lookup(identifier: string) {
    setBusy(true);
    setFailure(null);
    try {
      const result = await liveRequest("/labour/labourers/lookup", labourersResponseSchema, {
        method: "POST",
        body: { identifier },
      });
      setMatches({ labourers: result.labourers });
    } catch (error) {
      setMatches(null);
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  function submit(form: HTMLFormElement) {
    const term = search.trim();
    if (term && isIdentifierSearch(term)) {
      void lookup(term);
      return;
    }
    setMatches(null);
    setFailure(null);
    const picked: Record<string, string> = {};
    for (const [key, value] of new FormData(form))
      if (typeof value === "string" && value.trim()) picked[key] = value.trim();
    if (term) picked.search = term;
    const parsed = labourRegistryFiltersSchema.safeParse(picked);
    router.push(registryHref(parsed.success ? parsed.data : {}));
  }

  return (
    <div className="space-y-4">
      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(event.currentTarget);
        }}
      >
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <label htmlFor="labour-search" className="text-sm font-medium">
            {t("filters.search")}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="labour-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("filters.searchPlaceholder")}
              maxLength={100}
              autoComplete="off"
              className="pl-8"
              aria-describedby="labour-search-hint"
            />
          </div>
          <p id="labour-search-hint" className="text-xs text-muted-foreground">
            {t("filters.identifierHint")}
          </p>
        </div>
        {children}
        <Button type="submit" variant="secondary" disabled={busy}>
          {t("filters.apply")}
        </Button>
        {filtered || matches ? (
          <Button asChild variant="ghost">
            <Link
              href="/labour"
              onClick={() => {
                setSearch("");
                setMatches(null);
              }}
            >
              {t("filters.clear")}
            </Link>
          </Button>
        ) : null}
      </form>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {matches ? (
        <section
          aria-labelledby="identifier-matches"
          className="space-y-2 rounded-lg border border-info/30 bg-info/5 p-4"
        >
          <h2 id="identifier-matches" className="text-sm font-semibold">
            {t("lookup.title")}
          </h2>
          <p role="status" className="text-sm text-muted-foreground">
            {matches.labourers.length
              ? t("lookup.count", { count: matches.labourers.length })
              : t("lookup.none")}
          </p>
          {matches.labourers.length ? (
            <ul className="divide-y">
              {matches.labourers.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Link
                    href={registryHref(filters, { worker: row.id })}
                    scroll={false}
                    className="font-medium hover:underline"
                  >
                    {row.fullName}
                  </Link>
                  <span className="font-mono text-xs text-muted-foreground">{row.workerNo}</span>
                  <span className="font-mono text-xs">{row.idNumberMasked}</span>
                  <LabourerStatusBadge status={row.status} />
                  {row.doNotRehire ? <DoNotRehireBadge /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setMatches(null);
              setSearch("");
            }}
          >
            {t("lookup.clear")}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
