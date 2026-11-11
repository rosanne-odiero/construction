import { getTranslations } from "next-intl/server";
import { BadgeCheck, CalendarClock, HardHat, ScanFace } from "lucide-react";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { musterSummary } from "@/mocks/attendance";
import { NOW } from "@/mocks/company";
import { isAccreditationExpiringSoon, labourers } from "@/mocks/labour";
import { LabourTable } from "./labour-table";
import { RegisterWorkerDialog } from "./register-worker-dialog";

export async function generateMetadata() {
  const t = await getTranslations("nav.items");
  return { title: t("labour") };
}

export default async function LabourPage({
  searchParams,
}: {
  searchParams: Promise<{ worker?: string }>;
}) {
  const { worker } = await searchParams;
  const t = await getTranslations("labour");
  const consented = labourers.filter((l) => l.biometricConsent === "granted").length;
  const expiring = labourers.filter((l) => isAccreditationExpiringSoon(l, NOW)).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Ruiru Heights Apartments"
        title={t("title")}
        description={t("description")}
        actions={<RegisterWorkerDialog />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("kpi.active")}
          value={labourers.length}
          hint={t("kpi.activeHint", { gangs: 5 })}
          icon={<HardHat />}
        />
        <KpiCard
          label={t("kpi.onSite")}
          value={`${musterSummary.present}/${musterSummary.rostered}`}
          hint={t("kpi.onSiteHint", { late: musterSummary.late })}
          icon={<ScanFace />}
        />
        <KpiCard
          label={t("kpi.consent")}
          value={`${consented}/${labourers.length}`}
          hint={t("kpi.consentHint", { declined: labourers.length - consented })}
          icon={<BadgeCheck />}
        />
        <KpiCard
          label={t("kpi.expiring")}
          value={expiring}
          hint={t("kpi.expiringHint", { days: 30 })}
          icon={<CalendarClock />}
          tone={expiring ? "warning" : "default"}
        />
      </div>
      <LabourTable initialWorkerId={worker} />
    </div>
  );
}
