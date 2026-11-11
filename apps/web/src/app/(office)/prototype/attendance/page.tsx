import { getLocale, getTranslations } from "next-intl/server";
import { Clock, ShieldAlert, UserCheck, UserX } from "lucide-react";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { formatWeekdayDate } from "@/lib/format";
import { ATTENDANCE_RULES, musterSummary } from "@/mocks/attendance";
import { NOW } from "@/mocks/company";
import { AttendanceView } from "./attendance-view";

export async function generateMetadata() {
  const t = await getTranslations("nav.items");
  return { title: t("attendance") };
}

export default async function AttendancePage() {
  const t = await getTranslations("attendance");
  const locale = await getLocale();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Ruiru Heights Apartments · ${formatWeekdayDate(NOW, locale)}`}
        title={t("title")}
        description={t("description", { lateAfter: ATTENDANCE_RULES.lateAfter })}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t("kpi.present")}
          value={`${musterSummary.present}/${musterSummary.rostered}`}
          hint={t("kpi.presentHint")}
          icon={<UserCheck />}
        />
        <KpiCard
          label={t("kpi.late")}
          value={musterSummary.late}
          hint={t("kpi.lateHint", { time: ATTENDANCE_RULES.lateAfter })}
          icon={<Clock />}
        />
        <KpiCard
          label={t("kpi.absent")}
          value={musterSummary.absent}
          hint={t("kpi.absentHint")}
          icon={<UserX />}
        />
        <KpiCard
          label={t("kpi.anomalies")}
          value={musterSummary.anomalies}
          hint={t("kpi.anomaliesHint", { critical: musterSummary.critical })}
          icon={<ShieldAlert />}
          tone="danger"
        />
      </div>
      <AttendanceView />
    </div>
  );
}
