"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  FunctionSquare,
  Layers,
  Link2,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  bqBillResponseSchema,
  bqSearchResponseSchema,
  type BqBillResponse,
  type BqBillWire,
  type BqItemWire,
  type BqSearchResponse,
} from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDecimalString, formatKES } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { useUnitLabel } from "./bq-labels";
import { LinkBuildupDialog } from "./link-buildup-dialog";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: BqBillResponse };

function ItemRow({
  item,
  indent,
  onLink,
}: {
  item: BqItemWire;
  indent: boolean;
  onLink?: () => void;
}) {
  const t = useTranslations("liveBq.tree");
  const unit = useUnitLabel();
  return (
    <tr className="border-b align-top last:border-0">
      <td className={`py-2 pr-2 font-mono text-xs ${indent ? "pl-10" : "pl-4"}`}>
        {item.ref ?? ""}
      </td>
      <td className="max-w-xl py-2 pr-2 text-sm whitespace-pre-line">
        {item.description}
        <span className="mt-1 flex flex-wrap gap-1">
          {item.amountSource !== "computed" ? (
            <StatusBadge tone={item.amountSource === "sheet_override" ? "warning" : "neutral"}>
              {t(`amountSource.${item.amountSource}`)}
            </StatusBadge>
          ) : null}
          {item.hasFormula ? (
            <StatusBadge tone="info" icon={<FunctionSquare className="size-3" aria-hidden />}>
              {t("formula")}
            </StatusBadge>
          ) : null}
          {item.sourceSheet === null ? (
            <StatusBadge tone="info">{t("addedByVariation")}</StatusBadge>
          ) : null}
          {item.rateBuildUp ? (
            <StatusBadge tone="neutral" icon={<Layers className="size-3" aria-hidden />}>
              {t("buildUp", {
                code: item.rateBuildUp.code,
                version: item.rateBuildUp.versionNo,
                rate:
                  item.rateBuildUp.rateMinor === null
                    ? t("rateUnavailable")
                    : formatKES(item.rateBuildUp.rateMinor),
              })}
            </StatusBadge>
          ) : null}
          {onLink ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={onLink}
              aria-label={t(item.rateBuildUp ? "changeLinkLabel" : "linkLabel", {
                item: item.ref
                  ? `${item.ref} · ${item.description.slice(0, 40)}`
                  : item.description.slice(0, 40),
              })}
            >
              <Link2 className="size-3" aria-hidden />
              {item.rateBuildUp ? t("changeLink") : t("link")}
            </Button>
          ) : null}
        </span>
        {item.overrideReason ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("override", { reason: item.overrideReason })}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-2 text-sm">{unit(item.unit, item.unitRaw)}</td>
      <td className="py-2 pr-2 text-right text-sm tabular-nums">
        {item.quantity === null ? "" : formatDecimalString(item.quantity)}
      </td>
      <td className="py-2 pr-2 text-right text-sm tabular-nums">
        {item.rate === null ? "" : formatDecimalString(item.rate)}
      </td>
      <td className="py-2 pr-4 text-right text-sm tabular-nums">{formatKES(item.amountMinor)}</td>
    </tr>
  );
}

function ColumnHeads() {
  const t = useTranslations("liveBq.tree.cols");
  return (
    <thead>
      <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
        <th scope="col" className="w-20 py-2 pr-2 pl-4 font-medium">
          {t("ref")}
        </th>
        <th scope="col" className="py-2 pr-2 font-medium">
          {t("description")}
        </th>
        <th scope="col" className="w-16 py-2 pr-2 font-medium">
          {t("unit")}
        </th>
        <th scope="col" className="w-24 py-2 pr-2 text-right font-medium">
          {t("qty")}
        </th>
        <th scope="col" className="w-28 py-2 pr-2 text-right font-medium">
          {t("rate")}
        </th>
        <th scope="col" className="w-36 py-2 pr-4 text-right font-medium">
          {t("amount")}
        </th>
      </tr>
    </thead>
  );
}

/**
 * The BQ as an expandable tree: bills load their sections and items only when opened (so large
 * BQs stay usable), sections fold, and a search runs on the server across every bill.
 */
export function BqTree({
  projectId,
  bills,
  canLink = false,
}: {
  projectId: string;
  bills: BqBillWire[];
  /** bq.edit on an approved version: items can be linked to rate build-ups. */
  canLink?: boolean;
}) {
  const t = useTranslations("liveBq.tree");
  const tKinds = useTranslations("liveBq.kinds");
  const problem = useProblemMessage();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ query: string; result: BqSearchResponse } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ item: BqItemWire; billId: string | null } | null>(null);

  async function load(billId: string) {
    setLoaded((current) => ({ ...current, [billId]: { status: "loading" } }));
    try {
      const data = await liveRequest(
        `/projects/${projectId}/bq/bills/${billId}`,
        bqBillResponseSchema,
      );
      setLoaded((current) => ({ ...current, [billId]: { status: "ready", data } }));
    } catch (error) {
      setLoaded((current) => ({
        ...current,
        [billId]: { status: "error", message: problem(error) },
      }));
    }
  }

  function toggle(billId: string) {
    const next = new Set(open);
    if (next.has(billId)) next.delete(billId);
    else {
      next.add(billId);
      if (!loaded[billId] || loaded[billId]?.status === "error") void load(billId);
    }
    setOpen(next);
  }

  function toggleSection(sectionId: string) {
    const next = new Set(closedSections);
    if (next.has(sectionId)) next.delete(sectionId);
    else next.add(sectionId);
    setClosedSections(next);
  }

  async function refreshSearch(text: string) {
    try {
      const result = await liveRequest(
        `/projects/${projectId}/bq/search?q=${encodeURIComponent(text)}`,
        bqSearchResponseSchema,
      );
      setSearch({ query: text, result });
    } catch (error) {
      setSearchError(problem(error));
    }
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (text.length < 2) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await liveRequest(
        `/projects/${projectId}/bq/search?q=${encodeURIComponent(text)}`,
        bqSearchResponseSchema,
      );
      setSearch({ query: text, result });
    } catch (error) {
      setSearchError(problem(error));
    } finally {
      setSearching(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <form role="search" onSubmit={runSearch} className="flex flex-wrap items-center gap-2 px-6">
          <div className="relative w-full sm:w-80">
            <Search
              className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("search")}
              aria-label={t("searchLabel")}
              className="pl-8"
              minLength={2}
              maxLength={100}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={searching || query.trim().length < 2}>
            {searching ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("searchButton")}
          </Button>
          {search ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch(null);
                setQuery("");
              }}
            >
              <X aria-hidden /> {t("clear")}
            </Button>
          ) : null}
        </form>
        {searchError ? (
          <p role="alert" className="px-6 text-sm text-destructive">
            {searchError}
          </p>
        ) : null}

        {search ? (
          <section aria-label={t("resultsLabel")} className="space-y-2">
            <p role="status" className="px-6 text-sm text-muted-foreground">
              {t("results", { count: search.result.items.length })}
              {search.result.truncated ? ` ${t("truncated")}` : ""}
            </p>
            {search.result.items.length ? (
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <caption className="sr-only">{t("resultsLabel")}</caption>
                  <ColumnHeads />
                  <tbody>
                    {search.result.items.map((item) => (
                      <Fragment key={item.id}>
                        <tr className="bg-muted/30">
                          <td colSpan={6} className="py-1 pl-4 text-xs text-muted-foreground">
                            {t("billLabel", { number: item.billNumber })}
                            {item.sectionTitle ? ` · ${item.sectionTitle}` : ""}
                          </td>
                        </tr>
                        <ItemRow
                          item={item}
                          indent={false}
                          onLink={
                            canLink ? () => setLinking({ item, billId: item.billId }) : undefined
                          }
                        />
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : (
          <ul className="divide-y border-t">
            {bills.map((bill) => {
              const isOpen = open.has(bill.id);
              const state = loaded[bill.id];
              return (
                <li key={bill.id}>
                  <h3>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`bill-${bill.id}`}
                      onClick={() => toggle(bill.id)}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4 shrink-0" aria-hidden />
                      ) : (
                        <ChevronRight className="size-4 shrink-0" aria-hidden />
                      )}
                      <span className="font-semibold">
                        {t("billHeading", { number: bill.number, title: bill.title })}
                      </span>
                      <StatusBadge tone="neutral">{tKinds(bill.kind)}</StatusBadge>
                      <span className="text-xs text-muted-foreground">
                        {t("items", { count: bill.itemCount })}
                      </span>
                      <span className="ml-auto font-semibold tabular-nums">
                        {formatKES(bill.totalMinor)}
                      </span>
                    </button>
                  </h3>
                  <div id={`bill-${bill.id}`} hidden={!isOpen}>
                    {isOpen && state?.status === "loading" ? (
                      <p
                        role="status"
                        className="flex items-center gap-2 px-6 pb-4 text-sm text-muted-foreground"
                      >
                        <Loader2 className="size-4 animate-spin" aria-hidden /> {t("loading")}
                      </p>
                    ) : null}
                    {isOpen && state?.status === "error" ? (
                      <div
                        role="alert"
                        className="flex items-center gap-3 px-6 pb-4 text-sm text-destructive"
                      >
                        {state.message}
                        <Button size="sm" variant="outline" onClick={() => void load(bill.id)}>
                          {t("retry")}
                        </Button>
                      </div>
                    ) : null}
                    {isOpen && state?.status === "ready" ? (
                      <div className="relative overflow-x-auto pb-2">
                        <table className="w-full min-w-[640px] text-sm">
                          <caption className="sr-only">
                            {t("billHeading", { number: bill.number, title: bill.title })}
                          </caption>
                          <ColumnHeads />
                          <tbody>
                            {state.data.bill.sections.map((section) => {
                              const items = state.data.items.filter(
                                (item) => item.sectionId === section.id,
                              );
                              const sectionOpen = !closedSections.has(section.id);
                              return (
                                <Fragment key={section.id}>
                                  <tr className="border-b bg-muted/30">
                                    <td colSpan={5} className="py-2 pl-4">
                                      <button
                                        type="button"
                                        aria-expanded={sectionOpen}
                                        onClick={() => toggleSection(section.id)}
                                        className="flex items-center gap-1.5 text-left text-xs font-semibold tracking-wide uppercase"
                                      >
                                        {sectionOpen ? (
                                          <ChevronDown className="size-3.5" aria-hidden />
                                        ) : (
                                          <ChevronRight className="size-3.5" aria-hidden />
                                        )}
                                        {section.code ? `${section.code} · ` : ""}
                                        {section.title ?? t("untitled")}
                                        <span className="font-normal normal-case text-muted-foreground">
                                          ({t("items", { count: section.itemCount })})
                                        </span>
                                      </button>
                                      {sectionOpen && section.notes ? (
                                        <p className="mt-1 max-w-2xl pl-5 text-xs whitespace-pre-line text-muted-foreground">
                                          {section.notes}
                                        </p>
                                      ) : null}
                                    </td>
                                    <td className="py-2 pr-4 text-right text-xs tabular-nums">
                                      {formatKES(section.totalMinor)}
                                    </td>
                                  </tr>
                                  {sectionOpen
                                    ? items.map((item) => (
                                        <ItemRow
                                          key={item.id}
                                          item={item}
                                          indent
                                          onLink={
                                            canLink
                                              ? () => setLinking({ item, billId: bill.id })
                                              : undefined
                                          }
                                        />
                                      ))
                                    : null}
                                </Fragment>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="bg-accent/40 font-semibold">
                              <td colSpan={5} className="py-2 pl-4">
                                {t("billTotal", { number: bill.number })}
                              </td>
                              <td className="py-2 pr-4 text-right tabular-nums">
                                {formatKES(state.data.bill.totalMinor)}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <LinkBuildupDialog
          projectId={projectId}
          item={linking?.item ?? null}
          onClose={(changed) => {
            const target = linking;
            setLinking(null);
            if (!changed || !target) return;
            if (target.billId && loaded[target.billId]) void load(target.billId);
            if (search) void refreshSearch(search.query);
          }}
        />
      </CardContent>
    </Card>
  );
}
