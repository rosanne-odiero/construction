import { getTranslations } from "next-intl/server";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleX,
  Database,
  ExternalLink,
  FileJson,
  HardDrive,
  Mail,
  Server,
  SquareTerminal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { API_INTERNAL_URL, fetchReadiness } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AutoRefresh } from "./auto-refresh";

export async function generateMetadata() {
  const t = await getTranslations("systemStatus");
  return { title: t("title") };
}

type CheckKey = "api" | "database" | "redis" | "storage";

const checkIcons: Record<CheckKey, LucideIcon> = {
  api: Server,
  database: Database,
  redis: Zap,
  storage: HardDrive,
};

// Local tools started by `pnpm services:up` (infra/docker/compose.yaml).
const devTools = [
  { key: "apiDocs", href: "/api/docs", icon: SquareTerminal },
  { key: "openapi", href: "/api/docs/openapi.json", icon: FileJson },
  { key: "mailpit", href: "http://localhost:8025", icon: Mail },
  {
    key: "storageConsole",
    href: "http://localhost:9001/rustfs/console/index.html",
    icon: HardDrive,
  },
] as const;

const overallStyles = {
  ok: { icon: CircleCheck, className: "border-l-success [&_[data-overall-icon]]:text-success" },
  degraded: {
    icon: CircleAlert,
    className: "border-l-warning [&_[data-overall-icon]]:text-warning",
  },
  unreachable: {
    icon: CircleX,
    className: "border-l-destructive [&_[data-overall-icon]]:text-destructive",
  },
} as const;

const code = (chunks: React.ReactNode) => (
  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{chunks}</code>
);

export default async function SystemStatusPage() {
  const t = await getTranslations("systemStatus");
  const result = await fetchReadiness();
  const overall = !result.reachable ? "unreachable" : result.report.status;
  const OverallIcon = overallStyles[overall].icon;

  const checks = result.reachable
    ? [
        { key: "api" as const, status: "up" as const, latencyMs: result.roundTripMs },
        { key: "database" as const, ...result.report.checks.database },
        { key: "redis" as const, ...result.report.checks.redis },
        { key: "storage" as const, ...result.report.checks.storage },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <StatusBadge tone="info" icon={<Activity className="size-3" aria-hidden />}>
            {t("liveBadge")}
          </StatusBadge>
        }
        title={t("title")}
        description={t("description")}
        actions={<AutoRefresh />}
      />

      <Card className={cn("border-l-4", overallStyles[overall].className)} aria-live="polite">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <OverallIcon data-overall-icon className="size-5 shrink-0" aria-hidden />
            {t(`overall.${overall}`)}
          </CardTitle>
          <CardDescription>
            {result.reachable
              ? [
                  t("version", { version: result.report.version }),
                  result.report.commit
                    ? t("commit", { commit: result.report.commit.slice(0, 7) })
                    : null,
                  t("roundTrip", { ms: result.roundTripMs }),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t(`unreachable.${result.reason}`, { url: API_INTERNAL_URL })}
          </CardDescription>
          {result.reachable ? (
            <CardAction className="text-xs text-muted-foreground">
              {t("checkedAt", { time: formatDateTime(result.report.time) })}
            </CardAction>
          ) : null}
        </CardHeader>
        {result.reachable ? null : (
          <CardContent>
            <p className="mb-2 text-sm font-medium">{t("unreachable.stepsTitle")}</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>{t.rich("unreachable.stepServices", { code })}</li>
              <li>{t.rich("unreachable.stepMigrate", { code })}</li>
              <li>{t.rich("unreachable.stepDev", { code })}</li>
            </ol>
          </CardContent>
        )}
      </Card>

      {checks.length > 0 ? (
        <section aria-labelledby="checks-heading" className="space-y-3">
          <h2 id="checks-heading" className="text-sm font-medium text-muted-foreground">
            {t("checksHeading")}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {checks.map((check) => {
              const Icon = checkIcons[check.key];
              const up = check.status === "up";
              return (
                <li key={check.key}>
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Icon className="size-4 text-muted-foreground" aria-hidden />
                        {t(`checks.${check.key}.name`)}
                      </CardTitle>
                      <CardDescription>{t(`checks.${check.key}.description`)}</CardDescription>
                    </CardHeader>
                    <CardContent className="mt-auto space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <StatusBadge
                          tone={up ? "success" : "danger"}
                          icon={
                            up ? (
                              <CircleCheck className="size-3" aria-hidden />
                            ) : (
                              <CircleX className="size-3" aria-hidden />
                            )
                          }
                        >
                          {t(`state.${check.status}`)}
                        </StatusBadge>
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {t("latency", { ms: check.latencyMs })}
                        </span>
                      </div>
                      {"error" in check && check.error ? (
                        <p className="font-mono text-xs break-words text-destructive">
                          {check.error}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {process.env.NODE_ENV === "development" ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("devTools.title")}</CardTitle>
            <CardDescription>{t.rich("devTools.description", { code })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2">
              {devTools.map((tool) => (
                <li key={tool.key}>
                  <a
                    href={tool.href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <tool.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 font-medium">{t(`devTools.${tool.key}`)}</span>
                    <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="sr-only">{t("devTools.newTab")}</span>
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
