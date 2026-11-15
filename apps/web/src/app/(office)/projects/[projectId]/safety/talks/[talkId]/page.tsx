import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nairobiDate } from "@pm-buddy/domain";
import {
  safetyOptionsResponseSchema,
  sitesResponseSchema,
  toolboxTalkResponseSchema,
} from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveUnavailable } from "@/components/projects/live-state";
import { CancelTalkButton, TalkForm, TalkRecord } from "@/components/safety/talks";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate } from "@/lib/format";
import { calendarInput } from "@/lib/project-input";
import { talkStatusTone } from "@/lib/safety";
import { serverApi } from "@/lib/server-api";
import { loadSafetyPage, SafetyEyebrow, UUID } from "../../page-shell";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; talkId: string }>;
}) {
  const { projectId, talkId } = await params;
  const t = await getTranslations("safety");
  if (!UUID.test(projectId) || !UUID.test(talkId)) return { title: t("talks.title") };
  const detail = await serverApi(
    `/projects/${projectId}/safety/talks/${talkId}`,
    toolboxTalkResponseSchema,
  );
  return {
    title: detail.ok ? `${detail.data.talk.code} ${detail.data.talk.topic}` : t("talks.title"),
  };
}

/** A toolbox talk: a draft is edited and confirmed; a confirmed talk is read-only (D8.2). */
export default async function TalkPage({
  params,
}: {
  params: Promise<{ projectId: string; talkId: string }>;
}) {
  const { projectId, talkId } = await params;
  if (!UUID.test(projectId) || !UUID.test(talkId)) notFound();
  const path = `/projects/${projectId}/safety/talks/${talkId}`;
  const page = await loadSafetyPage(path, projectId, path, toolboxTalkResponseSchema);
  if (!page.ok) return page.element;
  const [options, sites] = await Promise.all([
    serverApi(`/projects/${projectId}/safety/options`, safetyOptionsResponseSchema),
    serverApi(`/projects/${projectId}/sites`, sitesResponseSchema),
  ]);
  if (!options.ok || !sites.ok) return <LiveUnavailable retryHref={path} />;
  const t = await getTranslations("safety");
  const { talk } = page.data;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SafetyEyebrow
            projectId={projectId}
            code={page.project.project.code}
            view="talks"
            current={talk.code}
          />
        }
        title={talk.topic}
        description={`${formatCalendarDate(talk.heldOn)} · ${talk.siteName} · ${t("talks.presentedBy", { name: talk.presenter.displayName })}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={talkStatusTone[talk.status]} className="h-auto whitespace-normal">
              {t(`talkStatus.${talk.status}`)}
            </StatusBadge>
            <CancelTalkButton projectId={projectId} talk={talk} />
          </span>
        }
      />
      {talk.permissions.canEdit ? (
        <TalkForm
          key={talk.version}
          projectId={projectId}
          sites={sites.data.sites}
          options={options.data}
          today={calendarInput(nairobiDate())}
          userId={page.session.user.id}
          talk={talk}
        />
      ) : (
        <TalkRecord projectId={projectId} talk={talk} staff={options.data.staff} />
      )}
    </div>
  );
}
