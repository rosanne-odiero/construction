import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  Activity,
  ArrowRight,
  Building,
  FileSpreadsheet,
  HardHat,
  KeyRound,
  Languages,
  LayoutDashboard,
  MonitorSmartphone,
  Package,
  Palette,
  Scale,
  ScanFace,
  Smartphone,
  ShieldCheck,
  Table2,
  Wallet,
} from "lucide-react";
import type { Tone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PrototypeBanner } from "@/components/prototype-banner";
import { StatusBadge } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-toggle";

const screens = [
  { key: "foundation", href: "/foundation", icon: ShieldCheck, live: true },
  { key: "designSystem", href: "/design-system", icon: Palette },
  { key: "signIn", href: "/sign-in", icon: KeyRound },
  { key: "dashboard", href: "/dashboard", icon: LayoutDashboard },
  { key: "project", href: "/prototype/projects/ruiru-heights", icon: Building },
  { key: "bq", href: "/prototype/projects/ruiru-heights/bq", icon: FileSpreadsheet },
  { key: "bqImport", href: "/prototype/projects/ruiru-heights/bq/import", icon: Table2 },
  { key: "labour", href: "/prototype/labour", icon: HardHat },
  { key: "attendance", href: "/prototype/attendance", icon: ScanFace },
  { key: "payroll", href: "/prototype/payroll", icon: Wallet },
  { key: "portal", href: "/portal", icon: MonitorSmartphone, live: true },
  { key: "site", href: "/site", icon: Smartphone },
  { key: "status", href: "/status", icon: Activity, live: true },
] as const;

/** Things only the owner can provide; each says what it unblocks. */
const waiting = [
  { key: "bq", href: "/projects", icon: FileSpreadsheet, tone: "warning" },
  { key: "kiswahili", icon: Languages, tone: "neutral" },
  { key: "catalogue", href: "/catalogue", icon: Package, tone: "neutral" },
  { key: "compliance", icon: Scale, tone: "neutral" },
] as const satisfies readonly { key: string; href?: string; icon: unknown; tone: Tone }[];

const docs = [
  "docs/IMPLEMENTATION_STATUS.md",
  "docs/ACCEPTANCE_MATRIX.md",
  "docs/WORKFLOWS.md",
  "docs/INVARIANTS.md",
  "docs/FINANCIAL_MODEL.md",
  "docs/OFFLINE_SYNC.md",
  "docs/OPERATIONS.md",
  "docs/RELEASE_PLAN.md",
  "docs/PILOT_PLAN.md",
  "docs/ROADMAP.md",
  "docs/ARCHITECTURE.md",
  "docs/ERD.md",
  "docs/api/openapi-outline.yaml",
  "docs/THREAT_MODEL.md",
  "docs/DPIA_TEMPLATE.md",
  "docs/COMPLIANCE_TODO.md",
  "docs/CONFIGURATION.md",
  "docs/QUESTIONS.md",
];

export default async function TourPage() {
  const t = await getTranslations("tour");

  return (
    <div className="flex min-h-svh flex-col">
      <PrototypeBanner />
      <header className="flex items-center justify-between gap-4 border-b px-4 py-3 sm:px-8">
        <div className="flex items-center gap-2 font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HardHat className="size-4" aria-hidden />
          </span>
          PM-Buddy
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 space-y-10 px-4 py-10 sm:px-8">
        <section className="space-y-4">
          <p className="text-sm font-medium text-primary">{t("eyebrow")}</p>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {t("title")}
          </h1>
          <p className="max-w-3xl text-muted-foreground">{t("intro")}</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="lg">
              <Link href="/sign-in">
                {t("start")} <ArrowRight aria-hidden />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/dashboard">{t("skipToDashboard")}</Link>
            </Button>
          </div>
        </section>

        <section aria-labelledby="waiting-heading">
          <Card className="border-warning/40">
            <CardHeader>
              <CardTitle id="waiting-heading" role="heading" aria-level={2} className="text-lg">
                {t("waiting.title")}
              </CardTitle>
              <CardDescription>{t("waiting.intro")}</CardDescription>
              <ul className="mt-4 grid gap-4 md:grid-cols-2">
                {waiting.map((item) => (
                  <li key={item.key} className="flex gap-3 rounded-lg border p-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <item.icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{t(`waiting.items.${item.key}.title`)}</h3>
                        <StatusBadge tone={item.tone}>
                          {t(`waiting.items.${item.key}.blocks`)}
                        </StatusBadge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {t(`waiting.items.${item.key}.description`)}
                      </p>
                      {"href" in item ? (
                        <Button asChild size="sm" variant="outline">
                          <Link href={item.href}>
                            {t(`waiting.items.${item.key}.action`)} <ArrowRight aria-hidden />
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </CardHeader>
          </Card>
        </section>

        <section className="space-y-4" aria-labelledby="screens-heading">
          <h2 id="screens-heading" className="text-lg font-semibold">
            {t("screensTitle")}
          </h2>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {screens.map((screen, index) => (
              <li key={screen.key}>
                <Link
                  href={screen.href}
                  className="group block h-full rounded-xl focus-visible:outline-none"
                >
                  <Card className="h-full transition-colors group-hover:border-primary/50 group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
                    <CardHeader>
                      <div className="mb-2 flex items-center gap-3">
                        <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                          <screen.icon className="size-4" aria-hidden />
                        </span>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        {"live" in screen ? (
                          <StatusBadge tone="info" className="ml-auto">
                            {t("liveApi")}
                          </StatusBadge>
                        ) : null}
                      </div>
                      <CardTitle className="flex items-center gap-1">
                        {t(`screens.${screen.key}.title`)}
                        <ArrowRight
                          className="size-4 opacity-0 transition-opacity group-hover:opacity-100"
                          aria-hidden
                        />
                      </CardTitle>
                      <CardDescription>{t(`screens.${screen.key}.description`)}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("reviewTitle")}</CardTitle>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                {(["look", "density", "language", "dark", "mobile", "trust"] as const).map(
                  (key) => (
                    <li key={key}>{t(`review.${key}`)}</li>
                  ),
                )}
              </ul>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("docsTitle")}</CardTitle>
              <CardDescription>{t("docsIntro")}</CardDescription>
              <ul className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-2">
                {docs.map((doc) => (
                  <li key={doc} className="truncate rounded bg-muted px-2 py-1">
                    {doc}
                  </li>
                ))}
              </ul>
            </CardHeader>
          </Card>
        </section>
      </main>
    </div>
  );
}
