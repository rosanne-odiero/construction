import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { unitsResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { CatalogueSubnav } from "@/components/procurement/catalogue-subnav";
import { Converter } from "@/components/procurement/converter";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { materialPicker, supplierPicker } from "@/lib/procurement-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { signInHref } from "@/lib/safe-next";

export async function generateMetadata() {
  const t = await getTranslations("catalogue.converter");
  return { title: t("title") };
}

/** The unit calculator (D5.1): exact conversions with material and supplier factors. */
export default async function ConvertPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const materialId = typeof raw.materialId === "string" ? raw.materialId : undefined;
  const path = "/catalogue/convert";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [units, materials, suppliers] = await Promise.all([
    serverApi("/units", unitsResponseSchema),
    materialPicker(materialId),
    supplierPicker(),
  ]);
  if (!units.ok) {
    if (units.status === 401) redirect(signInHref(path));
    if (units.status === 403) return <LiveForbidden />;
    return <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("catalogue.converter");
  const tCatalogue = await getTranslations("catalogue");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{tCatalogue("live")}</StatusBadge>}
        title={t("title")}
        description={t("description")}
      />
      <CatalogueSubnav current="convert" />
      <Converter
        units={units.data.units}
        materials={materials}
        suppliers={suppliers}
        initialMaterialId={materialId}
      />
    </div>
  );
}
