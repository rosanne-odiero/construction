"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { bqSearchResponseSchema, type BqSearchResponse } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";
import { useP2pProblem } from "./use-p2p-problem";

export type BqItemChoice = { lineageId: string; ref: string | null; description: string };

/**
 * Picks a BQ item of the project's BQ in force for a requisition line (an optional cost tag).
 * The API accepts only items of the newest approved version and says so otherwise.
 */
export function BqItemPicker({
  projectId,
  open,
  onClose,
  onChoose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onChoose: (item: BqItemChoice) => void;
}) {
  const t = useTranslations("p2p.requisitions.bqSearch");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<BqSearchResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setFailure(null);
    try {
      setResult(
        await liveRequest(
          `/projects/${projectId}/bq/search?q=${encodeURIComponent(query.trim())}`,
          bqSearchResponseSchema,
        ),
      );
    } catch (error) {
      setResult(null);
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim().length >= 2) void search();
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="bq-search">{t("label")}</FieldLabel>
            <Input
              id="bq-search"
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy || query.trim().length < 2}>
            <Search aria-hidden /> {t("search")}
          </Button>
        </form>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {result ? (
          result.items.length ? (
            <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={t("title")}>
              {result.items.map((item) => (
                <li key={item.lineageId}>
                  <button
                    type="button"
                    className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => {
                      onChoose({
                        lineageId: item.lineageId,
                        ref: item.ref,
                        description: item.description,
                      });
                      onClose();
                    }}
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.billNumber}
                      {item.ref ? ` · ${item.ref}` : ""}
                    </span>
                    <span className="block">{item.description}</span>
                    <span className="sr-only">{t("choose")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {t("empty")}
            </p>
          )
        ) : null}
        {result?.truncated ? (
          <p className="text-xs text-muted-foreground">{t("truncated")}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
