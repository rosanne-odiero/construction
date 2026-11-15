import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FileSearch, Pencil } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { requisitionDetailResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { MakerChecker } from "@/components/procurement/p2p/maker-checker";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RecordActions, type RecordAction } from "@/components/procurement/p2p/record-actions";
import { Timeline } from "@/components/procurement/p2p/timeline";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/format";
import { formatQuantity, isUuid, requisitionTone } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.requisitions");
  return { title: t("title") };
}

/** A requisition: lines, history and the commands this caller may use (D5.2). */
export default async function RequisitionPage({
  params,
}: {
  params: Promise<{ requisitionId: string }>;
}) {
  const { requisitionId } = await params;
  if (!isUuid(requisitionId)) notFound();
  const path = `/procurement/requisitions/${requisitionId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(path, requisitionDetailResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { requisition, lines, contributors, permissions } = result.data;
  const t = await getTranslations("p2p.requisitions");
  const tCommon = await getTranslations("p2p.common");
  const tStatus = await getTranslations("p2p.status.requisition");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);

  const actions: RecordAction[] = [];
  if (requisition.status === "draft" && permissions.canEdit)
    actions.push({ action: "submit", primary: true });
  if (permissions.canDecide)
    actions.push({ action: "approve", primary: true }, { action: "reject", reason: true });
  if (permissions.canEdit && ["rejected", "submitted"].includes(requisition.status))
    actions.push({ action: "reopen" });
  if (permissions.canCancel) actions.push({ action: "cancel", reason: true, destructive: true });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/requisitions", label: t("title") }} />}
        title={requisition.number}
        description={`${requisition.project.code} · ${requisition.project.name} · ${
          requisition.site?.name ?? tCommon("noSite")
        } · ${t("detail.neededBy", { date: formatCalendarDate(requisition.neededBy) })}`}
        actions={
          <>
            <StatusBadge tone={requisitionTone[requisition.status]}>
              {tStatus(requisition.status)}
            </StatusBadge>
            {requisition.status === "draft" && permissions.canEdit ? (
              <Button asChild variant="outline">
                <Link href={`${path}/edit`}>
                  <Pencil aria-hidden /> {t("detail.edit")}
                </Link>
              </Button>
            ) : null}
            <RecordActions
              entity="requisition"
              basePath={path}
              number={requisition.number}
              version={requisition.version}
              actions={actions}
            />
            {permissions.canCreateRfq ? (
              <Button asChild>
                <Link
                  href={`/procurement/rfqs/new?project=${requisition.project.id}&requisition=${requisition.id}`}
                >
                  <FileSearch aria-hidden /> {t("detail.createRfq")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {requisition.status === "submitted" ? (
        <MakerChecker contributors={contributors} userId={session.user.id} pending />
      ) : null}
      {requisition.rejectionReason ? (
        <p className="rounded-lg border border-destructive/30 p-3 text-sm" role="note">
          {t("detail.events.rejected", { reason: requisition.rejectionReason })}
        </p>
      ) : null}
      {requisition.notes ? (
        <p className="text-sm whitespace-pre-line">
          <span className="font-medium">{tCommon("notes")}: </span>
          {requisition.notes}
        </p>
      ) : null}
      <section aria-labelledby="requisition-lines" className="space-y-2">
        <h2 id="requisition-lines" className="text-base font-semibold">
          {t("detail.lines")}
        </h2>
        <div
          role="region"
          tabIndex={0}
          aria-label={t("detail.lines")}
          className="relative overflow-x-auto rounded-xl border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pl-4 font-medium">
                  {tCommon("material")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {tCommon("quantity")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("detail.bqItem")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("detail.note")}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    <span className="font-mono text-xs text-muted-foreground">
                      {line.material.code}
                    </span>{" "}
                    {line.material.name}
                  </th>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatQuantity(line.quantity)} {label(line.unit)}
                    {line.unit !== line.material.baseUnit ? (
                      <span className="block text-xs text-muted-foreground">
                        = {formatQuantity(line.baseQuantity)} {label(line.material.baseUnit)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2">
                    {line.bqItem
                      ? `${line.bqItem.ref ? `${line.bqItem.ref} · ` : ""}${line.bqItem.description}`
                      : t("detail.noBq")}
                  </td>
                  <td className="py-2 pr-4">{line.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {requisition.rfq || requisition.lpo ? (
        <p className="flex flex-wrap gap-3 text-sm">
          {requisition.rfq ? (
            <Link href={`/procurement/rfqs/${requisition.rfq.id}`} className="underline">
              {t("detail.rfq")} {requisition.rfq.number}
            </Link>
          ) : null}
          {requisition.lpo ? (
            <Link href={`/procurement/lpos/${requisition.lpo.id}`} className="underline">
              {t("detail.lpo")} {requisition.lpo.number}
            </Link>
          ) : null}
        </p>
      ) : null}
      <Timeline
        events={[
          {
            label: t("detail.events.created"),
            at: requisition.createdAt,
            by: requisition.createdBy.displayName,
          },
          {
            label: t("detail.events.submitted"),
            at: requisition.submittedAt,
            by: requisition.submittedBy?.displayName,
          },
          {
            label:
              requisition.rejectionReason !== null
                ? t("detail.events.rejected", { reason: requisition.rejectionReason })
                : t("detail.events.approved"),
            at: requisition.decidedAt,
            by: requisition.decidedBy?.displayName,
          },
          {
            label: t("detail.events.cancelled", { reason: requisition.cancelReason ?? "" }),
            at: requisition.cancelledAt,
          },
        ]}
      />
    </div>
  );
}
