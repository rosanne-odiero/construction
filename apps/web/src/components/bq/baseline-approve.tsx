"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BadgeCheck } from "lucide-react";
import { bqVersionResponseSchema } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { useStepUp } from "@/components/projects/step-up";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { liveRequest } from "@/lib/live-api";
import { formatKES } from "@/lib/format";

/**
 * Approves the imported draft as the contract baseline (bq.approve_variation, fresh step-up, not
 * the importer). The API checks everything again; afterwards the version never changes.
 */
export function BaselineApproveButton({
  projectId,
  versionId,
  version,
  grandTotalMinor,
}: {
  projectId: string;
  versionId: string;
  version: number;
  grandTotalMinor: number;
}) {
  const t = useTranslations("baseline");
  const problem = useProblemMessage();
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setFailure(null);
    try {
      await stepUp.run(() =>
        liveRequest(
          `/projects/${projectId}/bq/versions/${versionId}/approve`,
          bqVersionResponseSchema,
          {
            method: "POST",
            body: { version },
          },
        ),
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <BadgeCheck aria-hidden /> {t("approve")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", { total: formatKES(grandTotalMinor) })}
            </DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{t("immutable")}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void approve()}>
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
