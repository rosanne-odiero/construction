import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import { catalogues, isLocale } from "@pm-buddy/i18n";
import { labourerResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ConsentBadge } from "@/components/labour/labour-badges";
import { ConsentActions } from "@/components/labour/consent-actions";
import type { ConsentNotices } from "@/components/labour/consent-notice";
import { LabourNav } from "@/components/labour/labour-nav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.consentPage");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LabourerConsentPage({
  params,
}: {
  params: Promise<{ labourerId: string }>;
}) {
  const { labourerId } = await params;
  const path = `/labour/${labourerId}/consent`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  if (!UUID.test(labourerId)) notFound();
  const result = await loadLive(`/labour/labourers/${labourerId}`, labourerResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { labourer } = result.data;
  const t = await getTranslations("labourLive");
  const locale = await getLocale();
  const notices: ConsentNotices = {
    en: catalogues.en.labourConsentNotices.registrationV1,
    sw: catalogues.sw.labourConsentNotices.registrationV1,
  };
  const active = labourer.consent.status === "granted";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("consentPage.heading", { name: labourer.fullName })}
        description={t("consentPage.description")}
        actions={
          <Button asChild variant="outline">
            <Link href={`/labour?worker=${labourer.id}`}>
              <ArrowLeft aria-hidden /> {t("consentPage.back", { workerNo: labourer.workerNo })}
            </Link>
          </Button>
        }
      />
      <LabourNav current="registry" />
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t("consentPage.current")}</span>
        <ConsentBadge consent={labourer.consent} />
        {labourer.consent.noticeVersion ? (
          <span className="font-mono text-xs text-muted-foreground">
            {labourer.consent.noticeVersion}
          </span>
        ) : null}
      </p>
      {labourer.consent.status === "withdrawn" ? (
        <p className="max-w-3xl text-sm text-muted-foreground">{t("consentPage.withdrawnHint")}</p>
      ) : null}

      {labourer.permissions.canConsent ? (
        <ConsentActions
          labourerId={labourer.id}
          mode={active && labourer.consent.current ? "withdraw" : "record"}
          canWithdraw={active}
          notices={notices}
          noticeVersion={CURRENT_CONSENT_NOTICE.version}
          company={session.company.name}
          initialLanguage={isLocale(locale) ? locale : "en"}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("consentPage.readOnly")}</p>
      )}

      <section aria-labelledby="consent-history" className="space-y-2">
        <h2 id="consent-history" className="text-base font-semibold">
          {t("consentPage.history")}
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableCaption className="sr-only">{t("consentPage.history")}</TableCaption>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>{t("consentPage.columns.version")}</TableHead>
                <TableHead>{t("consentPage.columns.language")}</TableHead>
                <TableHead>{t("consentPage.columns.method")}</TableHead>
                <TableHead>{t("consentPage.columns.captured")}</TableHead>
                <TableHead>{t("consentPage.columns.withdrawn")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {labourer.consents.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-mono text-xs">{record.noticeVersion}</TableCell>
                  <TableCell>{t(`consent.languages.${record.language}`)}</TableCell>
                  <TableCell>
                    {t(`consent.methods.${record.method}`)}
                    {record.witnessName ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("consentPage.witness", { name: record.witnessName })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="tabular-nums">{formatDateTime(record.capturedAt)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {record.capturedBy.displayName}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {record.withdrawnAt ? (
                      <>
                        <span className="tabular-nums">{formatDateTime(record.withdrawnAt)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {record.withdrawnBy?.displayName}
                          {record.withdrawalMethod
                            ? ` · ${t(`consent.methods.${record.withdrawalMethod}`)}`
                            : ""}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {labourer.consents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    {t("consentPage.none")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
