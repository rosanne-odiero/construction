import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Download, Settings2 } from "lucide-react";
import { complianceRegisterResponseSchema, type Project } from "@pm-buddy/validation";
import { ComplianceStatusBadge } from "@/components/documents/compliance-status";
import { ReminderList } from "@/components/documents/reminder-list";
import { LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { complianceTypeLabel, exportHref } from "@/lib/documents";
import { formatCalendarDate } from "@/lib/format";
import { loadLive } from "@/lib/server-api";

/**
 * The project's compliance register (D8.4): every item type with its derived status (decision
 * D-116), the reminders, and the PDF/Excel exports in English and Kiswahili.
 */
export async function ComplianceTab({ project, returnTo }: { project: Project; returnTo: string }) {
  const t = await getTranslations("documents");
  const locale = (await getLocale()) === "sw" ? "sw" : "en";
  const result = await loadLive(
    `/projects/${project.id}/compliance`,
    complianceRegisterResponseSchema,
    returnTo,
  );
  if (!result.ok) return <LiveUnavailable retryHref={returnTo} />;
  const { items, counts, reminders, permissions, today } = result.data;
  const label = (type: { key: string; label: string | null }) =>
    complianceTypeLabel(type, (key) => t(key as never));
  const itemHref = (item: (typeof items)[number]) =>
    item.type.scope === "company"
      ? `/documents/company/${item.type.id}`
      : `/projects/${project.id}/compliance/${item.type.id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("compliance.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("compliance.hint")}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{formatCalendarDate(today)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {permissions.canExport ? (
            <div
              role="group"
              aria-label={t("compliance.exportLabel")}
              className="flex flex-wrap gap-2"
            >
              {(["pdf", "xlsx"] as const).map((format) => (
                <Button key={format} asChild variant="outline" size="sm">
                  <a href={exportHref(project.id, format, locale)} download>
                    <Download className="size-4" aria-hidden />
                    {t(format === "pdf" ? "compliance.exportPdf" : "compliance.exportExcel")}
                  </a>
                </Button>
              ))}
              <Button asChild variant="ghost" size="sm">
                <a href={exportHref(project.id, "pdf", locale === "en" ? "sw" : "en")} download>
                  {t("compliance.exportLanguage", {
                    format: "PDF",
                    locale: locale === "en" ? "SW" : "EN",
                  })}
                </a>
              </Button>
            </div>
          ) : null}
          {permissions.canConfigure ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/documents/compliance-types">
                <Settings2 className="size-4" aria-hidden />
                {t("compliance.typesLink")}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <ul className="flex flex-wrap gap-2" aria-label={t("compliance.cols.status")}>
        {(["expired", "expiring", "missing", "valid", "not_applicable"] as const).map((status) => (
          <li key={status}>
            <ComplianceStatusBadge status={status}>
              {t(`complianceStatuses.${status}`)} · {counts[status]}
            </ComplianceStatusBadge>
          </li>
        ))}
      </ul>

      <section aria-labelledby="compliance-reminders" className="space-y-2">
        <h3 id="compliance-reminders" className="text-base font-semibold">
          {t("compliance.remindersTitle")}
        </h3>
        <ReminderList
          reminders={reminders}
          showProject={false}
          emptyText={t("compliance.remindersEmpty")}
        />
      </section>

      <section aria-labelledby="compliance-items" className="space-y-2">
        <h3 id="compliance-items" className="sr-only">
          {t("compliance.title")}
        </h3>
        <div className="relative overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="compliance-register">
            <caption className="sr-only">{t("compliance.title")}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.item")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.status")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.reference")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.expires")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.evidence")}
                </th>
                <th scope="col" className="p-2 font-medium">
                  {t("compliance.cols.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const current = item.current;
                return (
                  <tr key={item.type.id} className="border-t align-top" data-status={item.status}>
                    <th scope="row" className="p-2 text-left font-medium">
                      {label(item.type)}
                      <span className="mt-1 flex flex-wrap gap-1">
                        {item.type.scope === "company" ? (
                          <StatusBadge tone="info">{t("compliance.companyItem")}</StatusBadge>
                        ) : null}
                        {item.type.complianceReview ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            {t("common.complianceReview")}
                          </span>
                        ) : null}
                      </span>
                    </th>
                    <td className="p-2">
                      <ComplianceStatusBadge status={item.status}>
                        {t(`complianceStatuses.${item.status}`)}
                      </ComplianceStatusBadge>
                      {item.daysLeft !== null &&
                      (item.status === "expiring" || item.status === "expired") ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {item.daysLeft < 0
                            ? t("common.daysAgo", { days: -item.daysLeft })
                            : t("common.daysLeft", { days: item.daysLeft })}
                        </span>
                      ) : null}
                      {current?.kind === "not_applicable" && current.reason ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t("compliance.notApplicableBy", { reason: current.reason })}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2">
                      {current?.referenceNo ?? "—"}
                      {current?.issuer ? (
                        <span className="block text-xs text-muted-foreground">
                          {current.issuer}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2 tabular-nums">
                      {current?.expiresOn
                        ? formatCalendarDate(current.expiresOn)
                        : item.type.expires
                          ? "—"
                          : t("compliance.noExpiry")}
                    </td>
                    <td className="p-2">
                      {current?.evidence ? (
                        current.evidence.restricted ? (
                          <span className="text-muted-foreground">{t("common.restricted")}</span>
                        ) : (
                          <Link
                            className="underline"
                            href={`/projects/${current.evidence.projectId}/documents/${current.evidence.documentId}`}
                          >
                            {current.evidence.title} ·{" "}
                            {t("common.revision", { revision: current.evidence.revision })}
                          </Link>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2">
                      <Link className="underline" href={itemHref(item)}>
                        {item.canRecord
                          ? current
                            ? t("compliance.renew")
                            : t("compliance.record")
                          : t("compliance.view")}
                        <span className="sr-only"> · {label(item.type)}</span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
