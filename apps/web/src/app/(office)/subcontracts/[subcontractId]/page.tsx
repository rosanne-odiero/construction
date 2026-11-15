import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Download } from "lucide-react";
import { subcontractItemsResponseSchema, subcontractResponseSchema } from "@pm-buddy/validation";
import { PageHeader } from "@/components/page-header";
import { LiveForbidden, LiveUnavailable } from "@/components/projects/live-state";
import { StatusBadge } from "@/components/status-badge";
import { ScrollTable } from "@/components/stores/stores-subnav";
import { Button } from "@/components/ui/button";
import { SubcontractAction } from "@/components/subcontracts/subcontract-action";
import {
  AddLineForm,
  AdvancePayForm,
  AdvanceRequestForm,
  NewCertificateForm,
  RemoveLineButton,
  VariationForm,
} from "@/components/subcontracts/subcontract-forms";
import { SubcontractsEyebrow } from "@/components/subcontracts/subcontracts-nav";
import { formatCalendarDate, formatDecimalString, formatKES } from "@/lib/format";
import { loadOrRedirect } from "@/lib/p2p-server";
import { requireSession, serverApi } from "@/lib/server-api";
import { isUuid } from "@/lib/stores";
import {
  advanceStatusTone,
  certificateStatusTone,
  problemKey,
  subcontractStatusTone,
  variationStatusTone,
} from "@/lib/subcontracts";

export async function generateMetadata() {
  const t = await getTranslations("subcontracts.detail");
  return { title: t("metaTitle") };
}

/**
 * A subcontract (D6.3 part B): terms, lines on BQ items at its own rates (with the BQ quantity,
 * what other subcontracts let and what was measured), the approval workflow (submitted digest,
 * approval with step-up by someone who did not prepare it), append-only variations, advances
 * (maker-checked, paid outside PM-Buddy), certificates and the statement.
 */
export default async function SubcontractPage({
  params,
}: {
  params: Promise<{ subcontractId: string }>;
}) {
  const { subcontractId } = await params;
  if (!isUuid(subcontractId)) notFound();
  const path = `/subcontracts/${subcontractId}`;
  const session = await requireSession(path);
  if (!session) return <LiveUnavailable retryHref={path} />;
  const result = await loadOrRedirect(
    `/subcontracts/${subcontractId}`,
    subcontractResponseSchema,
    path,
  );
  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    return result.status === 403 ? <LiveForbidden /> : <LiveUnavailable retryHref={path} />;
  }
  const t = await getTranslations("subcontracts.detail");
  const tStatus = await getTranslations("subcontracts.status");
  const tKind = await getTranslations("subcontracts.kinds");
  const tVat = await getTranslations("subcontracts.vat");
  const tProblem = await getTranslations("subcontracts.problems");
  const tVariation = await getTranslations("subcontracts.variationStatus");
  const tAdvance = await getTranslations("subcontracts.advanceStatus");
  const tCertificate = await getTranslations("subcontracts.certificateStatus");
  const tMethod = await getTranslations("subcontracts.methods");
  const s = result.data.subcontract;
  const p = s.permissions;
  const items = p.canEdit
    ? await serverApi(
        `/subcontracts/projects/${s.project.id}/items?limit=100`,
        subcontractItemsResponseSchema,
      )
    : null;
  const lettable = items?.ok
    ? items.data.items
        .filter((item) => !s.lines.some((line) => line.bqItem.lineageId === item.lineageId))
        .map((item) => ({
          lineageId: item.lineageId,
          label: `${item.ref ?? "—"} · ${item.description.slice(0, 70)}`,
          basis: item.basis,
          unit: item.unit,
          available: item.availableQuantity,
        }))
    : [];
  const terms = s.terms;
  const lastCertified = s.certificates
    .filter((row) => row.status === "certified")
    .map((row) => row.valuationDate)
    .sort()
    .at(-1);
  const committedAdvances = s.advances
    .filter((row) => ["requested", "approved", "paid"].includes(row.status))
    .reduce((sum, row) => sum + row.amountMinor, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <SubcontractsEyebrow
            trail={{ href: `/subcontracts/projects/${s.project.id}`, label: t("back") }}
          />
        }
        title={`${s.code} · ${s.title}`}
        description={`${s.project.code} · ${s.supplier.name} · ${tKind(s.kind)}`}
        actions={
          <>
            <StatusBadge tone={subcontractStatusTone[s.status]}>{tStatus(s.status)}</StatusBadge>
            {p.canSubmit ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/submit`}
                entity="subcontract"
                body={{ version: s.version }}
                primary
                text={{
                  button: t("actions.submit"),
                  title: t("actions.submitTitle"),
                  description: t("actions.submitDescription", { amount: formatKES(s.valueMinor) }),
                  confirm: t("actions.submit"),
                }}
              />
            ) : null}
            {p.canApprove && s.digest ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/approve`}
                entity="subcontract"
                body={{ version: s.version, digest: s.digest }}
                primary
                text={{
                  button: t("actions.approve"),
                  title: t("actions.approveTitle", { amount: formatKES(s.valueMinor) }),
                  description: t("actions.approveDescription"),
                  confirm: t("actions.approve"),
                }}
              />
            ) : null}
            {p.canReturn ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/return`}
                entity="subcontract"
                body={{ version: s.version }}
                reason
                text={{
                  button: t("actions.return"),
                  title: t("actions.returnTitle"),
                  description: t("actions.returnDescription"),
                  confirm: t("actions.return"),
                }}
              />
            ) : null}
            {p.canActivate ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/activate`}
                entity="subcontract"
                body={{ version: s.version }}
                primary
                text={{
                  button: t("actions.activate"),
                  title: t("actions.activateTitle"),
                  description: t("actions.activateDescription"),
                  confirm: t("actions.activate"),
                }}
              />
            ) : null}
            {p.canComplete ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/complete`}
                entity="subcontract"
                body={{ version: s.version }}
                reason
                text={{
                  button: t("actions.complete"),
                  title: t("actions.completeTitle"),
                  description: t("actions.completeDescription"),
                  confirm: t("actions.complete"),
                }}
              />
            ) : null}
            {p.canTerminate ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/terminate`}
                entity="subcontract"
                body={{ version: s.version }}
                reason
                destructive
                text={{
                  button: t("actions.terminate"),
                  title: t("actions.terminateTitle"),
                  description: t("actions.terminateDescription"),
                  confirm: t("actions.terminate"),
                }}
              />
            ) : null}
            {p.canCancel ? (
              <SubcontractAction
                path={`/subcontracts/${s.id}/cancel`}
                entity="subcontract"
                body={{ version: s.version }}
                reason
                destructive
                text={{
                  button: t("actions.cancel"),
                  title: t("actions.cancelTitle"),
                  description: t("actions.cancelDescription"),
                  confirm: t("actions.cancel"),
                }}
              />
            ) : null}
          </>
        }
      />
      {s.status === "submitted" && s.submittedBy ? (
        <p className="rounded-xl border p-3 text-sm">
          {t("submittedNote", { name: s.submittedBy.displayName })}
        </p>
      ) : null}
      {s.returnReason && s.status === "draft" ? (
        <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {t("returned", { reason: s.returnReason })}
        </p>
      ) : null}
      {s.closeReason ? <p className="text-sm">{t("closed", { reason: s.closeReason })}</p> : null}
      {s.cancelReason ? (
        <p className="text-sm">{t("cancelled", { reason: s.cancelReason })}</p>
      ) : null}
      {s.problems.length && ["draft", "submitted"].includes(s.status) ? (
        <ul className="space-y-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {s.problems.map((entry) => (
            <li key={`${entry.code}-${entry.ref ?? ""}`}>
              {tProblem(problemKey(entry.code))}
              {entry.ref ? ` (${entry.ref})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {s.warnings.length ? (
        <ul className="space-y-1 rounded-xl border p-3 text-sm">
          {s.warnings.map((entry) => (
            <li key={`${entry.code}-${entry.ref ?? ""}`}>
              {t("warnings.rateAboveBq", { ref: entry.ref ?? "" })}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="subcontract-terms"
          className="space-y-2 rounded-xl border p-4 text-sm"
        >
          <h2 id="subcontract-terms" className="font-semibold">
            {t("termsTitle")}
          </h2>
          <dl className="grid grid-cols-2 gap-2">
            <dt className="text-muted-foreground">{t("terms.dates")}</dt>
            <dd>
              {formatCalendarDate(s.startDate)} – {formatCalendarDate(s.endDate)}
            </dd>
            <dt className="text-muted-foreground">{t("terms.retention")}</dt>
            <dd>
              {terms.retentionLimitPercent === null
                ? t("terms.retentionNoLimit", { percent: terms.retentionPercent })
                : t("terms.retentionValue", {
                    percent: terms.retentionPercent,
                    limit: terms.retentionLimitPercent,
                  })}
            </dd>
            <dt className="text-muted-foreground">{t("terms.release")}</dt>
            <dd>{terms.practicalReleasePercent} %</dd>
            <dt className="text-muted-foreground">{t("terms.vat")}</dt>
            <dd>{terms.vatPercent} %</dd>
            <dt className="text-muted-foreground">{t("terms.wht")}</dt>
            <dd>{terms.whtPercent} %</dd>
            <dt className="text-muted-foreground">{t("terms.advance")}</dt>
            <dd>
              {t("terms.advanceValue", {
                amount: formatKES(terms.advanceLimitMinor),
                percent: terms.advanceRecoveryPercent,
              })}
            </dd>
            <dt className="text-muted-foreground">{t("terms.payment")}</dt>
            <dd>
              {t("terms.paymentValue", { days: terms.paymentTermsDays })}
              {terms.paymentTermsNote ? ` · ${terms.paymentTermsNote}` : ""}
            </dd>
            <dt className="text-muted-foreground">{t("terms.version")}</dt>
            <dd>
              {t("terms.versionValue", {
                version: s.contractVersion,
                original: formatKES(s.originalValueMinor ?? s.valueMinor),
                current: formatKES(s.valueMinor),
              })}
            </dd>
          </dl>
          {s.scope ? <p className="whitespace-pre-line">{s.scope}</p> : null}
          <p className="text-xs text-muted-foreground">{t("termsNote")}</p>
        </section>
        <section
          aria-labelledby="subcontract-statement"
          className="space-y-2 rounded-xl border p-4 text-sm"
        >
          <h2 id="subcontract-statement" className="font-semibold">
            {t("statementTitle")}
          </h2>
          <dl className="grid grid-cols-2 gap-2">
            {(
              [
                ["certifiedWork", s.position.certifiedWorkMinor],
                ["certifiedDue", s.position.certifiedDueMinor],
                ["vat", s.position.vatMinor],
                ["wht", s.position.whtMinor],
                ["payable", s.position.payableMinor],
                ["paid", s.position.paidMinor],
                ["outstanding", s.position.outstandingMinor],
                ["retention", s.position.retentionHeldMinor],
                ["advancesPaid", s.position.advancesPaidMinor],
                ["advancesRecovered", s.position.advancesRecoveredMinor],
                ["advancesOutstanding", s.position.advancesOutstandingMinor],
                ["committed", s.committedMinor],
              ] as const
            ).map(([key, amount]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{t(`position.${key}`)}</dt>
                <dd className="text-right tabular-nums">{formatKES(amount)}</dd>
              </div>
            ))}
          </dl>
          {p.canExport ? (
            <div className="flex flex-wrap gap-2 pt-2">
              {(["en", "sw"] as const).map((locale) => (
                <Button key={locale} asChild size="sm" variant="outline">
                  <a href={`/api/v1/subcontracts/${s.id}/statement/pdf?locale=${locale}`} download>
                    <Download aria-hidden /> {t(`downloadPdf.${locale}`)}
                  </a>
                </Button>
              ))}
              <Button asChild size="sm" variant="outline">
                <a href={`/api/v1/subcontracts/${s.id}/statement/xlsx`} download>
                  <Download aria-hidden /> {t("downloadExcel")}
                </a>
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("paymentsOutside")}</p>
        </section>
      </div>

      <section aria-labelledby="subcontract-lines" className="space-y-2">
        <h2 id="subcontract-lines" className="text-lg font-semibold">
          {t("linesTitle")}
        </h2>
        {s.lines.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm">{t("noLines")}</p>
        ) : (
          <ScrollTable label={t("linesTitle")} minWidth={980}>
            <thead className="bg-muted/50 text-left">
              <tr>
                {(
                  [
                    "item",
                    "quantity",
                    "rate",
                    "amount",
                    "vat",
                    "bq",
                    "letElsewhere",
                    "measured",
                    "certified",
                  ] as const
                ).map((key) => (
                  <th
                    key={key}
                    scope="col"
                    className={`px-3 py-2 font-medium ${key === "item" || key === "vat" ? "" : "text-right"}`}
                  >
                    {t(`lines.${key}`)}
                  </th>
                ))}
                {p.canEdit ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{t("lines.remove")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {s.lines.map((line) => (
                <tr
                  key={line.id}
                  className={`border-t align-top ${line.inForce ? "" : "opacity-60"}`}
                >
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span className="font-medium">
                      {line.lineNo}. {line.bqItem.ref ?? "—"}
                    </span>{" "}
                    {line.description}
                    {line.addedBy ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("lines.addedBy", {
                          code: line.addedBy.code,
                          status: tVariation(line.addedBy.status),
                        })}
                      </span>
                    ) : null}
                    {line.overQuantityReason ? (
                      <span className="block text-xs text-warning">
                        {t("lines.overReason", { reason: line.overQuantityReason })}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(line.quantity)} {line.unit ?? ""}
                    {line.quantity !== line.originalQuantity ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("lines.was", { quantity: formatDecimalString(line.originalQuantity) })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.rateMinor === null ? t("lines.lumpSum") : formatKES(line.rateMinor)}
                    {line.rateAboveBq ? (
                      <span className="block text-xs text-warning">{t("lines.aboveBq")}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatKES(line.amountMinor)}
                  </td>
                  <td className="px-3 py-2">{tVat(line.vatTreatment)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {line.bqQuantity ? formatDecimalString(line.bqQuantity) : "100 %"}
                    {line.bqRate ? (
                      <span className="block text-xs text-muted-foreground">
                        @ {formatDecimalString(line.bqRate)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(line.letElsewhere)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(line.measuredToDate)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDecimalString(line.certifiedQuantity)}
                    <span className="block text-xs text-muted-foreground">
                      {formatKES(line.certifiedMinor)}
                    </span>
                  </td>
                  {p.canEdit ? (
                    <td className="px-3 py-2">
                      <RemoveLineButton
                        subcontractId={s.id}
                        lineId={line.id}
                        version={s.version}
                        label={t("lines.remove")}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        {p.canEdit ? (
          <AddLineForm subcontractId={s.id} version={s.version} items={lettable} />
        ) : null}
      </section>

      <section aria-labelledby="subcontract-variations" className="space-y-2">
        <h2 id="subcontract-variations" className="text-lg font-semibold">
          {t("variationsTitle")}
        </h2>
        {s.variations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noVariations")}</p>
        ) : (
          <ul className="space-y-2">
            {s.variations.map((variation) => (
              <li key={variation.id} className="space-y-2 rounded-xl border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{variation.code}</span>
                  <StatusBadge tone={variationStatusTone[variation.status]}>
                    {tVariation(variation.status)}
                  </StatusBadge>
                  <span className="tabular-nums">{formatKES(variation.valueChangeMinor)}</span>
                  {variation.resultingVersion ? (
                    <span className="text-muted-foreground">
                      {t("variationVersion", { version: variation.resultingVersion })}
                    </span>
                  ) : null}
                </div>
                <p>{variation.reason}</p>
                <ul className="text-xs text-muted-foreground">
                  {variation.changes.map((change) => (
                    <li key={change.lineId}>
                      {t("variationChange", {
                        line: change.lineNo,
                        quantity: change.quantityChange,
                        amount: formatKES(change.amountChangeMinor),
                      })}
                    </li>
                  ))}
                  {variation.additions.length ? (
                    <li>{t("variationAdditions", { count: variation.additions.length })}</li>
                  ) : null}
                </ul>
                {variation.decisionReason ? (
                  <p className="text-xs">
                    {t("decisionReason", { reason: variation.decisionReason })}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {variation.permissions.canApprove ? (
                    <SubcontractAction
                      path={`/subcontracts/${s.id}/variations/${variation.id}/approve`}
                      entity="subcontract"
                      body={{ version: variation.version, digest: variation.digest }}
                      primary
                      text={{
                        button: t("actions.approveVariation"),
                        title: t("actions.approveVariationTitle", { code: variation.code }),
                        description: t("actions.approveVariationDescription", {
                          amount: formatKES(variation.valueChangeMinor),
                        }),
                        confirm: t("actions.approveVariation"),
                      }}
                    />
                  ) : null}
                  {variation.permissions.canReject ? (
                    <SubcontractAction
                      path={`/subcontracts/${s.id}/variations/${variation.id}/reject`}
                      entity="subcontract"
                      body={{ version: variation.version }}
                      reason
                      destructive
                      text={{
                        button: t("actions.rejectVariation"),
                        title: t("actions.rejectVariationTitle", { code: variation.code }),
                        description: t("actions.rejectVariationDescription"),
                        confirm: t("actions.rejectVariation"),
                      }}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {p.canVary ? (
          <VariationForm
            subcontractId={s.id}
            lines={s.lines
              .filter((line) => line.inForce)
              .map((line) => ({
                id: line.id,
                label: `${line.lineNo}. ${line.bqItem.ref ?? ""}`,
                quantity: formatDecimalString(line.quantity),
                unit: line.unit ?? "",
              }))}
          />
        ) : null}
      </section>

      <section aria-labelledby="subcontract-advances" className="space-y-2">
        <h2 id="subcontract-advances" className="text-lg font-semibold">
          {t("advancesTitle")}
        </h2>
        {s.advances.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noAdvances")}</p>
        ) : (
          <ul className="space-y-2">
            {s.advances.map((advance) => (
              <li key={advance.id} className="space-y-2 rounded-xl border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{advance.code}</span>
                  <StatusBadge tone={advanceStatusTone[advance.status]}>
                    {tAdvance(advance.status)}
                  </StatusBadge>
                  <span className="tabular-nums">{formatKES(advance.amountMinor)}</span>
                </div>
                <p>{advance.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {t("advanceRequested", { name: advance.requestedBy.displayName })}
                  {advance.decidedBy
                    ? ` · ${t("advanceDecided", { name: advance.decidedBy.displayName })}`
                    : ""}
                  {advance.paidOn && advance.method
                    ? ` · ${t("advancePaid", {
                        date: formatCalendarDate(advance.paidOn),
                        method: tMethod(advance.method),
                        reference: advance.reference ?? "",
                      })}`
                    : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {advance.permissions.canApprove ? (
                    <SubcontractAction
                      path={`/subcontracts/advances/${advance.id}/approve`}
                      entity="subcontract"
                      body={{ version: advance.version }}
                      primary
                      text={{
                        button: t("actions.approveAdvance"),
                        title: t("actions.approveAdvanceTitle", {
                          amount: formatKES(advance.amountMinor),
                        }),
                        description: t("actions.approveAdvanceDescription"),
                        confirm: t("actions.approveAdvance"),
                      }}
                    />
                  ) : null}
                  {advance.permissions.canReject ? (
                    <SubcontractAction
                      path={`/subcontracts/advances/${advance.id}/reject`}
                      entity="subcontract"
                      body={{ version: advance.version }}
                      reason
                      destructive
                      text={{
                        button: t("actions.rejectAdvance"),
                        title: t("actions.rejectAdvanceTitle"),
                        description: t("actions.rejectAdvanceDescription"),
                        confirm: t("actions.rejectAdvance"),
                      }}
                    />
                  ) : null}
                  {advance.permissions.canCancel ? (
                    <SubcontractAction
                      path={`/subcontracts/advances/${advance.id}/cancel`}
                      entity="subcontract"
                      body={{ version: advance.version }}
                      reason
                      destructive
                      text={{
                        button: t("actions.cancelAdvance"),
                        title: t("actions.cancelAdvanceTitle"),
                        description: t("actions.cancelAdvanceDescription"),
                        confirm: t("actions.cancelAdvance"),
                      }}
                    />
                  ) : null}
                </div>
                {advance.permissions.canPay ? (
                  <AdvancePayForm advanceId={advance.id} version={advance.version} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {p.canRequestAdvance && terms.advanceLimitMinor > committedAdvances ? (
          <AdvanceRequestForm
            subcontractId={s.id}
            remainingMinor={terms.advanceLimitMinor - committedAdvances}
          />
        ) : null}
      </section>

      <section aria-labelledby="subcontract-certificates" className="space-y-2">
        <h2 id="subcontract-certificates" className="text-lg font-semibold">
          {t("certificatesTitle")}
        </h2>
        {s.certificates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noCertificates")}</p>
        ) : (
          <ScrollTable label={t("certificatesTitle")} minWidth={640}>
            <thead className="bg-muted/50 text-left">
              <tr>
                {(["certificate", "date", "status", "work", "due", "payable", "paid"] as const).map(
                  (key) => (
                    <th
                      key={key}
                      scope="col"
                      className={`px-3 py-2 font-medium ${["work", "due", "payable", "paid"].includes(key) ? "text-right" : ""}`}
                    >
                      {t(`certificates.${key}`)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {s.certificates.map((row) => (
                <tr key={row.id} className="border-t">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <Link
                      href={`/subcontracts/certificates/${row.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {row.code}
                    </Link>
                    {row.kind === "retention_release" ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("certificates.release")}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-3 py-2">{formatCalendarDate(row.valuationDate)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={certificateStatusTone[row.status]}>
                      {tCertificate(row.status)}
                    </StatusBadge>
                  </td>
                  {[row.workDoneMinor, row.amountDueMinor, row.payableMinor, row.paidMinor].map(
                    (amount, index) => (
                      <td key={index} className="px-3 py-2 text-right tabular-nums">
                        {amount === null ? "—" : formatKES(amount)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        {p.canCreateCertificate ? (
          <NewCertificateForm
            subcontractId={s.id}
            release={s.position.retentionHeldMinor > 0}
            minDate={lastCertified ?? null}
          />
        ) : null}
      </section>
    </div>
  );
}
