import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "home", href: "/procurement" },
  { key: "requisitions", href: "/procurement/requisitions" },
  { key: "rfqs", href: "/procurement/rfqs" },
  { key: "lpos", href: "/procurement/lpos" },
  { key: "grns", href: "/procurement/grns" },
  { key: "invoices", href: "/procurement/invoices" },
] as const;
export type P2pSection = (typeof SECTIONS)[number]["key"];

/** Links between the procure-to-pay pages (D5.2). */
export async function P2pSubnav({ current }: { current: P2pSection }) {
  const t = await getTranslations("p2p.nav");
  return (
    <nav aria-label={t("label")} className="relative -mx-1 overflow-x-auto print:hidden">
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

/** The "Live" eyebrow with an optional trail back to a list. */
export async function P2pEyebrow({ trail }: { trail?: { href: string; label: string } }) {
  const t = await getTranslations("p2p");
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
