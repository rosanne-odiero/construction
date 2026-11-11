import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { gangsResponseSchema, labourSetupResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { CreateGangButton } from "@/components/labour/gang-actions";
import { LabourNav } from "@/components/labour/labour-nav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.gangs");
  return { title: t("title") };
}

export default async function GangsPage() {
  const path = "/labour/gangs";
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive("/labour/gangs", gangsResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const setup = await serverApi("/labour/setup", labourSetupResponseSchema);
  const t = await getTranslations("labourLive");
  const { gangs, manageableProjectIds } = result.data;
  const manageable = setup.ok
    ? setup.data.manageableProjects.filter((project) => manageableProjectIds.includes(project.id))
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={t("gangs.title")}
        description={t("gangs.description")}
        actions={manageable.length ? <CreateGangButton projects={manageable} /> : null}
      />
      <LabourNav current="gangs" />
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">{t("gangs.title")}</TableCaption>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("gangs.columns.name")}</TableHead>
              <TableHead>{t("gangs.columns.project")}</TableHead>
              <TableHead>{t("gangs.columns.leader")}</TableHead>
              <TableHead className="text-right">{t("gangs.columns.members")}</TableHead>
              <TableHead>{t("gangs.columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {gangs.map((gang) => (
              <TableRow key={gang.id}>
                <TableCell>
                  <Link href={`/labour/gangs/${gang.id}`} className="font-medium hover:underline">
                    {gang.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm">
                  <span className="font-mono text-xs">{gang.projectCode}</span> {gang.projectName}
                  {gang.siteName ? (
                    <span className="block text-xs text-muted-foreground">{gang.siteName}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm">
                  {gang.leader ? (
                    <>
                      {gang.leader.fullName}
                      <span className="block font-mono text-xs text-muted-foreground">
                        {gang.leader.workerNo}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t("gangs.noLeader")}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{gang.memberCount}</TableCell>
                <TableCell>
                  <StatusBadge tone={gang.status === "active" ? "success" : "neutral"}>
                    {t(`gangs.status.${gang.status}`)}
                  </StatusBadge>
                </TableCell>
              </TableRow>
            ))}
            {gangs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  {t("gangs.empty")}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
