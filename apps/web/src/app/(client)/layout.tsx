import { getTranslations } from "next-intl/server";
import { HardHat } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PrototypeBanner } from "@/components/prototype-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { portalClient } from "@/mocks/portal";

export default async function ClientPortalLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("portal");
  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <PrototypeBanner />
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <HardHat className="size-4" aria-hidden />
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">PM-Buddy</span>
              <span className="block text-xs text-muted-foreground">{t("portalName")}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-right text-xs leading-tight sm:block">
              <span className="block font-medium">{portalClient.name}</span>
              <span className="block text-muted-foreground">{portalClient.location}</span>
            </span>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
