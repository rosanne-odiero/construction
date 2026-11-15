import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { DocumentReminder } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { complianceTypeLabel, reminderHref, reminderTone } from "@/lib/documents";
import { formatCalendarDate } from "@/lib/format";

/**
 * Expiring, expired and missing compliance items and overdue approval requests, computed by the
 * API on read in Nairobi business dates (decision D-116). Email/SMS delivery is D7.3.
 */
export async function ReminderList({
  reminders,
  showProject,
  emptyText,
}: {
  reminders: DocumentReminder[];
  showProject: boolean;
  emptyText: string;
}) {
  const t = await getTranslations("documents");
  if (!reminders.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  const label = (reminder: DocumentReminder) =>
    reminder.approval
      ? t("overview.overdueApproval", {
          code: reminder.approval.code,
          title: reminder.approval.title,
        })
      : reminder.type
        ? complianceTypeLabel(reminder.type, (key) => t(key as never))
        : "—";
  const when = (reminder: DocumentReminder) => {
    if (reminder.dueOn)
      return `${t("reminders.due", { date: formatCalendarDate(reminder.dueOn) })} · ${t(
        "common.overdueDays",
        { days: Math.abs(reminder.daysLeft ?? 0) },
      )}`;
    if (!reminder.expiresOn) return null;
    const days = reminder.daysLeft ?? 0;
    return days < 0
      ? `${t("reminders.expired", { date: formatCalendarDate(reminder.expiresOn) })} · ${t(
          "common.daysAgo",
          { days: -days },
        )}`
      : `${t("reminders.expires", { date: formatCalendarDate(reminder.expiresOn) })} · ${t(
          "common.daysLeft",
          { days },
        )}`;
  };
  return (
    <ul className="divide-y rounded-md border" data-testid="document-reminders">
      {reminders.map((reminder, index) => {
        const href = reminderHref(reminder);
        const text = label(reminder);
        return (
          <li
            key={`${reminder.kind}-${reminder.project?.id ?? "company"}-${reminder.type?.id ?? reminder.approval?.id ?? index}`}
            className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:gap-3"
          >
            <StatusBadge tone={reminderTone[reminder.kind]} className="w-fit">
              {t(`reminders.${reminder.kind}`)}
            </StatusBadge>
            <span className="min-w-0 flex-1">
              {href ? (
                <Link className="font-medium underline-offset-2 hover:underline" href={href}>
                  {text}
                </Link>
              ) : (
                <span className="font-medium">{text}</span>
              )}
              {showProject ? (
                <span className="text-muted-foreground">
                  {" · "}
                  {reminder.project ? (
                    <span className="font-mono">{reminder.project.code}</span>
                  ) : (
                    t("overview.company")
                  )}
                </span>
              ) : null}
            </span>
            {when(reminder) ? (
              <span className="text-muted-foreground tabular-nums">{when(reminder)}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
