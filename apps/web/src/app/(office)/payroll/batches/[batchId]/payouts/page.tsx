import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { batchPayoutsResponseSchema } from "@pm-buddy/validation";
import { PayoutsBoard } from "@/components/payroll/payouts-board";
import { PayrollShell } from "@/components/payroll/payroll-shell";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("payouts.board");
  return { title: t("title") };
}

/** Live payouts of an approved payroll batch (D4.3): float, start, per-worker status. */
export default async function BatchPayoutsPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  if (!z.uuid().safeParse(batchId).success) notFound();
  const path = `/payroll/batches/${batchId}/payouts`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(path, batchPayoutsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("payouts.board");
  return (
    <PayrollShell title={t("title")}>
      <PayoutsBoard
        initial={result.data}
        userId={session.user.id}
        canDispute={
          session.company.tenantWide && session.company.permissions.includes("payments.review")
        }
      />
    </PayrollShell>
  );
}
