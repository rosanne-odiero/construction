import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { authProvidersResponseSchema } from "@pm-buddy/validation";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatusBadge } from "@/components/status-badge";
import { serverApi } from "@/lib/server-api";
import { FoundationConsole } from "./foundation-console";

export async function generateMetadata() {
  const t = await getTranslations("foundation");
  return { title: t("title") };
}

export default async function FoundationPage() {
  const t = await getTranslations("foundation");
  const design = await getTranslations("designSystem");
  // Google is offered only when the API reports it configured; on any failure it stays hidden.
  const providers = await serverApi("/auth/providers", authProvidersResponseSchema);
  const google = providers.ok && providers.data.google;
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <a href="#main" className="sr-only focus:not-sr-only">
        {design("skip")}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="text-lg font-semibold">
          PM-Buddy
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="space-y-6">
        <div className="space-y-2">
          <StatusBadge tone="info">{t("live")}</StatusBadge>
          <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        <FoundationConsole google={google} />
        <p className="text-sm text-muted-foreground">{t("limitations")}</p>
        <nav className="flex flex-wrap gap-4 text-sm text-primary" aria-label={t("links")}>
          <Link href="/design-system" className="underline underline-offset-4">
            {t("designSystem")}
          </Link>
          <Link href="/status" className="underline underline-offset-4">
            {t("status")}
          </Link>
          <Link href="/" className="underline underline-offset-4">
            {t("prototype")}
          </Link>
        </nav>
      </main>
    </div>
  );
}
