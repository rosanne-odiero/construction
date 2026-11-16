import { getTranslations } from "next-intl/server";
import * as wire from "@pm-buddy/validation";
import { PaymentsFrame } from "@/components/payments/payments-frame";
import { TariffsPanel } from "@/components/payments/reconciliation";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { paymentsAllowed } from "@/lib/payments";
import { loadLive, requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("reconciliation.tariffs");
  return { title: t("title") };
}

/** The B2C charges tariff (D4.3 §12): DEMO bands until the company verifies its own. */
export default async function TariffsPage() {
  const href = "/payments/tariffs";
  const session = await requireSession(href);
  if (!session) return <LiveUnavailable retryHref={href} />;
  if (!paymentsAllowed(session.company, ["payments.view", "config.manage"]))
    return <LiveForbidden />;
  const result = await loadLive(href, wire.tariffsResponseSchema, href);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
  const t = await getTranslations("reconciliation.tariffs");
  return (
    <PaymentsFrame
      current="tariffs"
      title={t("title")}
      description={t("description")}
      canTest={session.company.permissions.includes("payments.initiate_test")}
    >
      <TariffsPanel
        key={result.data.versions.map((version) => version.id).join()}
        value={result.data}
      />
    </PaymentsFrame>
  );
}
