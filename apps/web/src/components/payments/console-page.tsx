import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import * as wire from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { loadLive, requireSession } from "@/lib/server-api";
import { paymentRoute } from "@/lib/payments";
import { PaymentConsole, type ConsoleData } from "./console";

export async function PaymentsPage({
  segments = [],
  search = {},
}: {
  segments?: string[];
  search?: Record<string, string | string[] | undefined>;
}) {
  const route = paymentRoute(segments);
  if (!route) notFound();
  const href = segments.length ? `/payments/${segments.join("/")}` : "/payments";
  const session = await requireSession(href);
  if (!session) return <LiveUnavailable retryHref={href} />;
  if (
    !session.company.tenantWide ||
    !session.company.permissions.some(
      (p) =>
        p === "payments.view" || (route.kind === "settings" && p === "payments.manage_credentials"),
    )
  )
    return <LiveForbidden />;
  const t = await getTranslations("payments");
  const offset = Math.min(100_000, Math.max(0, Number(search.offset) || 0));
  const list = ["requests", "callbacks", "cases"].includes(route.kind);
  const statusSchema =
    route.kind === "requests"
      ? wire.paymentRequestStatusSchema
      : route.kind === "callbacks"
        ? wire.callbackStatusSchema
        : wire.reconciliationCaseStatusSchema;
  const status = statusSchema.safeParse(search.status);
  const suffix = list
    ? `?limit=25&offset=${offset}${status.success ? `&status=${status.data}` : ""}`
    : "";
  let data: ConsoleData;
  switch (route.kind) {
    case "overview": {
      const r = await loadLive(route.path, wire.paymentsOverviewResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "new": {
      const r = await loadLive("/payments/overview", wire.paymentsOverviewResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      if (!r.data.permissions.initiateTest) return <LiveForbidden />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "settings": {
      const r = await loadLive(route.path, wire.paymentSettingsResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "requests": {
      const r = await loadLive(route.path + suffix, wire.paymentRequestsResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "callbacks": {
      const r = await loadLive(route.path + suffix, wire.paymentCallbacksResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "cases": {
      const r = await loadLive(route.path + suffix, wire.reconciliationCasesResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "requestsDetail": {
      const r = await loadLive(route.path, wire.paymentRequestDetailResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "callbacksDetail": {
      const r = await loadLive(route.path, wire.paymentCallbackResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
    case "casesDetail": {
      const r = await loadLive(route.path, wire.reconciliationCaseResponseSchema, href);
      if (!r.ok) return r.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={href} />;
      data = { kind: route.kind, value: r.data };
      break;
    }
  }
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader title={t("title")} description={t("safety")} />
      <nav aria-label={t("navigation")} className="flex flex-wrap gap-4 text-sm">
        {(["overview", "requests", "callbacks", "cases", "settings", "new"] as const)
          .filter(
            (key) =>
              key !== "new" || session.company.permissions.includes("payments.initiate_test"),
          )
          .map((key) => (
            <Link
              key={key}
              href={key === "overview" ? "/payments" : `/payments/${key}`}
              aria-current={route.kind === key ? "page" : undefined}
              className="underline underline-offset-4"
            >
              {t(`nav.${key}`)}
            </Link>
          ))}
      </nav>
      <PaymentConsole
        key={href}
        data={data}
        offset={offset}
        status={status.success ? status.data : ""}
      />
    </div>
  );
}
