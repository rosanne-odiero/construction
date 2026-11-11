import { getTranslations } from "next-intl/server";
import { Info } from "lucide-react";

/** Brief §15 G: conversions and densities are assumptions, and a lorry trip is not a unit. */
export async function BuildupAssumptions() {
  const t = await getTranslations("rateBuildUps.assumptions");
  return (
    <aside
      aria-labelledby="buildup-assumptions-title"
      className="space-y-2 rounded-xl border border-info/30 bg-info/5 p-4 text-sm"
    >
      <h2 id="buildup-assumptions-title" className="flex items-center gap-2 font-semibold">
        <Info className="size-4 text-info" aria-hidden /> {t("title")}
      </h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>{t("units")}</li>
        <li>{t("density")}</li>
        <li>{t("lorry")}</li>
        <li>{t("estimates")}</li>
        <li>{t("versions")}</li>
      </ul>
    </aside>
  );
}
