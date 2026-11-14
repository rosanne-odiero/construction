import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { expenseResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { ReceiptUpload } from "@/components/spending/receipt-upload";
import { SentenceBadge } from "@/components/spending/sentence-badge";
import { SpendingAction } from "@/components/spending/spending-action";
import { SpendingEyebrow } from "@/components/spending/spending-subnav";
import { StatusBadge } from "@/components/status-badge";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession } from "@/lib/server-api";
import { expenseTone } from "@/lib/spending";
import { isUuid } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("spending.expense");
  return { title: t("metaTitle") };
}

/**
 * One petty-cash expense: what was spent, how it is tagged, its receipts and the independent
 * approval that posts it to the cost ledger (D5.4).
 */
export default async function ExpensePage({ params }: { params: Promise<{ expenseId: string }> }) {
  const { expenseId } = await params;
  if (!isUuid(expenseId)) notFound();
  const path = `/spending/petty-cash/expenses/${expenseId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/petty-cash/expenses/${expenseId}`,
    expenseResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("spending.expense");
  const tStatus = await getTranslations("spending.status");
  const tCategory = await getTranslations("spending.categories");
  const tSms = await getTranslations("spending.sms");
  const { expense, permissions } = result.data;
  const rows: [string, React.ReactNode][] = [
    [t("amount"), formatKES(expense.amountMinor)],
    [t("charge"), formatKES(expense.chargeMinor)],
    [t("total"), formatKES(expense.amountMinor + expense.chargeMinor)],
    [t("spentOn"), formatCalendarDate(expense.spentOn)],
    [
      t("payee"),
      [expense.payeeName, expense.payeeAccount, expense.payeePhoneMasked]
        .filter(Boolean)
        .join(" · "),
    ],
    [t("counterparty"), t(`counterparties.${expense.counterpartyKind}`)],
    [t("method"), expense.paymentMethod === "mpesa" ? t("mpesa") : t("cash")],
    [t("mpesaCode"), expense.mpesaCode ?? "—"],
    [t("category"), tCategory(expense.category)],
    [
      t("tag"),
      expense.bqItem
        ? `${expense.bqItem.ref ? `${expense.bqItem.ref} · ` : ""}${expense.bqItem.description}`
        : expense.costCode
          ? `${expense.costCode.code} · ${expense.costCode.name}`
          : "—",
    ],
    [t("float"), `${expense.float.name} · ${expense.project.code} · ${expense.site.name}`],
    [
      t("recordedBy"),
      t("byWhen", {
        name: expense.recordedBy.displayName,
        when: formatDateTime(expense.recordedAt),
      }),
    ],
  ];
  if (expense.decidedBy && expense.decidedAt)
    rows.push([
      t("decidedBy"),
      t("byWhen", { name: expense.decidedBy.displayName, when: formatDateTime(expense.decidedAt) }),
    ]);
  if (expense.decisionReason) rows.push([t("reason"), expense.decisionReason]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SpendingEyebrow
            trail={{ href: `/spending/petty-cash/${expense.float.id}`, label: expense.float.name }}
          />
        }
        title={t("title", { number: expense.number })}
        description={expense.description}
        actions={
          <>
            <StatusBadge tone={expenseTone[expense.status]}>
              {tStatus(`expense.${expense.status}`)}
            </StatusBadge>
            {permissions.canApprove ? (
              <SpendingAction
                path={`/petty-cash/expenses/${expense.id}/approve`}
                entity="expense"
                body={{ version: expense.version }}
                primary
                text={{
                  button: t("approve"),
                  title: t("approveTitle", { number: expense.number }),
                  description: t("approveDescription"),
                  confirm: t("approve"),
                }}
              />
            ) : null}
            {permissions.canReject ? (
              <SpendingAction
                path={`/petty-cash/expenses/${expense.id}/reject`}
                entity="expense"
                body={{ version: expense.version }}
                fields={[{ kind: "reason" }]}
                destructive
                text={{
                  button: t("reject"),
                  title: t("rejectTitle", { number: expense.number }),
                  description: t("rejectDescription"),
                  confirm: t("reject"),
                }}
              />
            ) : null}
          </>
        }
      />
      {expense.parsedFromSms && expense.smsKind ? (
        <SentenceBadge tone="info">
          {t("fromSms", { kind: tSms(`kinds.${expense.smsKind}`) })}
        </SentenceBadge>
      ) : null}
      {expense.status === "submitted" ? (
        <SentenceBadge tone="warning">{t("waiting")}</SentenceBadge>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 rounded-xl border p-4 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-2 border-b pb-1">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-right break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="receipts" className="space-y-3">
        <h2 id="receipts" className="text-lg font-semibold">
          {t("receiptsTitle")}
        </h2>
        {expense.receipts.length === 0 ? (
          <SentenceBadge tone="warning">{t("noReceipts")}</SentenceBadge>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {expense.receipts.map((receipt) => (
              <li key={receipt.id} className="space-y-1 text-xs">
                <a
                  href={`/api/v1/petty-cash/receipts/${receipt.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-lg border"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- private, same-origin evidence */}
                  <img
                    src={`/api/v1/petty-cash/receipts/${receipt.id}`}
                    alt={t("receiptAlt", { name: receipt.uploadedBy.displayName })}
                    className="aspect-square w-full object-cover"
                  />
                </a>
                <p>{formatDateTime(receipt.uploadedAt)}</p>
              </li>
            ))}
          </ul>
        )}
        {permissions.canAddReceipt ? <ReceiptUpload expenseId={expense.id} /> : null}
      </section>
    </div>
  );
}
