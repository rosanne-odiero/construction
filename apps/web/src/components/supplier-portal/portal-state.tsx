import { getTranslations } from "next-intl/server";
import { LiveUnavailable } from "@/components/projects/live-state";

/** The access has ended or was never linked to a supplier (the API answered 403). */
export async function SupplierNotLinked() {
  const t = await getTranslations("supplierPortal.notLinked");
  return (
    <div role="alert" className="mx-auto max-w-md space-y-2 rounded-xl border p-6 text-center">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
    </div>
  );
}

/** The state of a supplier page that could not load its data. */
export async function SupplierPageState({
  kind,
  retryHref,
}: {
  kind: "unavailable" | "notLinked";
  retryHref: string;
}) {
  return kind === "notLinked" ? <SupplierNotLinked /> : <LiveUnavailable retryHref={retryHref} />;
}
