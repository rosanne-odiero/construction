import { getTranslations } from "next-intl/server";
import { CloudUpload, HardHat, ShieldCheck, Wallet } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { safeNextPath } from "@/lib/safe-next";
import { SignInForm } from "./sign-in-form";

export async function generateMetadata() {
  const t = await getTranslations("signIn");
  return { title: t("title") };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("auth");
  const design = await getTranslations("designSystem");
  const { next } = await searchParams;
  const points = [
    { key: "mfa", icon: ShieldCheck },
    { key: "money", icon: Wallet },
    { key: "offline", icon: CloudUpload },
  ] as const;

  return (
    <div className="flex min-h-svh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only">
        {design("skip")}
      </a>
      <div className="grid flex-1 lg:grid-cols-2">
        <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-blue-700 via-blue-800 to-indigo-950 p-10 text-white lg:flex">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <span className="flex size-9 items-center justify-center rounded-lg bg-white/15">
              <HardHat className="size-5" aria-hidden />
            </span>
            PM-Buddy
          </div>
          <div className="space-y-8">
            <p className="max-w-md text-3xl leading-tight font-semibold text-balance">
              {t("tagline")}
            </p>
            <ul className="space-y-4">
              {points.map((point) => (
                <li key={point.key} className="flex items-start gap-3 text-blue-50">
                  <point.icon className="mt-0.5 size-5 shrink-0" aria-hidden />
                  <span>{t(`points.${point.key}`)}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-blue-200">{t("footer")}</p>
          <div
            className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full border-[48px] border-white/5"
            aria-hidden
          />
        </aside>
        <main id="main" className="flex flex-col">
          <div className="flex items-center justify-between gap-2 p-4 lg:justify-end">
            <span className="flex items-center gap-2 font-semibold lg:hidden">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <HardHat className="size-4" aria-hidden />
              </span>
              PM-Buddy
            </span>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-12">
            <h1 className="sr-only">{t("title")}</h1>
            <SignInForm next={safeNextPath(Array.isArray(next) ? next[0] : next)} />
          </div>
        </main>
      </div>
    </div>
  );
}
