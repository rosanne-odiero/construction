import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { getTranslations } from "next-intl/server";

export async function PrototypeBanner() {
  const t = await getTranslations("prototype");
  return (
    <div className="bg-primary text-primary-foreground">
      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-1.5 text-center text-xs">
        <FlaskConical className="size-3.5 shrink-0" aria-hidden />
        <span>{t("banner")}</span>
        <Link href="/" className="font-semibold underline underline-offset-2">
          {t("tourLink")}
        </Link>
      </p>
    </div>
  );
}
