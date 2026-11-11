import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { formatDate } from "@/lib/format";
import { payrollBatch } from "@/mocks/payroll";
import { PayrollBatchView } from "./payroll-batch";

export async function generateMetadata() {
  const t = await getTranslations("nav.items");
  return { title: t("payroll") };
}

export default async function PayrollPage() {
  const t = await getTranslations("payroll");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={payrollBatch.project}
        title={t("title", { batch: payrollBatch.number })}
        description={t("description", {
          start: formatDate(payrollBatch.periodStart),
          end: formatDate(payrollBatch.periodEnd),
        })}
      />
      <PayrollBatchView />
    </div>
  );
}
