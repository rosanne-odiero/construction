import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ClipboardCheck, FileText, Receipt, ScrollText, Truck, Wallet } from "lucide-react";
import { supplierPortalOverviewResponseSchema } from "@pm-buddy/validation";
import { SupplierPageState } from "@/components/supplier-portal/portal-state";
import { PortalHeading, SupplierNav } from "@/components/supplier-portal/supplier-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatKES } from "@/lib/format";
import { loadSupplierPage } from "@/lib/supplier-portal-server";

export async function generateMetadata() {
  const t = await getTranslations("portals");
  return { title: t("supplierName") };
}

/** Supplier portal home (D7.2): the supplier's open orders, invoices and what is outstanding. */
export default async function SupplierPortalPage() {
  const page = await loadSupplierPage(
    "/supplier",
    "/portal/supplier",
    supplierPortalOverviewResponseSchema,
  );
  if (page.kind !== "ok") return <SupplierPageState kind={page.kind} retryHref="/supplier" />;
  const t = await getTranslations("supplierPortal");
  const { company, supplier, displayName, counts, outstandingMinor } = page.data;
  const tiles = [
    { key: "openLpos", value: counts.openLpos, icon: FileText, href: "/supplier/lpos" },
    {
      key: "toAcknowledge",
      value: counts.unacknowledgedLpos,
      icon: ClipboardCheck,
      href: "/supplier/lpos",
    },
    { key: "deliveries", value: counts.deliveries, icon: Truck, href: "/supplier/deliveries" },
    {
      key: "underReview",
      value: counts.invoicesUnderReview,
      icon: Receipt,
      href: "/supplier/invoices?status=under_review",
    },
    {
      key: "disputed",
      value: counts.invoicesDisputed,
      icon: Receipt,
      href: "/supplier/invoices?status=disputed",
    },
    {
      key: "awaitingPayment",
      value: counts.invoicesAwaitingPayment,
      icon: Wallet,
      href: "/supplier/invoices?status=approved",
    },
  ] as const;
  return (
    <div className="space-y-6">
      <PortalHeading
        title={t("home.greeting", { name: displayName })}
        description={t("home.description", { supplier: supplier.name, company: company.name })}
      />
      <SupplierNav current="home" />
      <Card>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground">{t("home.outstanding")}</p>
          <p className="text-3xl font-semibold tabular-nums" data-testid="outstanding">
            {formatKES(outstandingMinor)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("home.outstandingHint", { company: company.name })}
          </p>
        </CardContent>
      </Card>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <Link
              href={tile.href}
              className="flex items-center gap-3 rounded-xl border bg-card p-4 hover:bg-accent"
            >
              <tile.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 text-sm">{t(`home.${tile.key}`)}</span>
              <span className="text-xl font-semibold tabular-nums">{tile.value}</span>
            </Link>
          </li>
        ))}
      </ul>
      {counts.openLpos === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center">
          {t("home.empty", { company: company.name })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/supplier/lpos">
            <FileText aria-hidden /> {t("home.viewLpos")}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/supplier/statement">
            <ScrollText aria-hidden /> {t("home.viewStatement")}
          </Link>
        </Button>
      </div>
      <p className="rounded-md border bg-muted p-3 text-sm">
        {t("paymentNote", { company: company.name })}
      </p>
    </div>
  );
}
