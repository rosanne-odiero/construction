"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bell, CircleUserRound, KeyRound, LogOut } from "lucide-react";
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
import { StatusBadge, severityTone } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { alerts } from "@/mocks/dashboard";
import { currentUser } from "@/mocks/company";
import { initials } from "@/lib/format";

export function TopBar() {
  const t = useTranslations("topbar");
  const tAlerts = useTranslations("alerts");
  const tSeverity = useTranslations("severity");
  const critical = alerts.filter((a) => a.severity === "critical").length;

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
      <div className="min-w-0 flex-1">
        <CommandMenu />
      </div>
      <LanguageSwitcher className="hidden sm:flex" />
      <ThemeToggle />

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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-1.5" aria-label={t("account")}>
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                {initials(currentUser.name)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden text-left text-xs leading-tight lg:block">
              <span className="block font-medium">{currentUser.name}</span>
              <span className="block text-muted-foreground">{t("role")}</span>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="text-sm font-medium">{currentUser.name}</div>
            <div className="text-xs text-muted-foreground">{currentUser.email}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/soon/settings">
              <CircleUserRound aria-hidden /> {t("profile")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/soon/settings">
              <KeyRound aria-hidden /> {t("security")}
            </Link>
          </DropdownMenuItem>
          <div className="px-2 py-1.5 sm:hidden">
            <LanguageSwitcher />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/sign-in">
              <LogOut aria-hidden /> {t("signOut")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
