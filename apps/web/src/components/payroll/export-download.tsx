"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { csrfResponseSchema } from "@pm-buddy/validation";
import { PAYROLL_EXPORT_KINDS, type PayrollExportKind } from "@pm-buddy/types";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { foundationRequest, FoundationApiError } from "@/lib/foundation-api";
import { refreshSession } from "@/lib/live-api";

export function ExportDownload({ month, blocked }: { month: string; blocked: boolean }) {
  const t = useTranslations("payrollLive");
  const stepUp = useStepUp();
  const problem = useProblemMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download(kind: PayrollExportKind) {
    setBusy(true);
    setError(null);
    const attempt = async (): Promise<Blob> => {
      const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
      let response: Response;
      try {
        response = await fetch("/api/v1/payroll/exports", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
            Accept: "text/csv",
          },
          body: JSON.stringify({ month, kind }),
        });
      } catch {
        throw new FoundationApiError(0, "network");
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          typeof body === "object" &&
          body !== null &&
          "code" in body &&
          typeof body.code === "string"
            ? body.code
            : "requestFailed";
        throw new FoundationApiError(response.status, code);
      }
      if (!response.headers.get("content-type")?.startsWith("text/csv"))
        throw new FoundationApiError(response.status, "invalidResponse");
      return response.blob();
    };
    try {
      const blob = await stepUp.run(async () => {
        try {
          return await attempt();
        } catch (failure) {
          if (
            failure instanceof FoundationApiError &&
            failure.status === 401 &&
            (await refreshSession())
          )
            return attempt();
          throw failure;
        }
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pm-buddy-${kind}-${month}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(problem(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {PAYROLL_EXPORT_KINDS.map((kind) => (
          <Button key={kind} disabled={busy || blocked} onClick={() => void download(kind)}>
            {t("download", { kind: kind.toUpperCase() })}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {stepUp.dialog}
    </div>
  );
}
