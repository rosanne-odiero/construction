"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { HardHat, MonitorSmartphone, Settings, Smartphone, Sparkles } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { navGroups } from "@/components/nav-config";
import { company } from "@/mocks/company";

export function AppSidebar() {
  const pathname = usePathname();
  const t = useTranslations("nav");

  const isActive = (href: string) =>
    href === "/projects"
      ? pathname === "/projects" || /^\/projects\/[^/]+$/.test(pathname)
      : pathname.startsWith(href);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="PM-Buddy">
              <Link href="/dashboard">
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <HardHat className="size-4" aria-hidden />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">PM-Buddy</span>
                  <span className="truncate text-xs text-muted-foreground">{company.name}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.key}>
            <SidebarGroupLabel>{t(`groups.${group.key}`)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(item.href)}
                      tooltip={t(`items.${item.key}`)}
                    >
                      <Link
                        href={item.href}
                        className={item.phase ? "text-muted-foreground" : undefined}
                      >
                        <item.icon aria-hidden />
                        <span>{t(`items.${item.key}`)}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.phase ? (
                      <SidebarMenuBadge className="text-[10px] font-normal text-muted-foreground">
                        {t("phase", { phase: item.phase })}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        <SidebarGroup>
          <SidebarGroupLabel>{t("groups.previews")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/portal"}
                  tooltip={t("items.clientPortal")}
                >
                  <Link href="/portal">
                    <MonitorSmartphone aria-hidden />
                    <span>{t("items.clientPortal")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("items.siteApp")}>
                  <Link href="/site">
                    <Smartphone aria-hidden />
                    <span>{t("items.siteApp")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("items.tour")}>
                  <Link href="/">
                    <Sparkles aria-hidden />
                    <span>{t("items.tour")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === "/soon/settings"}
              tooltip={t("items.settings")}
            >
              <Link href="/soon/settings">
                <Settings aria-hidden />
                <span>{t("items.settings")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
