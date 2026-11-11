import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { tenantRoleSchema } from "@pm-buddy/validation";
import { AppSidebar } from "@/components/app-sidebar";
import { PrototypeBanner } from "@/components/prototype-banner";
import { PrototypeOnly } from "@/components/prototype-only";
import { TopBar, type OfficeAccount } from "@/components/top-bar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSessionState } from "@/lib/server-api";

export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  const state = await getSessionState();
  const t = await getTranslations("foundation");
  let account: OfficeAccount | null = null;
  if (state.status === "signed-in") {
    const { user, company } = state.session;
    const system = tenantRoleSchema.safeParse(company.role);
    account = {
      displayName: user.displayName,
      identifier: user.identifier,
      companyName: company.name,
      roleLabel: company.roleName ?? (system.success ? t(`roles.${system.data}`) : t("customRole")),
    };
  }

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar companyName={account?.companyName} />
      <SidebarInset className="min-w-0">
        <PrototypeOnly>
          <PrototypeBanner />
        </PrototypeOnly>
        <TopBar account={account} />
        <main id="main" className="flex-1 p-4 sm:p-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
