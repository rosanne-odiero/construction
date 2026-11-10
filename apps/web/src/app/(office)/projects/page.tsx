import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, HardHat, MapPin, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/page-header";
import { PrototypeAction } from "@/components/prototype-action";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { formatDate, formatKES, formatPercent } from "@/lib/format";
import { projects, type ProjectHealth } from "@/mocks/projects";

export async function generateMetadata() {
  const t = await getTranslations("nav.items");
  return { title: t("projects") };
}

const healthTone: Record<ProjectHealth, Tone> = {
  on_track: "success",
  at_risk: "warning",
  behind: "danger",
};

export default async function ProjectsPage() {
  const t = await getTranslations("projects");
  const tHealth = await getTranslations("health");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <PrototypeAction variant="default" deliverable="D2.1">
            <Plus aria-hidden /> {t("newProject")}
          </PrototypeAction>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {projects.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-lg">
                    <Link href={`/projects/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </div>
                <StatusBadge tone={healthTone[p.health]}>{tHealth(p.health)}</StatusBadge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("progress")}</span>
                  <span className="font-medium tabular-nums">
                    {formatPercent(p.progress)}{" "}
                    <span className="text-muted-foreground">
                      ({t("planned", { pct: formatPercent(p.plannedProgress) })})
                    </span>
                  </span>
                </div>
                <Progress value={p.progress * 100} aria-label={t("progress")} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">{t("contractSum")}</dt>
                  <dd className="font-medium tabular-nums">{formatKES(p.revisedSumMinor)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t("client")}</dt>
                  <dd className="truncate font-medium">{p.client}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <MapPin className="size-4 text-muted-foreground" aria-hidden />
                  <dd>
                    {p.town}, {p.county}
                  </dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                  <dd className="tabular-nums">
                    {formatDate(p.startDate)} – {formatDate(p.endDate)}
                  </dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <HardHat className="size-4 text-muted-foreground" aria-hidden />
                  <dd>
                    {t("workersToday", { present: p.workersToday, total: p.workersRostered })}
                  </dd>
                </div>
              </dl>
            </CardContent>
            <CardFooter className="gap-2">
              <Button asChild size="sm">
                <Link href={`/projects/${p.id}`}>{t("open")}</Link>
              </Button>
              {p.id === "ruiru-heights" ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/projects/${p.id}/bq`}>{t("openBq")}</Link>
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link href="/portal">{t("openPortal")}</Link>
                </Button>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
