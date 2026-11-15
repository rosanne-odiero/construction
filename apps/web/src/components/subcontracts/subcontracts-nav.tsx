import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

/** The "Live" eyebrow with an optional trail back to a page. */
export async function SubcontractsEyebrow({ trail }: { trail?: { href: string; label: string } }) {
  const t = await getTranslations("subcontracts");
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

export type ProjectSection = "subcontracts" | "piece-rate" | "output";

/** A project's subcontract sections; only the ones the caller may see. */
export async function ProjectSubnav({
  projectId,
  current,
  sections,
}: {
  projectId: string;
  current: ProjectSection;
  sections: readonly ProjectSection[];
}) {
  const t = await getTranslations("subcontracts.project.sections");
  const href: Record<ProjectSection, string> = {
    subcontracts: `/subcontracts/projects/${projectId}`,
    "piece-rate": `/subcontracts/projects/${projectId}/piece-rate`,
    output: `/subcontracts/projects/${projectId}/piece-rate/output`,
  };
  return (
    <nav aria-label={t("label")} className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {sections.map((section) => (
          <li key={section}>
            <Link
              href={href[section]}
              aria-current={section === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                section === current
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(section)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
