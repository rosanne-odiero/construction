import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatKES } from "@/lib/format";

const tokens = ["background", "primary", "muted", "success", "warning", "destructive"] as const;
const tokenStyles = {
  background: "bg-background",
  primary: "bg-primary",
  muted: "bg-muted",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export async function generateMetadata() {
  const t = await getTranslations("designSystem");
  return { title: t("title") };
}

export default async function DesignSystemPage() {
  const t = await getTranslations("designSystem");

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6">
      <a href="#main" className="sr-only focus:not-sr-only">
        {t("skip")}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="text-lg font-semibold">
          PM-Buddy
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="mt-2 text-muted-foreground">{t("description")}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("tokens")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {tokens.map((token) => (
              <div key={token} className="space-y-2">
                <div className={`h-16 rounded border ${tokenStyles[token]}`} aria-hidden />
                <p className="text-sm">{t(`palette.${token}`)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("controls")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link href="/foundation">{t("foundation")}</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/">{t("prototype")}</Link>
                </Button>
                <Button disabled>{t("disabled")}</Button>
              </div>
              <Field>
                <FieldLabel htmlFor="sample-name">{t("name")}</FieldLabel>
                <Input
                  id="sample-name"
                  aria-describedby="sample-name-hint"
                  placeholder={t("namePlaceholder")}
                />
                <FieldDescription id="sample-name-hint">{t("sampleHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="sample-error">{t("invalidField")}</FieldLabel>
                <Input id="sample-error" aria-invalid="true" aria-describedby="sample-error-hint" />
                <FieldDescription id="sample-error-hint" className="text-destructive">
                  {t("errorHint")}
                </FieldDescription>
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("formats")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <div>
                  <dt className="text-sm text-muted-foreground">{t("money")}</dt>
                  <dd className="font-mono">{formatKES(125_000_000)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{t("date")}</dt>
                  <dd className="font-mono">{formatDateTime("2026-11-10T09:00:00Z")}</dd>
                </div>
              </dl>
              <p className="mt-4 text-sm text-muted-foreground">{t("precision")}</p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("states")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone="neutral">{t("pending")}</StatusBadge>
              <StatusBadge tone="info">{t("syncing")}</StatusBadge>
              <StatusBadge tone="success">{t("confirmed")}</StatusBadge>
              <StatusBadge tone="warning">{t("conflicted")}</StatusBadge>
              <StatusBadge tone="danger">{t("failed")}</StatusBadge>
            </div>
            <p className="text-sm">{t("unknownPayment")}</p>
            <div className="rounded border border-dashed p-4 text-sm">{t("empty")}</div>
            <div className="rounded border p-4 text-sm">{t("offline")}</div>
            <div aria-label={t("loading")} className="space-y-2">
              <span className="text-sm">{t("loading")}</span>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </CardContent>
        </Card>
        <p className="text-sm text-muted-foreground">{t("limitations")}</p>
      </main>
    </div>
  );
}
