import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { floatResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { ExpenseForm } from "@/components/spending/expense-form";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { SpendingEyebrow } from "@/components/spending/spending-subnav";
import { formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.expenseForm");
  return { title: t("title") };
}

/** Expense capture for the float's custodian, built for a phone at 360 px (D5.4). */
export default async function RecordExpensePage({
  params,
}: {
  params: Promise<{ floatId: string }>;
}) {
  const { floatId } = await params;
  if (!isUuid(floatId)) notFound();
  const path = `/spending/petty-cash/${floatId}/expense`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(`/petty-cash/floats/${floatId}`, floatResponseSchema, path);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.expenseForm");
  const { float, permissions } = result.data;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        eyebrow={
          <SpendingEyebrow trail={{ href: `/spending/petty-cash/${floatId}`, label: float.name }} />
        }
        title={t("title")}
        description={t("description", {
          float: float.name,
          balance: formatKES(float.balanceMinor),
        })}
      />
      {permissions.canRecordExpense ? (
        <ExpenseForm
          floatId={float.id}
          projectId={float.project.id}
          balanceMinor={float.balanceMinor}
        />
      ) : (
        <SentenceBadge tone="warning">
          {t("notCustodian", { name: float.custodian.displayName })}
        </SentenceBadge>
      )}
    </div>
  );
}
