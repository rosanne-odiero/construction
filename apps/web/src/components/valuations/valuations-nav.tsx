import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import type { ValuationTab } from "@/lib/valuations";

/** The "Live" eyebrow with an optional trail back to a page. */
export async function ValuationsEyebrow({ trail }: { trail?: { href: string; label: string } }) {
  const t = await getTranslations("valuations");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge tone="info">{t("live")}</StatusBadge>
      {trail ? (
        <Link href={trail.href} className="underline underline-offset-4">
          {trail.label}
        </Link>
      ) : null}
    </span>
  );
}

/** Tabs of a project's measurement and valuation page; only the ones the caller may see. */
export async function ProjectTabs({
  projectId,
  current,
  tabs,
}: {
  projectId: string;
  current: ValuationTab;
  tabs: readonly ValuationTab[];
}) {
  const t = await getTranslations("valuations.project.tabs");
  const label = await getTranslations("valuations.project");
  return (
    <nav aria-label={label("tabsLabel")} className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {tabs.map((tab) => (
          <li key={tab}>
            <Link
              href={`/valuations/projects/${projectId}?tab=${tab}`}
              aria-current={tab === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                tab === current
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
