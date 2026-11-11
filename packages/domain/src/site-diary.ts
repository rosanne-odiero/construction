export const DIARY_STATUSES = ["draft", "submitted", "rejected", "approved"] as const;
export type DiaryStatus = (typeof DIARY_STATUSES)[number];
export const DIARY_ACTIONS = ["submit", "approve", "reject", "reopen"] as const;
export type DiaryAction = (typeof DIARY_ACTIONS)[number];

export function diaryTransition(status: DiaryStatus, action: DiaryAction): DiaryStatus | null {
  if (status === "draft" && action === "submit") return "submitted";
  if (status === "submitted" && action === "approve") return "approved";
  if (status === "submitted" && action === "reject") return "rejected";
  if (status === "rejected" && action === "reopen") return "draft";
  return null;
}
