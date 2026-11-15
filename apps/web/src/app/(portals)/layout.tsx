import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { HardHat } from "lucide-react";
import { PORTAL_HOME, portalFor } from "@pm-buddy/types";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { StatusBadge } from "@/components/status-badge";
import { PortalName } from "@/components/supplier-portal/portal-name";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSessionState } from "@/lib/server-api";

/**
 * The live client, labourer and supplier portals: a light, mobile-first shell (no office
 * sidebar). Pages check access themselves; the PIN set-up, reset and join pages work signed out.
 */
export default async function PortalsLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("portals");
  const design = await getTranslations("designSystem");
  const state = await getSessionState();
  const session = state.status === "signed-in" ? state.session : null;
  const portal = session ? portalFor(session.company.permissions) : null;
  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <a href="#main" className="sr-only focus:not-sr-only">
        {design("skip")}
      </a>
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-2">
          <Link
            href={portal ? PORTAL_HOME[portal] : "/sign-in"}
            className="flex items-center gap-2"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <HardHat className="size-4" aria-hidden />
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">PM-Buddy</span>
              <span className="block text-xs text-muted-foreground">
                <PortalName
                  portal={portal}
                  names={{
                    client: t("clientName"),
                    office: t("officeName"),
                    worker: t("workerName"),
                    supplier: t("supplierName"),
                  }}
                />
              </span>
            </span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {session ? (
              <span className="hidden text-right text-xs leading-tight sm:block">
                <span className="block font-medium">{session.user.displayName}</span>
                <span className="block text-muted-foreground">{session.company.name}</span>
              </span>
            ) : null}
            <StatusBadge tone="info">{t("live")}</StatusBadge>
            <LanguageSwitcher />
            <ThemeToggle />
            {session ? <SignOutButton /> : null}
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
