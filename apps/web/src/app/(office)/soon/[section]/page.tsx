import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Construction } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { comingSoonSections, type ComingSoonSection } from "@/components/nav-config";

const isSection = (value: string): value is ComingSoonSection => value in comingSoonSections;

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isSection(section)) return {};
  const t = await getTranslations("soon");
  return { title: t(`sections.${section}.title`) };
}

export default async function ComingSoonPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!isSection(section)) notFound();
  const t = await getTranslations("soon");
  const phase = comingSoonSections[section];

  return (
    <Empty className="min-h-[60vh] border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Construction aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-lg">{t(`sections.${section}.title`)}</EmptyTitle>
        <EmptyDescription className="max-w-md">
          {t(`sections.${section}.description`)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground">
          {t("phase", { phase })}
        </p>
        <Button asChild variant="outline">
          <Link href="/dashboard">{t("back")}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
