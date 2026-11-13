"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Pencil, Printer } from "lucide-react";
import { lpoDetailResponseSchema } from "@pm-buddy/validation";
import { selectClass } from "@/components/procurement/material-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { liveRequest } from "@/lib/live-api";
import type { SiteOption } from "@/lib/p2p-server";
import { useP2pProblem } from "./use-p2p-problem";

/** Edits a draft LPO's delivery site, date and terms (approved LPOs never change). */
export function LpoDeliveryDialog({
  lpoId,
  number,
  version,
  sites,
  initial,
}: {
  lpoId: string;
  number: string;
  version: number;
  sites: SiteOption[];
  initial: { siteId: string | null; date: string | null; terms: string | null };
}) {
  const t = useTranslations("p2p.lpos.detail");
  const tCommon = useTranslations("p2p.common");
  const problem = useP2pProblem();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [siteId, setSiteId] = useState(initial.siteId ?? "");
  const [date, setDate] = useState(initial.date ?? "");
  const [terms, setTerms] = useState(initial.terms ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await liveRequest(`/procurement/lpos/${lpoId}`, lpoDetailResponseSchema, {
        method: "PATCH",
        body: {
          version,
          deliverySiteId: siteId || null,
          deliveryDate: date || null,
          terms: terms.trim() || null,
        },
      });
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil aria-hidden /> {t("edit")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editTitle", { number })}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="lpo-site">{t("deliverySite")}</FieldLabel>
            <select
              id="lpo-site"
              className={selectClass}
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
            >
              <option value="">—</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="lpo-date">{t("deliveryDate")}</FieldLabel>
            <Input
              id="lpo-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="lpo-terms">{t("terms")}</FieldLabel>
            <Textarea
              id="lpo-terms"
              rows={3}
              maxLength={2000}
              value={terms}
              onChange={(event) => setTerms(event.target.value)}
            />
          </Field>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon("close")}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {t("editSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Opens the browser's print dialog (the print stylesheet hides the navigation). */
export function PrintButton() {
  const t = useTranslations("p2p.common");
  return (
    <Button variant="outline" className="print:hidden" onClick={() => window.print()}>
      <Printer aria-hidden /> {t("print")}
    </Button>
  );
}
