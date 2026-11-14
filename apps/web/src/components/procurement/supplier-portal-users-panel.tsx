"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { UserPlus } from "lucide-react";
import type { SupplierStatus } from "@pm-buddy/types";
import {
  invitePortalUserRequestSchema,
  supplierPortalUserResponseSchema,
  type SupplierPortalUser,
  type SupplierPortalUsersResponse,
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { portalUserTone } from "@/lib/supplier-portal";

/**
 * Staff (procurement.manage_suppliers, or company-wide finance.manage) invite a supplier's
 * contacts to the supplier portal and revoke their access (D7.2). Inviting needs step-up MFA.
 */
export function SupplierPortalUsersPanel({
  data,
  supplierStatus,
}: {
  data: SupplierPortalUsersResponse;
  supplierStatus: SupplierStatus;
}) {
  const t = useTranslations("suppliers.portalUsers");
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<SupplierPortalUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // When the panel was shown: an invitation past its expiry is labelled expired.
  const [shownAt] = useState(() => Date.now());
  const blocked = supplierStatus === "blocked";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>
            <h2>{t("title")}</h2>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        {data.permissions.canInvite && !blocked ? (
          <Button variant="outline" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden /> {t("invite")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <p role="status" className="text-sm empty:hidden">
          {notice}
        </p>
        {blocked && data.permissions.canInvite ? (
          <p className="text-sm text-muted-foreground">{t("blocked")}</p>
        ) : null}
        {data.users.length ? (
          <ul className="grid gap-3 md:grid-cols-2" aria-label={t("title")}>
            {data.users.map((user) => (
              <li key={user.id} className="space-y-1 rounded-lg border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="break-all">{user.contactName}</span>
                  <StatusBadge tone={portalUserTone[user.status]}>
                    {t(`statuses.${user.status}`)}
                  </StatusBadge>
                </p>
                <p className="break-all text-muted-foreground">{user.identifier}</p>
                <p>
                  {t("invitedBy", {
                    name: user.invitedBy.displayName,
                    date: formatDate(user.invitedAt),
                  })}
                </p>
                {user.status === "invited" && user.invitationExpiresAt ? (
                  <p>
                    {Date.parse(user.invitationExpiresAt) <= shownAt
                      ? t("expired", { date: formatDate(user.invitationExpiresAt) })
                      : t("expires", { date: formatDate(user.invitationExpiresAt) })}
                  </p>
                ) : null}
                {user.activatedAt && user.account ? (
                  <p>
                    {t("activated", {
                      date: formatDate(user.activatedAt),
                      name: user.account.displayName,
                    })}
                  </p>
                ) : null}
                {user.revokedAt ? (
                  <p>
                    {user.revokeCause === "superseded"
                      ? t("superseded", { date: formatDate(user.revokedAt) })
                      : user.revokeCause === "membership_ended" || !user.revokedBy
                        ? t("membershipEnded", { date: formatDate(user.revokedAt) })
                        : t("revokedBy", {
                            name: user.revokedBy.displayName,
                            date: formatDate(user.revokedAt),
                          })}
                  </p>
                ) : null}
                {user.revokeReason ? (
                  <p className="whitespace-pre-line text-muted-foreground">{user.revokeReason}</p>
                ) : null}
                <p className="text-muted-foreground">
                  {t("submitted", { count: user.submittedInvoices })}
                </p>
                {data.permissions.canRevoke && user.status !== "revoked" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={() => setRevoking(user)}
                  >
                    {t("revoke")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
      </CardContent>
      <InviteDialog
        supplierId={data.supplier.id}
        open={inviting}
        onClose={(done) => {
          setInviting(false);
          if (done) setNotice(t("invited"));
        }}
      />
      <RevokeDialog
        supplierId={data.supplier.id}
        user={revoking}
        onClose={(done) => {
          setRevoking(null);
          if (done) setNotice(t("revoked"));
        }}
      />
    </Card>
  );
}

function InviteDialog({
  supplierId,
  open,
  onClose,
}: {
  supplierId: string;
  open: boolean;
  onClose: (done: boolean) => void;
}) {
  const t = useTranslations("suppliers.portalUsers");
  const router = useRouter();
  const problem = useProblemMessage();
  const { run, dialog } = useStepUp();
  const [contactName, setContactName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<"contactName" | "identifier" | null>(null);

  async function submit() {
    const parsed = invitePortalUserRequestSchema.safeParse({ contactName, identifier });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.path[0] === "contactName" ? "contactName" : "identifier");
      return;
    }
    setInvalid(null);
    setBusy(true);
    setFailure(null);
    try {
      await run(() =>
        liveRequest(`/suppliers/${supplierId}/portal-users`, supplierPortalUserResponseSchema, {
          method: "POST",
          body: parsed.data,
        }),
      );
      setContactName("");
      setIdentifier("");
      onClose(true);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose(false))}>
        <DialogContent>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("inviteTitle")}</DialogTitle>
              <DialogDescription>{t("inviteDescription")}</DialogDescription>
            </DialogHeader>
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
            <Field data-invalid={invalid === "contactName" || undefined}>
              <FieldLabel htmlFor="portal-user-name">{t("contactName")}</FieldLabel>
              <Input
                id="portal-user-name"
                maxLength={100}
                value={contactName}
                aria-invalid={invalid === "contactName" || undefined}
                onChange={(event) => setContactName(event.target.value)}
              />
              {invalid === "contactName" ? <FieldError>{t("nameRequired")}</FieldError> : null}
            </Field>
            <Field data-invalid={invalid === "identifier" || undefined}>
              <FieldLabel htmlFor="portal-user-identifier">{t("identifier")}</FieldLabel>
              <Input
                id="portal-user-identifier"
                autoComplete="off"
                maxLength={254}
                value={identifier}
                aria-invalid={invalid === "identifier" || undefined}
                onChange={(event) => setIdentifier(event.target.value)}
              />
              {invalid === "identifier" ? <FieldError>{t("identifierInvalid")}</FieldError> : null}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onClose(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("sending") : t("send")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {dialog}
    </>
  );
}

function RevokeDialog({
  supplierId,
  user,
  onClose,
}: {
  supplierId: string;
  user: SupplierPortalUser | null;
  onClose: (done: boolean) => void;
}) {
  const t = useTranslations("suppliers.portalUsers");
  const router = useRouter();
  const problem = useProblemMessage();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    if (!user) return;
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(
        `/suppliers/${supplierId}/portal-users/${user.id}/revoke`,
        supplierPortalUserResponseSchema,
        { method: "POST", body: { version: user.version, reason: reason.trim() } },
      );
      setReason("");
      onClose(true);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={user !== null} onOpenChange={(next) => (next ? undefined : onClose(false))}>
      <DialogContent>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("revokeTitle", { name: user?.contactName ?? "" })}</DialogTitle>
            <DialogDescription>{t("revokeDescription")}</DialogDescription>
          </DialogHeader>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="portal-user-reason">{t("reason")}</FieldLabel>
            <Textarea
              id="portal-user-reason"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 3}>
              {t("confirmRevoke")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
