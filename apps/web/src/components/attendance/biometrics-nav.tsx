import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { key: "gate", href: "/attendance/biometrics" },
  { key: "enrolments", href: "/attendance/biometrics/enrolments" },
  { key: "deletions", href: "/attendance/biometrics/deletions" },
] as const;
export type BiometricsSection = (typeof SECTIONS)[number]["key"];

/** The biometric attendance pages: the DPIA gate, enrolments and the deletion log (D3.4). */
export function BiometricsNav({ current }: { current?: BiometricsSection }) {
  const t = useTranslations("biometrics.nav");
  return (
    <nav aria-label={t("label")}>
      <ul className="flex flex-wrap gap-2">
        {SECTIONS.map((section) => (
          <li key={section.key}>
            <Link
              href={section.href}
              aria-current={section.key === current ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-full border px-3 text-sm font-medium",
                section.key === current
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
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
