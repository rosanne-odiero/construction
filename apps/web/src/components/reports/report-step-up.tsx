"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import { reportModelSchema } from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { liveRequest } from "@/lib/live-api";

/**
 * A report whose source screen needs a recent MFA check (the audit log): verify in a dialog, then
 * the server page renders the report.
 */
export function ReportStepUp({ path }: { path: string }) {
  const t = useTranslations("reports.report");
  const problem = useProblemMessage();
  const router = useRouter();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setFailure(null);
    try {
      await stepUp.run(() => liveRequest(path, reportModelSchema));
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={busy} onClick={() => void verify()}>
        <ShieldCheck aria-hidden /> {t("verify")}
      </Button>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {stepUp.dialog}
    </div>
  );
}
