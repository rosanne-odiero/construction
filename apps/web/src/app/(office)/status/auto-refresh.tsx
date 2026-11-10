"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const INTERVAL_SECONDS = 10;

/** Re-renders the server page on an interval (only while the tab is visible) or on demand. */
export function AutoRefresh() {
  const router = useRouter();
  const t = useTranslations("systemStatus");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, INTERVAL_SECONDS * 1000);
    return () => clearInterval(id);
  }, [router]);

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground">
        {t("autoRefresh", { seconds: INTERVAL_SECONDS })}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RefreshCw className={pending ? "motion-safe:animate-spin" : undefined} aria-hidden />
        {t("refresh")}
      </Button>
    </div>
  );
}
