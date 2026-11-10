"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { setUserLocale } from "@/i18n/actions";

export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      spacing={0}
      value={locale}
      disabled={pending}
      aria-label={t("language")}
      className={className}
      onValueChange={(value) => {
        if (!value || value === locale) return;
        startTransition(async () => {
          await setUserLocale(value);
          router.refresh();
        });
      }}
    >
      <ToggleGroupItem value="en" aria-label="English" className="px-2.5 text-xs font-semibold">
        EN
      </ToggleGroupItem>
      <ToggleGroupItem value="sw" aria-label="Kiswahili" className="px-2.5 text-xs font-semibold">
        SW
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
