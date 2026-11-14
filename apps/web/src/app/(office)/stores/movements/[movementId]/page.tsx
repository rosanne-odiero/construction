import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Undo2 } from "lucide-react";
import type { StandardUnitCode } from "@pm-buddy/types";
import { movementResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { StoresAction } from "@/components/stores/stores-action";
import { ScrollTable, StoresEyebrow } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatDateTime, formatKES } from "@/lib/format";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { formatMinorDecimal, unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";
import { formatStock, isUuid, movementKindTone, movementTone } from "@/lib/stores";

export async function generateMetadata() {
  const t = await getTranslations("stores.movement");
  return { title: t("metaTitle") };
}

/** An issue, return or wastage record with its lines, values, returns and reversal (D5.3). */
export default async function MovementPage({
  params,
}: {
  params: Promise<{ movementId: string }>;
}) {
  const { movementId } = await params;
  if (!isUuid(movementId)) notFound();
  const path = `/stores/movements/${movementId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(`/stock-movements/${movementId}`, movementResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("stores.movement");
  const tCommon = await getTranslations("stores.common");
  const tStatus = await getTranslations("stores.status");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { movement, permissions } = result.data;
  const isIssue = movement.kind === "issue";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <StoresEyebrow
            trail={{ href: `/stores/${movement.store.id}`, label: movement.store.name }}
          />
        }
        title={t("title", {
          kind: tStatus(`movementKind.${movement.kind}`),
          number: movement.number,
        })}
        description={t("description", {
          when: formatDateTime(movement.recordedAt),
          who: movement.recordedBy.displayName,
          date: formatCalendarDate(movement.businessDate),
        })}
        actions={
          <>
            {permissions.canReturn ? (
              <Button asChild>
                <Link href={`/stores/movements/${movement.id}/return`}>
                  <Undo2 aria-hidden /> {t("recordReturn")}
                </Link>
              </Button>
            ) : null}
            {permissions.canReverse ? (
              <StoresAction
                path={`/stock-movements/${movement.id}/reverse`}
                entity="movement"
                reason
                destructive
                text={{
                  button: t("reverse.button"),
                  title: t("reverse.title", { number: movement.number }),
                  description: t("reverse.description"),
                  confirm: t("reverse.confirm"),
                }}
              />
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <StatusBadge tone={movementKindTone[movement.kind]}>
          {tStatus(`movementKind.${movement.kind}`)}
        </StatusBadge>
        <StatusBadge tone={movementTone[movement.status]}>
          {tStatus(`movement.${movement.status}`)}
        </StatusBadge>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {movement.bqItem ? (
          <div>
            <dt className="text-muted-foreground">{t("bqItem")}</dt>
            <dd>
              {movement.bqItem.ref ? `${movement.bqItem.ref} · ` : ""}
              {movement.bqItem.description}
            </dd>
          </div>
        ) : null}
        {movement.gang ? (
          <div>
            <dt className="text-muted-foreground">{t("gang")}</dt>
            <dd>{movement.gang.name}</dd>
          </div>
        ) : null}
        {movement.issuedToName ? (
          <div>
            <dt className="text-muted-foreground">{t("issuedTo")}</dt>
            <dd>{movement.issuedToName}</dd>
          </div>
        ) : null}
        {movement.returnOf ? (
          <div>
            <dt className="text-muted-foreground">{t("returnOf")}</dt>
            <dd>
              <Link
                href={`/stores/movements/${movement.returnOf.id}`}
                className="font-mono underline underline-offset-4"
              >
                {movement.returnOf.number}
              </Link>
            </dd>
          </div>
        ) : null}
        {movement.wastageReason ? (
          <div>
            <dt className="text-muted-foreground">{t("reason")}</dt>
            <dd>{tStatus(`wastageReason.${movement.wastageReason}`)}</dd>
          </div>
        ) : null}
        {movement.notes ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t("notes")}</dt>
            <dd className="whitespace-pre-line">{movement.notes}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted-foreground">{t("captured")}</dt>
          <dd>
            {t("capturedValue", {
              device: formatDateTime(movement.capturedAt),
              server: formatDateTime(movement.recordedAt),
            })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("total")}</dt>
          <dd>{formatKES(movement.totalValueMinor)}</dd>
        </div>
      </dl>
      {movement.status === "reversed" ? (
        <p className="rounded-xl border p-4 text-sm" role="status">
          {t("reversedNote", {
            who: movement.reversedBy?.displayName ?? "—",
            when: movement.reversedAt ? formatDateTime(movement.reversedAt) : "—",
            reason: movement.reversalReason ?? "",
          })}
        </p>
      ) : null}
      <ScrollTable label={t("lines")} minWidth={isIssue ? 720 : 560}>
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pl-4 font-medium">
              {tCommon("material")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.quantity")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.unitCost")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {t("cols.value")}
            </th>
            {isIssue ? (
              <>
                <th scope="col" className="py-2 pr-2 text-right font-medium">
                  {t("cols.returned")}
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  {t("cols.returnable")}
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {movement.lines.map((line) => (
            <tr key={line.id} className="border-b last:border-0">
              <th scope="row" className="py-2 pl-4 text-left font-medium">
                {line.material.name}
              </th>
              <td className="py-2 pr-2 text-right tabular-nums">
                {formatStock(line.baseQuantity)} {label(line.material.baseUnit)}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {formatMinorDecimal(line.unitCostMinor)}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">
                {formatMinorDecimal(line.valueMinor)}
              </td>
              {isIssue ? (
                <>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatStock(line.returnedBaseQuantity ?? "0")}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatStock(line.returnableBaseQuantity ?? "0")}
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      {movement.returns.length ? (
        <section aria-labelledby="returns" className="space-y-2">
          <h2 id="returns" className="text-lg font-semibold">
            {t("returns")}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {movement.returns.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/stores/movements/${entry.id}`}
                  className="font-mono underline underline-offset-4"
                >
                  {entry.number}
                </Link>{" "}
                <StatusBadge tone={entry.status === "posted" ? "success" : "neutral"}>
                  {tStatus(`movement.${entry.status === "posted" ? "posted" : "reversed"}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
