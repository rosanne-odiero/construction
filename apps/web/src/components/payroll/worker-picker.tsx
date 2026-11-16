"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  labourerListQuerySchema,
  labourersResponseSchema,
  type LabourersResponse,
} from "@pm-buddy/validation";
import { selectClass } from "@/components/labour/action-dialog";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Input } from "@/components/ui/input";
import { liveRequest } from "@/lib/live-api";

export function WorkerPicker({
  id,
  projectId,
  value,
  onChange,
}: {
  id: string;
  projectId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("payrollLive");
  const problem = useProblemMessage();
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<LabourersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const invalidMessage = t("workerSearchHint");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      const parsed = labourerListQuerySchema.safeParse({ projectId, search, limit: 50 });
      if (!parsed.success) {
        if (active) {
          setError(invalidMessage);
          setLoading(false);
        }
        return;
      }
      try {
        const data = await liveRequest(
          `/labour/labourers?${new URLSearchParams({ projectId, search: parsed.data.search ?? "", limit: "50" })}`,
          labourersResponseSchema,
        );
        if (active) {
          setResult(data);
          setError(null);
        }
      } catch (failure) {
        if (active) setError(problem(failure));
      } finally {
        if (active) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // Error translation is read for this request, not a reason to repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, search, invalidMessage]);
  return (
    <div className="space-y-2">
      <Input
        aria-label={t("searchWorkers")}
        placeholder={t("workerSearchHint")}
        value={search}
        onChange={(event) => {
          setLoading(true);
          setResult(null);
          onChange("");
          setSearch(event.target.value);
        }}
      />
      <select
        id={id}
        className={selectClass}
        value={value}
        disabled={loading || !!error}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("chooseWorker")}</option>
        {result?.labourers.map((worker) => (
          <option key={worker.id} value={worker.id}>
            {worker.workerNo} · {worker.fullName}
          </option>
        ))}
      </select>
      <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
        {error ??
          (loading
            ? t("loading")
            : t("workerResults", {
                shown: result?.labourers.length ?? 0,
                total: result?.total ?? 0,
              }))}
      </p>
    </div>
  );
}
