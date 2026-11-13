import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";

const SECTIONS = ["bq", "variations", "instructions", "versions"] as const;
export type BqSection = (typeof SECTIONS)[number];

/** Links between a project's BQ pages, plus the company's rate build-up library. */
export async function BqSubnav({ projectId, current }: { projectId: string; current: BqSection }) {
  const t = await getTranslations("bqNav");
  const href = (section: BqSection) =>
    section === "bq" ? `/projects/${projectId}/bq` : `/projects/${projectId}/bq/${section}`;
  return (
    <nav aria-label={t("label")} className="relative -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {SECTIONS.map((section) => (
          <li key={section}>
            <Link
              href={href(section)}
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
        <li>
          <Link
            href="/rate-buildups"
            className="-mb-px inline-flex h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t("buildups")}
          </Link>
        </li>
      </ul>
    </nav>
  );
}

/** Breadcrumb eyebrow used on every BQ page. */
export async function BqEyebrow({
  project,
  trail,
  withBq = true,
}: {
  project: { id: string; code: string; name: string };
  trail?: { href: string; label: string };
  /** False on the BQ page itself. */
  withBq?: boolean;
}) {
  const t = await getTranslations("bqNav");
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link href="/projects" className="hover:underline">
        {t("projects")}
      </Link>
      <span aria-hidden>/</span>
      <Link href={`/projects/${project.id}`} className="hover:underline">
        <span className="font-mono">{project.code}</span> · {project.name}
      </Link>
      {withBq ? (
        <>
          <span aria-hidden>/</span>
          <Link href={`/projects/${project.id}/bq`} className="hover:underline">
            {t("bq")}
          </Link>
        </>
      ) : null}
      {trail ? (
        <>
          <span aria-hidden>/</span>
          <Link href={trail.href} className="hover:underline">
            {trail.label}
          </Link>
        </>
      ) : null}
    </span>
  );
}
