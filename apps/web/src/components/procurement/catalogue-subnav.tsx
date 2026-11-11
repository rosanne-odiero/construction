import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "materials", href: "/catalogue" },
  { key: "alerts", href: "/catalogue/alerts" },
  { key: "convert", href: "/catalogue/convert" },
  { key: "units", href: "/catalogue/units" },
  { key: "suppliers", href: "/suppliers" },
] as const;
export type CatalogueSection = (typeof SECTIONS)[number]["key"];

/** Links between the catalogue pages and the supplier list (D5.1). */
export async function CatalogueSubnav({ current }: { current: CatalogueSection }) {
  const t = await getTranslations("catalogue.nav");
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
