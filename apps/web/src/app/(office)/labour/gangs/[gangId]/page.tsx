import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import {
  gangDetailResponseSchema,
  labourersResponseSchema,
  sitesResponseSchema,
  type GangMember,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AddMemberButton, EditGangButton, MemberActions } from "@/components/labour/gang-actions";
import { LabourNav } from "@/components/labour/labour-nav";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/format";
import { loadLive, requireSession, serverApi } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("labourLive.gangs");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function GangPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  if (!UUID.test(gangId)) notFound();
  const path = `/labour/gangs/${gangId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadLive(`/labour/gangs/${gangId}`, gangDetailResponseSchema, path);
  if (!result.ok)
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  const { gang, members, canManage } = result.data;
  const t = await getTranslations("labourLive");
  const current = members.filter((member) => member.current);
  const past = members.filter((member) => !member.current);
  let candidates: { id: string; label: string }[] = [];
  let sites: { id: string; label: string }[] = [];
  if (canManage) {
    const engaged = await serverApi(
      `/labour/labourers?projectId=${gang.projectId}&status=active&limit=500`,
      labourersResponseSchema,
    );
    const inGang = new Set(current.map((member) => member.labourerId));
    if (engaged.ok)
      candidates = engaged.data.labourers
        .filter((labourer) => !inGang.has(labourer.id))
        .map((labourer) => ({
          id: labourer.id,
          label: `${labourer.workerNo} · ${labourer.fullName}${labourer.gang ? ` (${labourer.gang.name})` : ""}`,
        }));
    const siteList = await serverApi(`/projects/${gang.projectId}/sites`, sitesResponseSchema);
    if (siteList.ok) sites = siteList.data.sites.map((site) => ({ id: site.id, label: site.name }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<StatusBadge tone="info">{t("live")}</StatusBadge>}
        title={gang.name}
        description={t("gangs.detailDescription", {
          project: `${gang.projectCode} · ${gang.projectName}`,
          site: gang.siteName ?? t("gangs.noSite"),
        })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/labour/gangs">
                <ArrowLeft aria-hidden /> {t("gangs.back")}
              </Link>
            </Button>
            {canManage ? <EditGangButton key={gang.version} gang={gang} sites={sites} /> : null}
          </div>
        }
      />
      <LabourNav current="gangs" />
      <dl className="grid max-w-xl grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("gangs.columns.status")}</dt>
        <dd>
          <StatusBadge tone={gang.status === "active" ? "success" : "neutral"}>
            {t(`gangs.status.${gang.status}`)}
          </StatusBadge>
        </dd>
        <dt className="text-muted-foreground">{t("gangs.columns.leader")}</dt>
        <dd>
          {gang.leader ? `${gang.leader.fullName} (${gang.leader.workerNo})` : t("gangs.noLeader")}
        </dd>
        <dt className="text-muted-foreground">{t("gangs.columns.members")}</dt>
        <dd className="tabular-nums">{gang.memberCount}</dd>
      </dl>

      <section aria-labelledby="gang-members" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="gang-members" className="text-base font-semibold">
            {t("gangs.current")}
          </h2>
          {canManage && gang.status === "active" ? (
            <AddMemberButton gangId={gang.id} candidates={candidates} />
          ) : null}
        </div>
        <MembersTable
          caption={t("gangs.current")}
          members={current}
          labels={{
            worker: t("gangs.worker"),
            joined: t("gangs.joinedOn"),
            left: t("gangs.leftOn"),
            actions: t("gangs.actions"),
            leader: t("gangs.leader"),
            empty: t("gangs.noMembers"),
          }}
          leaderId={gang.leader?.labourerId ?? null}
          actions={
            canManage ? (member) => <MemberActions gang={gang} member={member} /> : undefined
          }
        />
      </section>
      {past.length ? (
        <section aria-labelledby="gang-history" className="space-y-3">
          <h2 id="gang-history" className="text-base font-semibold">
            {t("gangs.history")}
          </h2>
          <MembersTable
            caption={t("gangs.history")}
            members={past}
            labels={{
              worker: t("gangs.worker"),
              joined: t("gangs.joinedOn"),
              left: t("gangs.leftOn"),
              actions: t("gangs.actions"),
              leader: t("gangs.leader"),
              empty: t("gangs.noMembers"),
            }}
            leaderId={null}
          />
        </section>
      ) : null}
    </div>
  );
}

type Member = GangMember;

function MembersTable({
  caption,
  members,
  labels,
  leaderId,
  actions,
}: {
  caption: string;
  members: Member[];
  labels: Record<"worker" | "joined" | "left" | "actions" | "leader" | "empty", string>;
  leaderId: string | null;
  actions?: (member: Member) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead>{labels.worker}</TableHead>
            <TableHead>{labels.joined}</TableHead>
            <TableHead>{labels.left}</TableHead>
            {actions ? <TableHead className="text-right">{labels.actions}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.membershipId}>
              <TableCell>
                <Link
                  href={`/labour?worker=${member.labourerId}`}
                  className="font-medium hover:underline"
                >
                  {member.fullName}
                </Link>
                <span className="block font-mono text-xs text-muted-foreground">
                  {member.workerNo}
                </span>
                {member.labourerId === leaderId ? (
                  <StatusBadge tone="info" className="mt-1">
                    {labels.leader}
                  </StatusBadge>
                ) : null}
              </TableCell>
              <TableCell className="tabular-nums">{formatCalendarDate(member.joinedOn)}</TableCell>
              <TableCell className="tabular-nums">
                {member.leftOn ? formatCalendarDate(member.leftOn) : "—"}
              </TableCell>
              {actions ? <TableCell className="text-right">{actions(member)}</TableCell> : null}
            </TableRow>
          ))}
          {members.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={actions ? 4 : 3}
                className="py-6 text-center text-sm text-muted-foreground"
              >
                {labels.empty}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
