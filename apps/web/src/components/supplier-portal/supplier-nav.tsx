import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "home", href: "/supplier" },
  { key: "lpos", href: "/supplier/lpos" },
  { key: "deliveries", href: "/supplier/deliveries" },
  { key: "invoices", href: "/supplier/invoices" },
  { key: "statement", href: "/supplier/statement" },
] as const;
export type SupplierSection = (typeof SECTIONS)[number]["key"];

/** Links between the supplier portal's pages (D7.2); scrolls sideways on a small phone. */
export async function SupplierNav({ current }: { current: SupplierSection }) {
  const t = await getTranslations("supplierPortal.nav");
  return (
    <nav aria-label={t("label")} className="-mx-1 overflow-x-auto">
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

/** A page heading with an optional description (the portals have no office page header). */
export function PortalHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
        {description ? <p className="text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Keeps a status badge's tint over the page colour: the portals' page background is tinted, and
 * a translucent badge on it would fall below WCAG AA contrast.
 */
export function HeadingBadge({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex rounded-4xl bg-background">{children}</span>;
}
