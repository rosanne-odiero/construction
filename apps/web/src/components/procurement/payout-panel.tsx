"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  MPESA_PAYOUT_KINDS,
  PAYOUT_VERIFICATION_METHODS,
  type MpesaPayoutKind,
  type PayoutVerificationMethod,
} from "@pm-buddy/types";
import {
  supplierDetailResponseSchema,
  type PayoutVersion,
  type SupplierDetailResponse,
} from "@pm-buddy/validation";
import { useStepUp } from "@/components/projects/step-up";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { selectClass } from "./material-form";
import { RevealValue } from "./reveal-value";
import { payoutTone } from "./tones";

/** One payout version's channels, people and decision. */
function VersionDetails({
  version,
  supplierId,
  canRevealBank,
}: {
  version: PayoutVersion;
  supplierId: string;
  canRevealBank: boolean;
}) {
  const t = useTranslations("suppliers.payout");
  const tMethods = useTranslations("suppliers.payout.methods");
  return (
    <div className="space-y-1 text-sm">
      {version.mpesaKind === "paybill" ? (
        <p>
          {t("paybill", {
            number: version.paybillNumber ?? "",
            reference: version.accountReference ?? "",
          })}
        </p>
      ) : null}
      {version.mpesaKind === "till" ? (
        <p>{t("till", { number: version.tillNumber ?? "" })}</p>
      ) : null}
      {version.bank ? (
        <div>
          <p className="flex flex-wrap items-center gap-1">
            {t("bank", {
              bank: version.bank.bankName,
              name: version.bank.accountName,
              account: "",
            })}
            <RevealValue
              supplierId={supplierId}
              field="accountNumber"
              masked={version.bank.accountNumberMasked}
              payoutId={version.id}
              canReveal={canRevealBank}
            />
          </p>
          {version.bank.branch ? (
            <p className="text-muted-foreground">
              {t("bankBranch", { branch: version.bank.branch })}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-muted-foreground">
        {t("proposedBy", {
          name: version.proposedBy.displayName,
          date: formatDate(version.proposedAt),
        })}
      </p>
      {version.contributors.length > 1 ? (
        <p className="text-muted-foreground">
          {t("contributors", {
            names: version.contributors.map((person) => person.displayName).join(", "),
          })}
        </p>
      ) : null}
      {version.verifiedBy && version.verifiedAt && version.verificationMethod ? (
        <>
          <p>
            {t("verifiedBy", {
              name: version.verifiedBy.displayName,
              date: formatDate(version.verifiedAt),
              method: tMethods(version.verificationMethod),
            })}
          </p>
          {version.verificationNote ? (
            <p className="text-muted-foreground">
              {t("verificationNote", { note: version.verificationNote })}
            </p>
          ) : null}
        </>
      ) : null}
      {version.rejectedBy && version.rejectedAt ? (
        <p>
          {t("rejectedBy", {
            name: version.rejectedBy.displayName,
            date: formatDate(version.rejectedAt),
            reason: version.rejectionReason ?? "",
          })}
        </p>
      ) : null}
      {version.supersededAt ? (
        <p className="text-muted-foreground">
          {t("supersededOn", { date: formatDate(version.supersededAt) })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Supplier payout details with maker-checker: propose (manage suppliers + step-up), verify or
 * reject (payments.approve + step-up, by someone who did not make or contribute to the details).
 */
export function PayoutPanel({ detail }: { detail: SupplierDetailResponse }) {
  const t = useTranslations("suppliers.payout");
  const tKinds = useTranslations("suppliers.payout.kinds");
  const tMethods = useTranslations("suppliers.payout.methods");
  const tStatuses = useTranslations("suppliers.payout.statuses");
  const problem = useProblemMessage();
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const supplierId = detail.supplier.id;
  const current = detail.payout.current;
  const permissions = detail.permissions;
  const [dialogOpen, setDialogOpen] = useState<"propose" | "verify" | "reject" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emptyProposal = () => ({
    mpesaKind: "paybill" as MpesaPayoutKind,
    paybillNumber: "",
    accountReference: "",
    tillNumber: "",
    withBank: false,
    bankName: "",
    branch: "",
    accountName: detail.supplier.legalName,
    accountNumber: "",
  });
  const [proposal, setProposal] = useState(emptyProposal);
  const [decision, setDecision] = useState({
    method: "call_back_known_number" as PayoutVerificationMethod,
    note: "",
    reason: "",
  });

  const shortcode = /^\d{5,7}$/;
  const proposalValid =
    (proposal.mpesaKind === "paybill"
      ? shortcode.test(proposal.paybillNumber) &&
        /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,19}$/.test(proposal.accountReference.trim())
      : proposal.mpesaKind === "till"
        ? shortcode.test(proposal.tillNumber)
        : proposal.withBank) &&
    (!proposal.withBank ||
      (proposal.bankName.trim().length >= 2 &&
        proposal.accountName.trim().length >= 2 &&
        /^[0-9A-Z]{5,30}$/.test(proposal.accountNumber.replace(/[\s-]/g, "").toUpperCase())));

  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await run(() => liveRequest(path, supplierDetailResponseSchema, { method: "POST", body }));
      setDialogOpen(null);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  const open = (which: "propose" | "verify" | "reject") => {
    setFailure(null);
    if (which === "propose") setProposal(emptyProposal());
    else setDecision({ method: "call_back_known_number", note: "", reason: "" });
    setDialogOpen(which);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle>
            <h2>{t("title")}</h2>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        {permissions.canManage ? (
          <Button variant="outline" onClick={() => open("propose")}>
            {current ? t("propose") : t("proposeFirst")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {current ? (
          <div className="space-y-3 rounded-lg border p-3" data-testid="payout-current">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t("current", { version: current.versionNo })}</span>
              <StatusBadge tone={payoutTone[current.status]}>
                {tStatuses(current.status)}
              </StatusBadge>
              <StatusBadge
                tone={current.usableForPayment ? "success" : "warning"}
                icon={
                  current.usableForPayment ? <ShieldCheck className="size-3" aria-hidden /> : null
                }
              >
                {current.usableForPayment ? t("usable") : t("notUsable")}
              </StatusBadge>
            </div>
            <VersionDetails
              version={current}
              supplierId={supplierId}
              canRevealBank={permissions.canRevealBank}
            />
            {current.status === "pending" && current.contactChangeWarning ? (
              <p
                role="note"
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("warning")}
              </p>
            ) : null}
            {current.status === "pending" ? (
              current.canDecide ? (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => open("verify")}>{t("verify")}</Button>
                  <Button variant="outline" onClick={() => open("reject")}>
                    {t("reject")}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {permissions.canVerifyPayout ? t("makerChecker") : t("needsPermission")}
                </p>
              )
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        )}
        {detail.payout.history.length ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t("history")}</summary>
            <ul className="mt-2 space-y-2">
              {detail.payout.history.map((version) => (
                <li key={version.id} className="rounded-lg border p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {t("current", { version: version.versionNo })}
                    </span>
                    <StatusBadge tone={payoutTone[version.status]}>
                      {tStatuses(version.status)}
                    </StatusBadge>
                  </div>
                  <VersionDetails
                    version={version}
                    supplierId={supplierId}
                    canRevealBank={permissions.canRevealBank}
                  />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>

      <Dialog
        open={dialogOpen === "propose"}
        onOpenChange={(next) => setDialogOpen(next ? "propose" : null)}
      >
        <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("proposeTitle")}</DialogTitle>
            <DialogDescription>{t("proposeDescription")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id="payout-propose"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!proposalValid) return;
              void send(`/suppliers/${supplierId}/payout-details`, {
                replaces: current?.id ?? null,
                mpesaKind: proposal.mpesaKind,
                paybillNumber: proposal.mpesaKind === "paybill" ? proposal.paybillNumber : null,
                accountReference:
                  proposal.mpesaKind === "paybill" ? proposal.accountReference.trim() : null,
                tillNumber: proposal.mpesaKind === "till" ? proposal.tillNumber : null,
                bank: proposal.withBank
                  ? {
                      bankName: proposal.bankName.trim(),
                      branch: proposal.branch.trim(),
                      accountName: proposal.accountName.trim(),
                      accountNumber: proposal.accountNumber,
                    }
                  : null,
              });
            }}
          >
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="payout-kind">{t("mpesaKind")}</FieldLabel>
              <select
                id="payout-kind"
                value={proposal.mpesaKind}
                className={selectClass}
                onChange={(event) =>
                  setProposal({ ...proposal, mpesaKind: event.target.value as MpesaPayoutKind })
                }
              >
                {MPESA_PAYOUT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {tKinds(kind)}
                  </option>
                ))}
              </select>
            </Field>
            {proposal.mpesaKind === "paybill" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="payout-paybill">{t("paybillNumber")}</FieldLabel>
                  <Input
                    id="payout-paybill"
                    inputMode="numeric"
                    maxLength={7}
                    value={proposal.paybillNumber}
                    onChange={(event) =>
                      setProposal({ ...proposal, paybillNumber: event.target.value.trim() })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="payout-reference">{t("accountReference")}</FieldLabel>
                  <Input
                    id="payout-reference"
                    maxLength={20}
                    value={proposal.accountReference}
                    onChange={(event) =>
                      setProposal({ ...proposal, accountReference: event.target.value })
                    }
                  />
                </Field>
              </>
            ) : null}
            {proposal.mpesaKind === "till" ? (
              <Field>
                <FieldLabel htmlFor="payout-till">{t("tillNumber")}</FieldLabel>
                <Input
                  id="payout-till"
                  inputMode="numeric"
                  maxLength={7}
                  value={proposal.tillNumber}
                  onChange={(event) =>
                    setProposal({ ...proposal, tillNumber: event.target.value.trim() })
                  }
                />
              </Field>
            ) : null}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={proposal.withBank}
                onChange={(event) => setProposal({ ...proposal, withBank: event.target.checked })}
              />
              {t("withBank")}
            </label>
            {proposal.withBank ? (
              <>
                <Field>
                  <FieldLabel htmlFor="payout-bank">{t("bankName")}</FieldLabel>
                  <Input
                    id="payout-bank"
                    maxLength={100}
                    value={proposal.bankName}
                    onChange={(event) => setProposal({ ...proposal, bankName: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="payout-branch">{t("branch")}</FieldLabel>
                  <Input
                    id="payout-branch"
                    maxLength={100}
                    value={proposal.branch}
                    onChange={(event) => setProposal({ ...proposal, branch: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="payout-account-name">{t("accountName")}</FieldLabel>
                  <Input
                    id="payout-account-name"
                    maxLength={150}
                    value={proposal.accountName}
                    onChange={(event) =>
                      setProposal({ ...proposal, accountName: event.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="payout-account-number">{t("accountNumber")}</FieldLabel>
                  <Input
                    id="payout-account-number"
                    autoComplete="off"
                    maxLength={40}
                    value={proposal.accountNumber}
                    onChange={(event) =>
                      setProposal({ ...proposal, accountNumber: event.target.value })
                    }
                  />
                </Field>
              </>
            ) : null}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(null)}>
              {t("cancel")}
            </Button>
            <Button type="submit" form="payout-propose" disabled={busy || !proposalValid}>
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen === "verify"}
        onOpenChange={(next) => setDialogOpen(next ? "verify" : null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("verifyTitle")}</DialogTitle>
            <DialogDescription>{t("verifyDescription")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {current?.contactChangeWarning ? (
            <p role="note" className="text-sm">
              {t("warning")}
            </p>
          ) : null}
          <form
            id="payout-verify"
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!current || decision.note.trim().length < 3) return;
              void send(`/suppliers/${supplierId}/payout-details/${current.id}/verify`, {
                method: decision.method,
                note: decision.note.trim(),
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="payout-method">{t("method")}</FieldLabel>
              <select
                id="payout-method"
                value={decision.method}
                className={selectClass}
                onChange={(event) =>
                  setDecision({
                    ...decision,
                    method: event.target.value as PayoutVerificationMethod,
                  })
                }
              >
                {PAYOUT_VERIFICATION_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {tMethods(method)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="payout-note">{t("note")}</FieldLabel>
              <Textarea
                id="payout-note"
                rows={3}
                maxLength={500}
                value={decision.note}
                onChange={(event) => setDecision({ ...decision, note: event.target.value })}
              />
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              form="payout-verify"
              disabled={busy || decision.note.trim().length < 3}
            >
              {t("verifySubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen === "reject"}
        onOpenChange={(next) => setDialogOpen(next ? "reject" : null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("rejectTitle")}</DialogTitle>
            <DialogDescription>{t("verifyDescription")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <form
            id="payout-reject"
            onSubmit={(event) => {
              event.preventDefault();
              if (!current || decision.reason.trim().length < 3) return;
              void send(`/suppliers/${supplierId}/payout-details/${current.id}/reject`, {
                reason: decision.reason.trim(),
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="payout-reason">{t("rejectReason")}</FieldLabel>
              <Textarea
                id="payout-reason"
                rows={3}
                maxLength={500}
                value={decision.reason}
                onChange={(event) => setDecision({ ...decision, reason: event.target.value })}
              />
            </Field>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              form="payout-reject"
              variant="destructive"
              disabled={busy || decision.reason.trim().length < 3}
            >
              {t("rejectSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dialog}
    </Card>
  );
}
