import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "overview", href: "/attendance" },
  { key: "muster", href: "/attendance/muster" },
  { key: "periods", href: "/attendance/periods" },
  { key: "anomalies", href: "/attendance/anomalies" },
  { key: "settings", href: "/attendance/settings" },
] as const;
export type AttendanceSection = (typeof SECTIONS)[number]["key"];

/** Sub-navigation of live attendance and timesheets (D3.3 web slice). */
export function AttendanceNav({
  current,
  anomalies,
  project,
}: {
  current: AttendanceSection;
  anomalies?: number;
  /** Keeps the selected project when moving between the muster roll and timesheets. */
  project?: string;
}) {
  const t = useTranslations("attendanceLive.nav");
  return (
    <nav aria-label={t("label")} className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {SECTIONS.map((section) => {
          const href =
            project && (section.key === "muster" || section.key === "periods")
              ? `${section.href}?project=${project}`
              : section.href;
          return (
            <li key={section.key}>
              <Link
                href={href}
                aria-current={section.key === current ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium",
                  section.key === current
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(section.key)}
                {section.key === "anomalies" && anomalies ? (
                  <span className="rounded-full bg-warning/20 px-1.5 text-xs tabular-nums text-warning-foreground dark:text-warning">
                    {anomalies}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
