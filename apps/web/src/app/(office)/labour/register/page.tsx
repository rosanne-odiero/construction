import { getLocale, getTranslations } from "next-intl/server";
import { CURRENT_CONSENT_NOTICE } from "@pm-buddy/types";
import { catalogues, isLocale } from "@pm-buddy/i18n";
import { nairobiDate } from "@pm-buddy/domain";
import { labourSetupResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { LabourNav } from "@/components/labour/labour-nav";
import { RegisterForm } from "@/components/labour/register-form";
import type { ConsentNotices } from "@/components/labour/consent-notice";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.register");
  return { title: t("title") };
}

const noticeText = (messageKey: string): ConsentNotices => {
  const pick = (locale: "en" | "sw") =>
    (catalogues[locale].labourConsentNotices as Record<string, ConsentNotices["en"]>)[messageKey]!;
  return { en: pick("en"), sw: pick("sw") };
};

export default async function RegisterLabourerPage() {
  const path = "/labour/register";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const setup = await loadLive("/labour/setup", labourSetupResponseSchema, path);
  if (!setup.ok)
    return setup.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { permissions, tenantWide } = session.company;
  const companyWide = tenantWide && permissions.includes("labour.manage");
  if (!companyWide && setup.data.manageableProjects.length === 0) return <LiveForbidden />;
  const t = await getTranslations("labourLive");
  const locale = await getLocale();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("register.title")}
        description={t("register.description")}
      />
      <LabourNav current="registry" />
      <RegisterForm
        setup={setup.data}
        companyWide={companyWide}
        canOverride={permissions.includes("labour.do_not_rehire")}
        company={session.company.name}
        today={nairobiDate()}
        notices={noticeText(CURRENT_CONSENT_NOTICE.messageKey)}
        noticeVersion={CURRENT_CONSENT_NOTICE.version}
        initialLanguage={isLocale(locale) ? locale : "en"}
      />
    </div>
  );
}
