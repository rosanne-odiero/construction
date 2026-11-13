import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { StandardUnitCode } from "@pm-buddy/types";
import { grnResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { GrnPhotoUpload } from "@/components/procurement/p2p/grn-photo-upload";
import { P2pEyebrow } from "@/components/procurement/p2p/p2p-subnav";
import { RecordActions } from "@/components/procurement/p2p/record-actions";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatQuantity, grnTone, isUuid, locationTone } from "@/lib/p2p";
import { loadOrRedirect, unitOptions } from "@/lib/p2p-server";
import { unitLabel } from "@/lib/procurement";
import { requireSession } from "@/lib/server-api";

export async function generateMetadata() {
  const t = await getTranslations("p2p.grns");
  return { title: t("title") };
}

/**
 * A Goods Received Note (D5.2): what was counted and accepted, the device's capture time against
 * the server's receipt time, the position check, the vehicle, photos and voiding.
 */
export default async function GrnPage({ params }: { params: Promise<{ grnId: string }> }) {
  const { grnId } = await params;
  if (!isUuid(grnId)) notFound();
  const path = `/procurement/grns/${grnId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const [result, units] = await Promise.all([
    loadOrRedirect(path, grnResponseSchema, path),
    unitOptions(),
  ]);
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const { grn, permissions } = result.data;
  const t = await getTranslations("p2p.grns");
  const tStatus = await getTranslations("p2p.status");
  const tCommon = await getTranslations("p2p.common");
  const tUnits = await getTranslations("catalogue.units");
  const label = (code: string) => unitLabel(code, (unit: StandardUnitCode) => tUnits(unit), units);
  const { location } = grn;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<P2pEyebrow trail={{ href: "/procurement/grns", label: t("title") }} />}
        title={grn.number}
        description={`${grn.project.code} · ${grn.supplier.name} · ${grn.site?.name ?? tCommon("noSite")}`}
        actions={
          <>
            <StatusBadge tone={grnTone[grn.status]}>{tStatus(`grn.${grn.status}`)}</StatusBadge>
            {permissions.canVoid ? (
              <RecordActions
                entity="grn"
                basePath={path}
                number={grn.number}
                version={1}
                actions={[
                  {
                    action: "void",
                    unversioned: true,
                    reason: true,
                    destructive: true,
                    text: {
                      button: t("detail.void"),
                      title: t("detail.voidTitle", { number: grn.number }),
                      description: t("detail.voidDescription"),
                      confirm: t("detail.voidConfirm"),
                    },
                  },
                ]}
              />
            ) : null}
          </>
        }
      />
      {grn.voidedAt && grn.voidedBy ? (
        <p className="rounded-lg border p-3 text-sm" role="note">
          {t("detail.voided", {
            name: grn.voidedBy.displayName,
            date: formatDate(grn.voidedAt),
            reason: grn.voidReason ?? "",
          })}
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("cols.lpo")}</dt>
          <dd>
            <Link href={`/procurement/lpos/${grn.lpo.id}`} className="underline">
              {grn.lpo.number}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.captured")}</dt>
          <dd>{formatDateTime(grn.capturedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.receivedAt")}</dt>
          <dd>{formatDateTime(grn.receivedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.receivedBy")}</dt>
          <dd>{grn.receivedByName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.recordedBy")}</dt>
          <dd>
            {grn.recordedBy.displayName} · {tStatus(`source.${grn.source}`)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.vehicle")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{grn.vehicleRegistration}</span>
            <StatusBadge tone={grn.vehicleRegistrationFormat === "kenyan" ? "neutral" : "warning"}>
              {tStatus(`vehicle.${grn.vehicleRegistrationFormat}`)}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("detail.deliveryNote")}</dt>
          <dd>{grn.deliveryNoteNumber ?? t("detail.none")}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t("detail.location")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={locationTone[location.state]}>
              {tStatus(`location.${location.state}`)}
            </StatusBadge>
            {location.latitude !== null && location.longitude !== null ? (
              <span className="tabular-nums">
                {location.latitude}, {location.longitude}
                {location.accuracyM !== null
                  ? ` · ${t("detail.accuracy", { accuracy: location.accuracyM })}`
                  : ""}
              </span>
            ) : null}
            {location.lowAccuracy ? (
              <StatusBadge tone="warning">{t("detail.lowAccuracy")}</StatusBadge>
            ) : null}
            {location.error ? <span>{tStatus(`locationError.${location.error}`)}</span> : null}
            {location.geofenceVersion !== null ? (
              <span className="text-muted-foreground">
                {t("detail.geofenceVersion", { version: location.geofenceVersion })}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {grn.notes ? <p className="text-sm whitespace-pre-line">{grn.notes}</p> : null}

      <section aria-labelledby="grn-lines" className="space-y-2">
        <h2 id="grn-lines" className="text-base font-semibold">
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
                  {t("detail.received")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("detail.rejected")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t("detail.accepted")}
                </th>
              </tr>
            </thead>
            <tbody>
              {grn.lines.map((line) => (
                <tr key={line.id} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pl-4 text-left font-medium">
                    {line.material.name}
                    {line.overDelivery ? (
                      <StatusBadge tone="warning" className="ml-2">
                        {t("overDelivery")}
                      </StatusBadge>
                    ) : null}
                  </th>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatQuantity(line.receivedQuantity)} {label(line.unit)}
                  </td>
                  <td className="py-2 pr-2 tabular-nums">
                    {formatQuantity(line.rejectedQuantity)} {label(line.unit)}
                    {line.rejectionReason ? (
                      <span className="block text-xs text-muted-foreground">
                        {line.rejectionReason}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {formatQuantity(line.acceptedBaseQuantity)} {label(line.material.baseUnit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="grn-photos" className="space-y-3">
        <h2 id="grn-photos" className="flex flex-wrap items-center gap-2 text-base font-semibold">
          {t("detail.photos")}
          <StatusBadge tone={grn.evidenceComplete ? "success" : "warning"}>
            {grn.evidenceComplete ? t("detail.evidenceComplete") : t("detail.evidenceIncomplete")}
          </StatusBadge>
        </h2>
        {grn.photos.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {grn.photos.map((photo) => {
              const kind = t(`detail.kinds.${photo.kind as "delivery_note" | "goods"}`);
              return (
                <li key={photo.id} className="space-y-1 text-xs">
                  <a
                    href={`/api/v1/procurement/documents/${photo.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block overflow-hidden rounded-lg border"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- private, same-origin evidence */}
                    <img
                      src={`/api/v1/procurement/documents/${photo.id}`}
                      alt={t("detail.photoAlt", { kind, name: photo.uploadedBy.displayName })}
                      className="aspect-square w-full object-cover"
                    />
                  </a>
                  <p>
                    {kind} · {formatDateTime(photo.uploadedAt)}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("detail.noPhotos")}</p>
        )}
        {permissions.canAddPhotos ? <GrnPhotoUpload grnId={grn.id} /> : null}
      </section>
    </div>
  );
}
