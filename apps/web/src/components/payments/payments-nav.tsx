import Link from "next/link";
import { getTranslations } from "next-intl/server";

export type PaymentsNavKey =
  | "overview"
  | "requests"
  | "callbacks"
  | "cases"
  | "reconciliation"
  | "statements"
  | "tariffs"
  | "settings"
  | "new";

/** The payments area's own navigation (D4.2 console, D4.3 reconciliation and tariffs). */
export async function PaymentsNav({
  current,
  canTest,
}: {
  current: PaymentsNavKey | string;
  canTest: boolean;
}) {
  const t = await getTranslations("payments");
  const keys: PaymentsNavKey[] = [
    "overview",
    "requests",
    "callbacks",
    "cases",
    "reconciliation",
    "statements",
    "tariffs",
    "settings",
    ...(canTest ? (["new"] as const) : []),
  ];
  return (
    <nav aria-label={t("navigation")} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {keys.map((key) => (
        <Link
          key={key}
          href={
            key === "overview"
              ? "/payments"
              : key === "reconciliation"
                ? "/payments/reconciliation"
                : `/payments/${key}`
          }
          aria-current={current === key ? "page" : undefined}
          className="underline underline-offset-4 aria-[current=page]:font-semibold"
        >
          {t(`nav.${key}`)}
        </Link>
      ))}
    </nav>
  );
}
