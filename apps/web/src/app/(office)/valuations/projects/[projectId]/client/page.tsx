import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { clientPaymentsResponseSchema } from "@pm-buddy/validation";
import {
  ClientTermsForm,
  ReceiptForm,
  ReverseReceipt,
} from "@/components/client-portal/staff-forms";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ValuationsEyebrow } from "@/components/valuations/valuations-nav";
import { certificateTone } from "@/lib/client-portal";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("clientPayments");
  return { title: t("title") };
}

/**
 * Client payments for a project (D7.1, staff): the certified certificates the client owes, the
 * receipts finance recorded (append-only; a wrong one is reversed with a reason the client
 * sees), the statement exports and the project's client terms.
 */
export default async function ClientPaymentsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const path = `/valuations/projects/${projectId}/client`;
  const result = await loadOrRedirect(
    `/projects/${projectId}/client-payments`,
    clientPaymentsResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("clientPayments");
  const tState = await getTranslations("clientPortal.statement");
  const tMethods = await getTranslations("clientPortal.methods");
  const locale = await getLocale();
  const view = result.data;
  const base = `/api/v1/projects/${projectId}/client-payments/statement`;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <ValuationsEyebrow
            trail={{ href: `/valuations/projects/${projectId}?tab=certificates`, label: t("back") }}
          />
        }
        title={`${view.project.code} · ${t("title")}`}
        description={t("description", { client: view.clientName ?? t("noClientName") })}
        actions={
          <>
            <Button asChild size="sm" variant="outline">
              <a href={`${base}/pdf?locale=${locale}`} download>
                <Download aria-hidden /> {t("exportPdf")}
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={`${base}/xlsx?locale=${locale}`} download>
                <Download aria-hidden /> {t("exportExcel")}
              </a>
            </Button>
          </>
        }
      />
      {view.readOnly ? (
        <p role="status" className="rounded-md border bg-muted p-3 text-sm">
          {t("readOnly")}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {view.clientMembers
          ? t("clientMembers", { count: view.clientMembers })
          : t("noClientMembers")}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={t("totals.certified")} value={formatKES(view.totals.certifiedMinor)} />
        <KpiCard label={t("totals.received")} value={formatKES(view.totals.receivedMinor)} />
        <KpiCard label={t("totals.outstanding")} value={formatKES(view.totals.outstandingMinor)} />
        <KpiCard label={t("totals.overdue")} value={formatKES(view.totals.overdueMinor)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("certificatesTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent
          role="region"
          aria-label={t("certificatesTitle")}
          tabIndex={0}
          className="overflow-x-auto"
        >
          {view.certificates.length ? (
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t("columns.certificate")}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t("columns.due")}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    {t("columns.total")}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    {t("columns.received")}
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    {t("columns.outstanding")}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t("columns.status")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.certificates.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {row.number}
                      {row.accountReference ? (
                        <span className="block font-mono text-xs font-normal text-muted-foreground">
                          {t("account", { reference: row.accountReference })}
                        </span>
                      ) : null}
                    </th>
                    <td className="py-2 pr-3">{formatCalendarDate(row.dueDate)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatKES(row.totalMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatKES(row.receivedMinor)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatKES(row.outstandingMinor)}
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={certificateTone(row.state, row.overdue)}>
                        {row.overdue
                          ? tState("overdueDays", { days: row.overdueDays })
                          : tState(`states.${row.state}`)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noCertificates")}</p>
          )}
        </CardContent>
      </Card>
      {view.permissions.canRecord ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("recordTitle")}</h2>
            </CardTitle>
            <p className="text-sm text-muted-foreground">{t("recordDescription")}</p>
          </CardHeader>
          <CardContent>
            <ReceiptForm
              projectId={projectId}
              certificates={view.certificates.map((row) => ({
                id: row.id,
                number: row.number,
                outstandingMinor: row.outstandingMinor,
              }))}
            />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("receiptsTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.payments.length ? (
            <ul className="space-y-3 text-sm">
              {[...view.payments].reverse().map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-start justify-between gap-3 border-b pb-3 last:border-0"
                >
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {row.kind === "receipt"
                        ? t("receiptLine", {
                            number: row.certificateNumber,
                            method: row.method ? tMethods(row.method) : "",
                            reference: row.reference ?? "",
                          })
                        : t("reversalLine", { number: row.certificateNumber })}
                    </span>
                    <span className="block text-muted-foreground">
                      {t("recorded", {
                        date: formatCalendarDate(row.receivedOn),
                        name: row.recordedBy.displayName,
                        at: formatDateTime(row.recordedAt),
                      })}
                    </span>
                    {row.note ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("note", { note: row.note })}
                      </span>
                    ) : null}
                    {row.reason ? (
                      <span className="block text-xs">{t("reason", { reason: row.reason })}</span>
                    ) : null}
                  </span>
                  <span className="flex flex-col items-end gap-2">
                    <span
                      className={
                        row.reversed ? "tabular-nums line-through" : "tabular-nums font-semibold"
                      }
                    >
                      {formatKES(row.kind === "reversal" ? -row.amountMinor : row.amountMinor)}
                    </span>
                    {row.reversed ? (
                      <StatusBadge tone="neutral">{t("reversed")}</StatusBadge>
                    ) : null}
                    {row.kind === "receipt" && !row.reversed && view.permissions.canRecord ? (
                      <ReverseReceipt projectId={projectId} paymentId={row.id} />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noReceipts")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("termsTitle")}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {view.settings.version
              ? t("termsVersion", {
                  version: view.settings.version,
                  name: view.settings.updatedBy?.displayName ?? "—",
                  at: view.settings.updatedAt ? formatDateTime(view.settings.updatedAt) : "—",
                })
              : t("termsDefaults")}
          </p>
        </CardHeader>
        <CardContent>
          {view.permissions.canManageSettings ? (
            <ClientTermsForm
              projectId={projectId}
              version={view.settings.version}
              clientApprovalRequired={view.settings.clientApprovalRequired}
              paymentTermsDays={view.settings.paymentTermsDays}
            />
          ) : (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("approvalRequired")}</dt>
                <dd>{view.settings.clientApprovalRequired ? t("yes") : t("no")}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("paymentDays")}</dt>
                <dd>{view.settings.paymentTermsDays}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
