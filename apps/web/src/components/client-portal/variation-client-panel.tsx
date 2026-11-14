import { getTranslations } from "next-intl/server";
import { variationClientResponseSchema } from "@pm-buddy/validation";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requestTone } from "@/lib/client-portal";
import { formatDateTime } from "@/lib/format";
import { serverApi } from "@/lib/server-api";
import { SendToClient } from "./staff-forms";

/**
 * The client's side of a variation for staff (D7.1): whether the project waits for the client,
 * every sending with the client's decision and comment, and "send to the client" for the current
 * submission (bq.edit).
 */
export async function VariationClientPanel({
  projectId,
  variation,
}: {
  projectId: string;
  variation: { id: string; version: number; snapshot: { digest: string } | null };
}) {
  const result = await serverApi(
    `/projects/${projectId}/bq/variations/${variation.id}/client`,
    variationClientResponseSchema,
  );
  if (!result.ok) return null;
  const t = await getTranslations("variationClient");
  const tStates = await getTranslations("clientPortal.variations.states");
  const view = result.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {view.approvalRequired ? t("required") : t("notRequired")}{" "}
          {t("members", { count: view.clientMembers })}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {view.requests.length ? (
          <ul className="space-y-3">
            {view.requests.map((request) => (
              <li key={request.id} className="space-y-1 rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {t("sent", {
                      name: request.sentBy.displayName,
                      date: formatDateTime(request.sentAt),
                    })}
                  </span>
                  <StatusBadge tone={requestTone[request.state]}>
                    {tStates(request.state)}
                  </StatusBadge>
                </div>
                {request.message ? (
                  <p className="text-muted-foreground whitespace-pre-wrap">{request.message}</p>
                ) : null}
                {request.decision ? (
                  <p>
                    {t("decided", {
                      name: request.decision.decidedBy.displayName,
                      date: formatDateTime(request.decision.decidedAt),
                    })}
                    {request.decision.comment ? (
                      <span className="block whitespace-pre-wrap text-muted-foreground">
                        {request.decision.comment}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {t("digest", { digest: request.clientDigest.slice(0, 16) })}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t("none")}</p>
        )}
        {view.permissions.canSend && variation.snapshot ? (
          <SendToClient
            projectId={projectId}
            variationId={variation.id}
            version={variation.version}
            snapshotDigest={variation.snapshot.digest}
          />
        ) : view.permissions.sendBlocker && view.permissions.sendBlocker !== "permission" ? (
          <p className="text-muted-foreground">{t(`blockers.${view.permissions.sendBlocker}`)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
