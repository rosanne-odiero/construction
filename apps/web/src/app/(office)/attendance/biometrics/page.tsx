import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ShieldAlert } from "lucide-react";
import type { BiometricCaptureMethod } from "@pm-buddy/types";
import { biometricsOverviewResponseSchema } from "@pm-buddy/validation";
import { AttendanceNav } from "@/components/attendance/attendance-nav";
import { SiteSwitchButton, StartDpiaButton } from "@/components/attendance/biometrics-actions";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dpiaStateTone } from "@/lib/biometrics";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("biometrics");
  return { title: t("title") };
}

/**
 * Biometric attendance (D3.4 first slice): the company's DPIA and, per site and method, whether
 * biometric capture may run. Capture stays off until a DPIA is approved here and then runs only
 * where it is switched on under it; the card, photo and supervisor method is never affected.
 */
export default async function BiometricsPage() {
  const path = "/attendance/biometrics";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/biometrics", biometricsOverviewResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const view = result.data;
  const { current, draft, permissions } = view;
  const t = await getTranslations("biometrics");
  const ta = await getTranslations("attendanceLive");
  const methodList = (methods: readonly BiometricCaptureMethod[]) =>
    methods.map((method) => t(`methods.${method}`)).join(", ");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{ta("live")}</StatusBadge>}
        title={t("title")}
        description={t("description")}
      />
      <AttendanceNav current="biometrics" />

      {!view.platformAvailable ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("platformOff")}
        </p>
      ) : null}

      <section aria-labelledby="dpia-title" className="space-y-3">
        <h2 id="dpia-title" className="text-lg font-semibold">
          {t("dpia.title")}
        </h2>
        <div className="space-y-3 rounded-xl border p-4" data-testid="dpia-current">
          {current ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {t("dpia.version", { version: current.versionNo })}
                </span>
                <StatusBadge tone={dpiaStateTone[current.state]}>
                  {t(`states.${current.state}`)}
                </StatusBadge>
              </div>
              <p className="text-sm">
                {current.state === "lapsed"
                  ? t("dpia.lapsed", { date: formatCalendarDate(current.reviewDue!) })
                  : t("dpia.inForce", {
                      date: formatCalendarDate(current.reviewDue!),
                      methods: methodList(current.methods),
                      count: current.siteCount,
                    })}
              </p>
              <Link
                href={`/attendance/biometrics/dpias/${current.id}`}
                className="text-sm font-medium underline underline-offset-4"
              >
                {t("dpia.open", { version: current.versionNo })}
              </Link>
            </>
          ) : (
            <p className="text-sm">{t("dpia.none")}</p>
          )}
          {draft ? (
            <p className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
              <StatusBadge tone="info">{t("states.draft")}</StatusBadge>
              {t("dpia.draft", { version: draft.versionNo })}
              <Link
                href={`/attendance/biometrics/dpias/${draft.id}`}
                className="font-medium underline underline-offset-4"
              >
                {t("dpia.continue")}
              </Link>
            </p>
          ) : permissions.canPrepare ? (
            <div className="border-t pt-3">
              <StartDpiaButton currentId={current?.id ?? null} />
            </div>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="sites-title" className="space-y-3">
        <div className="space-y-1">
          <h2 id="sites-title" className="text-lg font-semibold">
            {t("sites.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("sites.description")}</p>
        </div>
        {view.sites.length === 0 ? (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            {t("sites.none")}
          </p>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {view.sites.map((site) => (
              <li
                key={site.id}
                className="space-y-3 rounded-xl border p-4"
                aria-labelledby={`site-${site.id}`}
              >
                <div>
                  <h3 id={`site-${site.id}`} className="font-medium">
                    {site.name}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {site.projectCode} · {site.projectName}
                  </p>
                </div>
                <ul className="divide-y">
                  {site.methods.map((state) => (
                    <li
                      key={state.method}
                      className="flex flex-wrap items-center gap-2 py-2"
                      data-testid={`gate-${site.id}-${state.method}`}
                    >
                      <span className="min-w-36 text-sm font-medium">
                        {t(`methods.${state.method}`)}
                      </span>
                      <StatusBadge tone={state.on ? "success" : "neutral"}>
                        {state.on ? t("on") : t(`reasons.${state.reason!}`)}
                      </StatusBadge>
                      {state.lastChange?.carriedForward && state.on ? (
                        <span className="text-xs text-muted-foreground">{t("sites.carried")}</span>
                      ) : null}
                      <span className="ml-auto flex flex-wrap gap-2">
                        {permissions.canSwitchOn && state.reason === "switched_off" ? (
                          <SiteSwitchButton site={site} method={state.method} enabled />
                        ) : null}
                        {permissions.canSwitchOff && state.lastChange?.enabled ? (
                          <SiteSwitchButton site={site} method={state.method} enabled={false} />
                        ) : null}
                      </span>
                      {state.lastChange ? (
                        <span className="basis-full text-xs text-muted-foreground">
                          {t(state.lastChange.enabled ? "sites.lastOn" : "sites.lastOff", {
                            name: state.lastChange.by.displayName,
                            at: formatDateTime(state.lastChange.at),
                          })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="history-title" className="space-y-3">
        <h2 id="history-title" className="text-lg font-semibold">
          {t("history.title")}
        </h2>
        {view.history.length === 0 ? (
          <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            {t("history.none")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="sr-only">{t("history.title")}</TableCaption>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead>{t("history.columns.version")}</TableHead>
                  <TableHead>{t("history.columns.status")}</TableHead>
                  <TableHead>{t("history.columns.methods")}</TableHead>
                  <TableHead>{t("history.columns.sites")}</TableHead>
                  <TableHead>{t("history.columns.reviewDue")}</TableHead>
                  <TableHead>{t("history.columns.approved")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.history.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/attendance/biometrics/dpias/${entry.id}`}
                        className="underline underline-offset-4"
                      >
                        {t("dpia.version", { version: entry.versionNo })}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={dpiaStateTone[entry.state]}>
                        {t(`states.${entry.state}`)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      {methodList(entry.methods) || "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">{entry.siteCount}</TableCell>
                    <TableCell className="tabular-nums">
                      {entry.reviewDue ? formatCalendarDate(entry.reviewDue) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.approvedAt && entry.approvedBy
                        ? `${entry.approvedBy.displayName}, ${formatDateTime(entry.approvedAt)}`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
