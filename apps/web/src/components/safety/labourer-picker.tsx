"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { inductionStatusResponseSchema, type SafetyLabourer } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

/**
 * Finds a labourer engaged on the project by name or worker number (searched on the server, ten at
 * a time) and shows only the registry number and name.
 */
export function LabourerPicker({
  projectId,
  siteId,
  value,
  onChange,
  label,
  disabled,
}: {
  projectId: string;
  siteId: string;
  value: SafetyLabourer | null;
  onChange: (labourer: SafetyLabourer | null) => void;
  label?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("safety.picker");
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef(0);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SafetyLabourer[] | null>(null);

  function search(text: string) {
    setQuery(text);
    if (timer.current) clearTimeout(timer.current);
    const term = text.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(() => {
      const ticket = ++request.current;
      setBusy(true);
      const params = new URLSearchParams({ siteId, search: term, limit: "10" });
      liveRequest(
        `/projects/${projectId}/safety/induction-status?${params.toString()}`,
        inductionStatusResponseSchema,
      )
        .then((response) => {
          if (ticket === request.current) setResults(response.rows.map((row) => row.labourer));
        })
        .catch(() => {
          if (ticket === request.current) setResults([]);
        })
        .finally(() => {
          if (ticket === request.current) setBusy(false);
        });
    }, 250);
  }

  if (value)
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="break-words">
          {t("selected", { name: value.fullName, workerNo: value.workerNo })}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            onChange(null);
            setResults(null);
            setQuery("");
          }}
        >
          {t("change")}
        </Button>
      </div>
    );
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label ?? t("label")}
      </label>
      <Input
        id={id}
        type="search"
        autoComplete="off"
        maxLength={100}
        value={query}
        disabled={disabled}
        placeholder={t("search")}
        onChange={(event) => search(event.currentTarget.value)}
      />
      {busy ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("searching")}
        </p>
      ) : null}
      {results && !busy ? (
        results.length ? (
          <ul aria-label={t("results")} className="space-y-1">
            {results.map((labourer) => (
              <li key={labourer.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  onClick={() => onChange(labourer)}
                >
                  <span className="sr-only">{t("choose")} </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {labourer.workerNo}
                  </span>{" "}
                  <span className="break-words">{labourer.fullName}</span>
                </Button>
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
