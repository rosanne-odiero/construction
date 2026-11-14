"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import type { CostCategory } from "@pm-buddy/types";
import { bqItemSearchResponseSchema, costCodesResponseSchema } from "@pm-buddy/validation";
import { useP2pProblem } from "@/components/procurement/p2p/use-p2p-problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

export type CostTag =
  | { kind: "item"; lineageId: string; label: string }
  | { kind: "costCode"; id: string; label: string; category: CostCategory };

type Option = CostTag & { key: string };

/**
 * Tags a cost with a BQ item of the project's BQ in force or a company cost code, searched on the
 * server (both lists can grow). Inline rather than a dialog so it works at 360 px.
 */
export function TagPicker({
  id,
  projectId,
  value,
  onChange,
}: {
  id: string;
  projectId: string;
  value: CostTag | null;
  onChange: (tag: CostTag | null) => void;
}) {
  const t = useTranslations("spending.tag");
  const problem = useP2pProblem();
  const [mode, setMode] = useState<"costCode" | "item">("costCode");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Option[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setNote(null);
    const needle = encodeURIComponent(query.trim());
    try {
      if (mode === "costCode") {
        const result = await liveRequest(
          `/cost-codes?search=${needle}&limit=25`,
          costCodesResponseSchema,
        );
        setOptions(
          result.costCodes.map((code) => ({
            key: code.id,
            kind: "costCode",
            id: code.id,
            category: code.category,
            label: `${code.code} · ${code.name}`,
          })),
        );
        if (result.page.hasMore) setNote(t("more"));
      } else {
        const result = await liveRequest(
          `/spending/projects/${projectId}/bq-items?search=${needle}`,
          bqItemSearchResponseSchema,
        );
        if (!result.versionId) setNote(t("noBq"));
        else if (result.truncated) setNote(t("more"));
        setOptions(
          result.items.map((item) => ({
            key: item.lineageId,
            kind: "item",
            lineageId: item.lineageId,
            label: `${item.bill ? `${item.bill.number} · ` : ""}${item.ref ? `${item.ref} · ` : ""}${item.description}`,
          })),
        );
      }
    } catch (error) {
      setOptions(null);
      setNote(problem(error));
    } finally {
      setBusy(false);
    }
  }

  if (value)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
        <span className="min-w-0 break-words">
          <span className="text-xs text-muted-foreground">
            {value.kind === "item" ? t("item") : t("costCode")}
          </span>
          <span className="block font-medium">{value.label}</span>
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)}>
          {t("change")}
        </Button>
      </div>
    );

  return (
    <div className="space-y-2 rounded-md border p-2">
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="sr-only">{t("mode")}</legend>
        {(["costCode", "item"] as const).map((option) => (
          <label key={option} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === option}
              onChange={() => {
                setMode(option);
                setOptions(null);
                setNote(null);
              }}
            />
            {option === "item" ? t("item") : t("costCode")}
          </label>
        ))}
      </fieldset>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={`${id}-search`} className="block text-sm font-medium">
            {mode === "item" ? t("searchItems") : t("searchCodes")}
          </label>
          <Input
            id={`${id}-search`}
            value={query}
            maxLength={60}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
          />
        </div>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void search()}>
          <Search aria-hidden /> {t("search")}
        </Button>
      </div>
      {note ? (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}
      {options ? (
        options.length ? (
          <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label={t("results")}>
            {options.map((option) => (
              <li key={option.key}>
                <button
                  type="button"
                  className="w-full rounded-md border px-3 py-2 text-left text-sm break-words hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  onClick={() =>
                    onChange(
                      option.kind === "item"
                        ? { kind: "item", lineageId: option.lineageId, label: option.label }
                        : {
                            kind: "costCode",
                            id: option.id,
                            label: option.label,
                            category: option.category,
                          },
                    )
                  }
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        )
      ) : null}
    </div>
  );
}
