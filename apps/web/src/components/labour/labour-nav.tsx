import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "registry", href: "/labour" },
  { key: "gangs", href: "/labour/gangs" },
  { key: "alerts", href: "/labour/alerts" },
  { key: "setup", href: "/labour/setup" },
] as const;
export type LabourSection = (typeof SECTIONS)[number]["key"];

/** Sub-navigation of the live labour registry (D3.1). */
export function LabourNav({ current, alerts }: { current: LabourSection; alerts?: number }) {
  const t = useTranslations("labourLive.nav");
  return (
    <nav aria-label={t("label")} className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {SECTIONS.map((section) => (
          <li key={section.key}>
            <Link
              href={section.href}
              aria-current={section.key === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium",
                section.key === current
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(section.key)}
              {section.key === "alerts" && alerts ? (
                <span className="rounded-full bg-warning/20 px-1.5 text-xs tabular-nums text-warning-foreground dark:text-warning">
                  {alerts}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
