import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { journalResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { SpendingAction } from "@/components/spending/spending-action";
import { SpendingEyebrow } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { journalTone } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.journal");
  return { title: t("metaTitle") };
}

/** One cost journal: its lines and the second person's decision (D5.4). */
export default async function JournalPage({ params }: { params: Promise<{ journalId: string }> }) {
  const { journalId } = await params;
  if (!isUuid(journalId)) notFound();
  const path = `/spending/journals/${journalId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(`/cost-journals/${journalId}`, journalResponseSchema, path);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.journal");
  const tStatus = await getTranslations("spending.status");
  const tCategory = await getTranslations("spending.categories");
  const tMeasure = await getTranslations("spending.measures");
  const tKinds = await getTranslations("spending.journals.kinds");
  const { journal, permissions } = result.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<SpendingEyebrow trail={{ href: "/spending/journals", label: t("back") }} />}
        title={t("title", { number: journal.number, kind: tKinds(journal.kind) })}
        description={journal.reason}
        actions={
          <>
            <StatusBadge tone={journalTone[journal.status]}>
              {tStatus(`journal.${journal.status}`)}
            </StatusBadge>
            {permissions.canApprove ? (
              <SpendingAction
                path={`/cost-journals/${journal.id}/approve`}
                entity="journal"
                body={{ version: journal.version }}
                primary
                text={{
                  button: t("approve"),
                  title: t("approveTitle", { number: journal.number }),
                  description: t("approveDescription"),
                  confirm: t("approve"),
                }}
              />
            ) : null}
            {permissions.canReject ? (
              <SpendingAction
                path={`/cost-journals/${journal.id}/reject`}
                entity="journal"
                body={{ version: journal.version }}
                fields={[{ kind: "reason" }]}
                destructive
                text={{
                  button: t("reject"),
                  title: t("rejectTitle", { number: journal.number }),
                  description: t("rejectDescription"),
                  confirm: t("reject"),
                }}
              />
            ) : null}
          </>
        }
      />
      <p className="text-sm text-muted-foreground">
        {t("proposedBy", {
          name: journal.createdBy.displayName,
          when: formatDateTime(journal.createdAt),
        })}
        {journal.decidedBy && journal.decidedAt
          ? ` · ${t("decidedBy", { name: journal.decidedBy.displayName, when: formatDateTime(journal.decidedAt) })}`
          : ""}
      </p>
      {journal.decisionReason ? (
        <SentenceBadge tone="warning">{journal.decisionReason}</SentenceBadge>
      ) : null}
      {journal.status === "submitted" ? (
        <SentenceBadge tone="info">{t("waiting")}</SentenceBadge>
      ) : null}
      <ScrollTable label={t("linesTitle")} minWidth={760}>
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pl-4 font-medium">
              {t("cols.line")}
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">
              {t("cols.tags")}
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">
              {t("cols.counterparty")}
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              {t("cols.amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {journal.lines.map((line) => (
            <tr key={line.id} className="border-b align-top last:border-0">
              <td className="py-2 pl-4">
                {line.lineNo} · {tMeasure(line.measure)}
                <span className="block text-xs text-muted-foreground">
                  {formatCalendarDate(line.occurredOn)}
                </span>
              </td>
              <td className="py-2 pr-2">
                {tCategory(line.category)}
                <span className="block text-xs text-muted-foreground">
                  {line.bqItem
                    ? `${line.bqItem.ref ? `${line.bqItem.ref} · ` : ""}${line.bqItem.description}`
                    : line.costCode
                      ? `${line.costCode.code} · ${line.costCode.name}`
                      : t("heldInStores")}
                  {line.site ? ` · ${line.site.name}` : ""}
                </span>
              </td>
              <td className="py-2 pr-2">
                {line.supplier?.name ?? line.counterpartyName ?? "—"}
                {line.paymentReference ? (
                  <span className="block font-mono text-xs text-muted-foreground">
                    {line.paymentReference}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatKES(line.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
    </div>
  );
}
