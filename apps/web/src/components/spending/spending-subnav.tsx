import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { BudgetRowWire } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { formatKES } from "@/lib/format";
import { levelTone, percentLabel } from "@/lib/spending";
import { cn } from "@/lib/utils";

export { SentenceBadge } from "./sentence-badge";

const SECTIONS = [
  { key: "home", href: "/spending" },
  { key: "ledger", href: "/spending/ledger" },
  { key: "pettyCash", href: "/spending/petty-cash" },
  { key: "forecast", href: "/spending/forecast" },
  { key: "alerts", href: "/spending/alerts" },
  { key: "budgets", href: "/spending/budgets" },
  { key: "journals", href: "/spending/journals" },
  { key: "settings", href: "/spending/settings" },
] as const;
export type SpendingSection = (typeof SECTIONS)[number]["key"];

/** Links between the spending pages (D5.4). */
export async function SpendingSubnav({ current }: { current: SpendingSection | null }) {
  const t = await getTranslations("spending.nav");
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
export async function SpendingEyebrow({ trail }: { trail?: { href: string; label: string } }) {
  const t = await getTranslations("spending");
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

export type FigureRow = { key: string; label: React.ReactNode; figures: BudgetRowWire };

/**
 * Budget against committed, actual (accrued) and paid, one row per category, bill or item.
 * Rows without a budget show "no budget" and an unavailable percentage, never zero.
 */
export async function FiguresTable({
  label,
  rows,
  firstColumn,
}: {
  label: string;
  rows: FigureRow[];
  firstColumn: string;
}) {
  const t = await getTranslations("spending.figures");
  return (
    <ScrollTable label={label} minWidth={860}>
      <thead>
        <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
          <th scope="col" className="py-2 pl-4 font-medium">
            {firstColumn}
          </th>
          <th scope="col" className="py-2 pr-2 text-right font-medium">
            {t("budget")}
          </th>
          <th scope="col" className="py-2 pr-2 text-right font-medium">
            {t("committed")}
          </th>
          <th scope="col" className="py-2 pr-2 text-right font-medium">
            {t("actual")}
          </th>
          <th scope="col" className="py-2 pr-2 text-right font-medium">
            {t("paid")}
          </th>
          <th scope="col" className="py-2 pr-2 text-right font-medium">
            {t("remaining")}
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            {t("used")}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b align-top last:border-0">
            <th scope="row" className="py-2 pl-4 text-left font-medium">
              {row.label}
            </th>
            <td className="py-2 pr-2 text-right tabular-nums">
              {row.figures.budgetMinor === null ? (
                <span className="text-muted-foreground">{t("noBudget")}</span>
              ) : (
                formatKES(row.figures.budgetMinor)
              )}
            </td>
            <td className="py-2 pr-2 text-right tabular-nums">
              {formatKES(row.figures.committedMinor)}
            </td>
            <td className="py-2 pr-2 text-right tabular-nums">
              {formatKES(row.figures.actualMinor)}
            </td>
            <td className="py-2 pr-2 text-right tabular-nums">
              {formatKES(row.figures.paidMinor)}
            </td>
            <td className="py-2 pr-2 text-right tabular-nums">
              {row.figures.remainingMinor === null ? "—" : formatKES(row.figures.remainingMinor)}
            </td>
            <td className="py-2 pr-4">
              <StatusBadge tone={levelTone[row.figures.level]}>
                {row.figures.level === "unavailable"
                  ? t("unavailable")
                  : t(`level.${row.figures.level}`, {
                      percent: percentLabel(row.figures.usedPercent),
                    })}
              </StatusBadge>
            </td>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}
