import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";

export async function PayrollShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("payrollLive");
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={t("description")} />
      <nav aria-label={t("title")} className="flex flex-wrap gap-4 text-sm">
        {(["overview", "rules", "advances", "exports", "settings"] as const).map((key) => (
          <Link
            className="underline underline-offset-4"
            key={key}
            href={key === "overview" ? "/payroll" : `/payroll/${key}`}
          >
            {t(key)}
          </Link>
        ))}
      </nav>
      <p role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
        {t("compliance")}
      </p>
      {children}
    </div>
  );
}
