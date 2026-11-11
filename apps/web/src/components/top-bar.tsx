"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, Building2, KeyRound, LogIn, LogOut } from "lucide-react";
import { csrfResponseSchema, messageResponseSchema } from "@pm-buddy/validation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { CommandMenu } from "@/components/command-menu";
import { LanguageSwitcher } from "@/components/language-switcher";
import { isLiveRoute } from "@/components/nav-config";
import { StatusBadge, severityTone } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { alerts } from "@/mocks/dashboard";
import { foundationRequest } from "@/lib/foundation-api";
import { initials } from "@/lib/format";
import { signInHref } from "@/lib/safe-next";

/** The signed-in user and company, resolved on the server from the session cookies. */
export type OfficeAccount = {
  displayName: string;
  identifier: string;
  companyName: string;
  roleLabel: string;
};

export function TopBar({ account }: { account: OfficeAccount | null }) {
  const t = useTranslations("topbar");
  const tSession = useTranslations("session");
  const tAlerts = useTranslations("alerts");
  const tSeverity = useTranslations("severity");
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const live = isLiveRoute(pathname);
  const critical = alerts.filter((a) => a.severity === "critical").length;

  async function signOut() {
    setSigningOut(true);
    try {
      const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
      await foundationRequest("/auth/logout", messageResponseSchema, {
        method: "POST",
        body: {},
        headers: { "X-CSRF-Token": csrfToken },
      });
    } catch {
      // Sign-out always clears the cookies server-side; continue to the sign-in page either way.
    } finally {
      router.replace("/sign-in");
      router.refresh();
    }
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
      <div className="min-w-0 flex-1">
        <CommandMenu />
      </div>
      <LanguageSwitcher className="hidden sm:flex" />
      <ThemeToggle />

      {/* Alerts are prototype data until notifications arrive (D7.3): not shown on live pages. */}
      {!live ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={t("notifications", { count: alerts.length })}
            >
              <Bell className="size-4" aria-hidden />
              {critical > 0 ? (
                <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">
                  {critical}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="border-b px-4 py-3 text-sm font-semibold">{t("alertsTitle")}</div>
            <ul className="max-h-80 divide-y overflow-y-auto">
              {alerts.map((alert) => (
                <li key={alert.key}>
                  <Link
                    href={alert.href}
                    className="block space-y-1 px-4 py-3 text-sm hover:bg-muted"
                  >
                    <StatusBadge tone={severityTone[alert.severity]}>
                      {tSeverity(alert.severity)}
                    </StatusBadge>
                    <p className="leading-snug">{tAlerts(alert.key, alert.params)}</p>
                    <p className="text-xs text-muted-foreground">{alert.project}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}

      {account ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 gap-2 px-1.5">
              <Avatar className="size-7" aria-hidden>
                <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                  {initials(account.displayName)}
                </AvatarFallback>
              </Avatar>
              <span className="hidden text-left text-xs leading-tight lg:block">
                <span className="block font-medium">{account.displayName}</span>
                <span className="block text-muted-foreground">{account.roleLabel}</span>
              </span>
              {/* Visible text stays part of the accessible name (WCAG 2.5.3). */}
              <span className="sr-only">{t("account")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{account.displayName}</div>
              <div className="truncate text-xs text-muted-foreground">{account.identifier}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Building2 className="size-3.5" aria-hidden />
                <span className="truncate">
                  {account.companyName} · {account.roleLabel}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/foundation">
                <KeyRound aria-hidden /> {t("security")}
              </Link>
            </DropdownMenuItem>
            <div className="px-2 py-1.5 sm:hidden">
              <LanguageSwitcher />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signingOut} onSelect={() => void signOut()}>
              <LogOut aria-hidden /> {t("signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button asChild size="sm" variant="outline">
          <Link href={signInHref(pathname)}>
            <LogIn aria-hidden /> {tSession("signIn")}
          </Link>
        </Button>
      )}
    </header>
  );
}
