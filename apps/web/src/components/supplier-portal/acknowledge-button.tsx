"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ClipboardCheck } from "lucide-react";
import { portalLpoDetailResponseSchema } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { liveRequest } from "@/lib/live-api";

/** Acknowledges an approved LPO once (time and user); the order and its approval never change. */
export function AcknowledgeButton({ lpoId, company }: { lpoId: string; company: string }) {
  const t = useTranslations("supplierPortal.lpo");
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            await liveRequest(
              `/portal/supplier/lpos/${lpoId}/acknowledge`,
              portalLpoDetailResponseSchema,
              { method: "POST" },
            );
            router.refresh();
          } catch (error) {
            setFailure(problem(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ClipboardCheck aria-hidden /> {busy ? t("acknowledging") : t("acknowledge")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("acknowledgeHint", { company })}</p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
