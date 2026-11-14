import { getTranslations } from "next-intl/server";
import type { ComplianceHistoryResponse } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { complianceTypeLabel } from "@/lib/documents";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { ComplianceStatusBadge } from "./compliance-status";
import { EvidenceLink } from "./evidence-link";

/** The item's derived status and every record, newest first (renewals are append-only). */
export async function ComplianceHistory({ data }: { data: ComplianceHistoryResponse }) {
  const t = await getTranslations("documents");
  const { item, records } = data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="compliance-status">
        <ComplianceStatusBadge status={item.status}>
          {t(`complianceStatuses.${item.status}`)}
        </ComplianceStatusBadge>
        {item.daysLeft !== null && (item.status === "expiring" || item.status === "expired") ? (
          <span className="text-sm text-muted-foreground">
            {item.daysLeft < 0
              ? t("common.daysAgo", { days: -item.daysLeft })
              : t("common.daysLeft", { days: item.daysLeft })}
          </span>
        ) : null}
        {item.type.scope === "company" ? (
          <StatusBadge tone="info">{t("compliance.companyItem")}</StatusBadge>
        ) : null}
        {item.type.expires ? (
          <span className="text-sm text-muted-foreground">
            {t("types.reminderDays", { days: item.type.reminderDays })}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{t("compliance.noExpiry")}</span>
        )}
      </div>
      {item.type.complianceReview ? (
        <p className="text-xs text-muted-foreground">{t("common.complianceReview")}</p>
      ) : null}
      <section aria-labelledby="compliance-history" className="space-y-2">
        <h2 id="compliance-history" className="text-base font-semibold">
          {t("compliance.historyTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("compliance.historyHint")}</p>
        {records.length ? (
          <ol className="space-y-3">
            {records.map((record) => (
              <li key={record.id}>
                <Card data-state={record.state} className="gap-2 py-4">
                  <CardHeader className="px-4">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                      <StatusBadge tone={record.state === "current" ? "success" : "neutral"}>
                        {t(`compliance.states.${record.state}`)}
                      </StatusBadge>
                      {record.kind === "not_applicable"
                        ? t("complianceStatuses.not_applicable")
                        : (record.referenceNo ??
                          complianceTypeLabel(item.type, (key) => t(key as never)))}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 px-4 text-sm">
                    {record.kind === "not_applicable" ? (
                      <p>{t("compliance.notApplicableBy", { reason: record.reason ?? "—" })}</p>
                    ) : (
                      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                        <div>
                          <dt className="text-muted-foreground">{t("compliance.issuer")}</dt>
                          <dd>{record.issuer ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("compliance.issuedOn")}</dt>
                          <dd className="tabular-nums">
                            {record.issuedOn ? formatCalendarDate(record.issuedOn) : "—"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("compliance.expiresOn")}</dt>
                          <dd className="tabular-nums">
                            {record.expiresOn
                              ? formatCalendarDate(record.expiresOn)
                              : t("compliance.noExpiry")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{t("compliance.cols.evidence")}</dt>
                          <dd>
                            {record.evidence ? <EvidenceLink evidence={record.evidence} /> : "—"}
                          </dd>
                        </div>
                      </dl>
                    )}
                    {record.notes ? <p className="whitespace-pre-line">{record.notes}</p> : null}
                    <p className="text-xs text-muted-foreground">
                      {t("compliance.recordedBy", {
                        name: record.recordedBy.displayName,
                        date: formatDateTime(record.recordedAt),
                      })}
                    </p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{t("compliance.historyEmpty")}</p>
        )}
      </section>
    </div>
  );
}
