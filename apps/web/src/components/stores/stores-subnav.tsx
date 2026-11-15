import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "home", href: "/stores" },
  { key: "transfers", href: "/stores/transfers" },
  { key: "stockTakes", href: "/stores/stock-takes" },
  { key: "variance", href: "/stores/variance" },
  { key: "settings", href: "/stores/settings" },
] as const;
export type StoresSection = (typeof SECTIONS)[number]["key"];

/** Links between the stores pages (D5.3). */
export async function StoresSubnav({ current }: { current: StoresSection | null }) {
  const t = await getTranslations("stores.nav");
  return (
    <nav aria-label={t("label")} className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {SECTIONS.map((section) => (
          <li key={section.key}>
            <Link
              href={section.href}
              aria-current={section.key === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                section.key === current
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(section.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The "Live" eyebrow with an optional trail back to a page. */
export async function StoresEyebrow({ trail }: { trail?: { href: string; label: string } }) {
  const t = await getTranslations("stores");
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

/** A table that scrolls inside a focusable, labelled region on small screens. */
export function ScrollTable({
  label,
  minWidth = 640,
  children,
}: {
  label: string;
  minWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={label}
      className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <table className="w-full text-sm" style={{ minWidth }}>
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </div>
  );
}
