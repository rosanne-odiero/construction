"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PackagePlus } from "lucide-react";
import { loadDefaultsResponseSchema } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { liveRequest } from "@/lib/live-api";

/** Loads the Kenyan starter catalogue (idempotent: materials already present are kept). */
export function LoadDefaultsButton() {
  const t = useTranslations("catalogue.defaults");
  const problem = useProblemMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function load() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await liveRequest("/materials/defaults", loadDefaultsResponseSchema, {
        method: "POST",
      });
      setMessage({ text: t("done", result), error: false });
      router.refresh();
    } catch (error) {
      setMessage({ text: problem(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" onClick={() => void load()} disabled={busy}>
        <PackagePlus aria-hidden /> {t("button")}
      </Button>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
