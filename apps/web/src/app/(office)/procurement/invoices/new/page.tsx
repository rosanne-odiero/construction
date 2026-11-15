import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import { lpoDetailResponseSchema, lposResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { InvoiceForm } from "@/components/procurement/p2p/invoice-form";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import { isUuid, pickParam } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.invoices.form");
  return { title: t("newTitle") };
}

const selectClass =
  "h-9 w-full sm:w-[28rem] rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Record a supplier invoice against an approved LPO (D5.2). */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const lpoId = isUuid(pickParam(raw, "lpo")) ? pickParam(raw, "lpo") : undefined;
  const path = `/procurement/invoices/new${lpoId ? `?lpo=${lpoId}` : ""}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [approved, units, chosen] = await Promise.all([
    loadOrRedirect("/procurement/lpos?status=approved&limit=200", lposResponseSchema, path),
    unitOptions(),
    lpoId ? serverApi(`/procurement/lpos/${lpoId}`, lpoDetailResponseSchema) : null,
  ]);
  if (!approved.ok)
    return approved.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("p2p.invoices");
  const tCommon = await getTranslations("p2p.common");
  const lpo = chosen?.ok && chosen.data.permissions.canInvoice ? chosen.data : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/invoices", label: t("title") }} />}
        title={t("form.newTitle")}
        description={t("form.description")}
      />
      {approved.data.lpos.length ? (
        <form
          method="get"
          action="/procurement/invoices/new"
          className="flex flex-wrap items-end gap-3"
        >
          <div className="w-full min-w-0 space-y-1.5 sm:w-auto">
            <label htmlFor="invoice-lpo" className="block text-sm font-medium">
              {t("form.lpo")}
            </label>
            <select
              id="invoice-lpo"
              name="lpo"
              defaultValue={lpo?.lpo.id ?? ""}
              className={selectClass}
            >
              <option value="">{t("form.chooseLpo")}</option>
              {approved.data.lpos.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.number} · {entry.supplier.name} · {entry.project.code}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary">
            {tCommon("apply")}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t("form.noLpos")}</p>
      )}
      {lpo ? <InvoiceForm key={lpo.lpo.id} lpo={lpo} units={units} today={nairobiDate()} /> : null}
    </div>
  );
}
