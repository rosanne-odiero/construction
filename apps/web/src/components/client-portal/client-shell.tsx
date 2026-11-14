import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import type { ProjectStatus } from "@pm-buddy/types";
import type { ClientDisplay } from "@pm-buddy/validation";
import { ProjectStatusBadge } from "@/components/projects/project-status-badge";
import { HeadingBadge } from "@/components/supplier-portal/supplier-nav";
import { formatCalendarDate, formatKES } from "@/lib/format";
import {
  CLIENT_SECTIONS,
  conversionUnavailable,
  indicative,
  sectionHref,
  type ClientSection,
} from "@/lib/client-portal";
import { cn } from "@/lib/utils";

/**
 * A KES amount with, when the client chose another display currency, its indicative conversion
 * ("≈ USD 953.70 at 129.45 KES/USD on 14/11/2026 (indicative)"). KES stays the amount owed.
 */
export async function Money({
  minor,
  display,
  today,
  className,
}: {
  minor: number;
  display: ClientDisplay;
  today: string;
  className?: string;
}) {
  const t = await getTranslations("clientPortal.money");
  const converted = indicative(minor, display, today);
  return (
    <span className={cn("inline-flex flex-col", className)}>
      <span className="tabular-nums">{formatKES(minor)}</span>
      {converted ? (
        <span className="text-xs font-normal text-muted-foreground">
          {t("indicative", {
            amount: converted.amount,
            rate: converted.rate,
            currency: converted.currency,
            date: formatCalendarDate(converted.rateDate),
          })}
        </span>
      ) : null}
    </span>
  );
}

/** Says once per page that the chosen currency has no current rate (amounts stay in KES). */
export async function ConversionNote({ display }: { display: ClientDisplay }) {
  if (!conversionUnavailable(display)) return null;
  const t = await getTranslations("clientPortal.money");
  return (
    <p role="status" className="rounded-md border bg-background p-3 text-sm">
      {t("unavailable", { currency: display.currency })}{" "}
      <Link href="/portal/settings" className="underline underline-offset-4">
        {t("settings")}
      </Link>
    </p>
  );
}

/** A project page's back link, title, status and the links between the project's pages. */
export async function ClientProjectHeader({
  project,
  current,
  title,
  description,
}: {
  project: { id: string; code: string; name: string; status: ProjectStatus };
  current: ClientSection;
  title?: string;
  description?: string;
}) {
  const t = await getTranslations("clientPortal");
  return (
    <div className="space-y-4">
      <Link
        href="/portal"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t("back")}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight break-words">
            {title ?? project.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {title ? `${project.name} · ` : ""}
            <span className="font-mono text-xs">{project.code}</span>
          </p>
          {description ? <p className="text-muted-foreground">{description}</p> : null}
        </div>
        <HeadingBadge>
          <ProjectStatusBadge status={project.status} />
        </HeadingBadge>
      </div>
      <nav aria-label={t("nav.label")} className="-mx-1 overflow-x-auto">
        <ul className="flex min-w-max gap-1 border-b px-1">
          {CLIENT_SECTIONS.map((section) => (
            <li key={section}>
              <Link
                href={sectionHref(project.id, section)}
                aria-current={section === current ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium",
                  section === current
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`nav.${section}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** A labelled progress bar; "not available" (never 0 %) when the share is undefined. */
export async function ProgressBar({
  label,
  percent,
  tone = "primary",
}: {
  label: string;
  percent: string | null;
  tone?: "primary" | "muted";
}) {
  const t = await getTranslations("clientPortal");
  const value = percent === null ? null : Math.min(100, Math.max(0, Number(percent)));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="font-semibold tabular-nums">
          {percent === null ? t("notAvailable") : `${percent}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        aria-valuetext={percent === null ? t("notAvailable") : `${percent}%`}
        className="h-2.5 overflow-hidden rounded-full bg-muted"
      >
        {value === null ? null : (
          <div
            className={cn(
              "h-full rounded-full",
              tone === "primary" ? "bg-primary" : "bg-muted-foreground/60",
            )}
            style={{ width: `${value}%` }}
          />
        )}
      </div>
    </div>
  );
}
