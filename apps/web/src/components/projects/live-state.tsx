import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CloudOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown when the API cannot be reached: an explicit error state, never mock data. */
export async function LiveUnavailable({ retryHref }: { retryHref: string }) {
  const t = await getTranslations("session");
  return (
    <div role="alert" className="mx-auto max-w-lg space-y-4 rounded-xl border p-6 text-center">
      <CloudOff className="mx-auto size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">{t("unavailableTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("unavailableDescription")}</p>
      <div className="flex justify-center gap-2">
        <Button asChild>
          <Link href={retryHref}>{t("retry")}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/status">{t("statusLink")}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Shown when the caller lacks the permission on this project (403). */
export async function LiveForbidden() {
  const t = await getTranslations("session");
  return (
    <div role="alert" className="mx-auto max-w-lg space-y-4 rounded-xl border p-6 text-center">
      <ShieldAlert className="mx-auto size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">{t("forbiddenTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("forbiddenDescription")}</p>
      <Button asChild variant="outline">
        <Link href="/projects">{t("backToProjects")}</Link>
      </Button>
    </div>
  );
}
