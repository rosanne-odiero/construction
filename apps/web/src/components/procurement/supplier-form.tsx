"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { normalizeKenyanPhone, normaliseKraPin } from "@pm-buddy/domain";
import {
  ETIMS_STATUSES,
  SUPPLIER_STATUSES,
  type EtimsStatus,
  type SupplierStatus,
} from "@pm-buddy/types";
import { supplierDetailResponseSchema, type SupplierDetailResponse } from "@pm-buddy/validation";
import { useProblemMessage } from "@/components/projects/use-problem-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { decimalKesToMinor } from "@/lib/format";
import { liveRequest } from "@/lib/live-api";
import { selectClass } from "./material-form";

type Contact = {
  key: string;
  id?: string;
  name: string;
  role: string;
  phone: string;
  phoneMasked: string | null;
  clearPhone: boolean;
  email: string;
  primary: boolean;
};

const kes = (minor: number | null) =>
  minor === null ? "" : `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/**
 * Adds or edits a supplier. Sensitive values are never sent back to the browser: an empty KRA PIN
 * or mobile field keeps the stored value (shown masked), and clearing needs an explicit tick.
 */
export function SupplierForm({ existing }: { existing?: SupplierDetailResponse }) {
  const t = useTranslations("suppliers.form");
  const tStatuses = useTranslations("suppliers.statuses");
  const tEtims = useTranslations("suppliers.etims");
  const problem = useProblemMessage();
  const router = useRouter();
  const supplier = existing?.supplier;
  const [form, setForm] = useState({
    legalName: supplier?.legalName ?? "",
    tradingName: supplier?.tradingName ?? "",
    kraPin: "",
    clearKraPin: false,
    etimsStatus: (supplier?.etimsStatus ?? "unknown") as EtimsStatus,
    etimsCheckedOn: supplier?.etimsCheckedOn ?? "",
    creditDays: String(supplier?.creditDays ?? 0),
    creditLimit: kes(supplier?.creditLimitMinor ?? null),
    notes: supplier?.notes ?? "",
    status: (supplier?.status ?? "active") as SupplierStatus,
    statusReason: supplier?.statusReason ?? "",
  });
  const [contacts, setContacts] = useState<Contact[]>(
    existing
      ? existing.contacts.map((contact, index) => ({
          key: `contact-${index}`,
          id: contact.id,
          name: contact.name,
          role: contact.role ?? "",
          phone: "",
          phoneMasked: contact.phoneMasked,
          clearPhone: false,
          email: contact.email ?? "",
          primary: contact.primary,
        }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const pinValid = form.kraPin.trim() === "" || normaliseKraPin(form.kraPin) !== null;
  const creditDays = Number(form.creditDays);
  const creditLimit = form.creditLimit.trim() ? decimalKesToMinor(form.creditLimit.trim()) : null;
  const valid =
    form.legalName.trim().length >= 2 &&
    pinValid &&
    /^\d{1,3}$/.test(form.creditDays) &&
    creditDays <= 365 &&
    (form.creditLimit.trim() === "" || (creditLimit !== null && creditLimit >= 0)) &&
    (form.status === "active" || form.statusReason.trim().length >= 3) &&
    contacts.every(
      (contact) =>
        contact.name.trim().length >= 2 &&
        (contact.phone.trim() === "" || normalizeKenyanPhone(contact.phone) !== null),
    );

  function update(key: string, patch: Partial<Contact>) {
    setContacts(
      contacts.map((contact) =>
        contact.key === key
          ? { ...contact, ...patch }
          : patch.primary
            ? { ...contact, primary: false }
            : contact,
      ),
    );
  }

  async function submit() {
    setBusy(true);
    setFailure(null);
    const contactBody = contacts.map((contact) => {
      const phone = contact.phone.trim();
      return {
        ...(contact.id ? { id: contact.id } : {}),
        name: contact.name.trim(),
        role: contact.role.trim(),
        email: contact.email.trim(),
        primary: contact.primary,
        ...(phone ? { phone } : contact.clearPhone ? { phone: null } : {}),
      };
    });
    const common = {
      legalName: form.legalName.trim(),
      tradingName: form.tradingName.trim(),
      etimsStatus: form.etimsStatus,
      etimsCheckedOn: form.etimsCheckedOn || null,
      creditDays,
      creditLimitMinor: creditLimit,
      notes: form.notes.trim(),
      contacts: contactBody,
    };
    const pin = form.kraPin.trim();
    try {
      const saved = await liveRequest(
        existing ? `/suppliers/${existing.supplier.id}` : "/suppliers",
        supplierDetailResponseSchema,
        existing
          ? {
              method: "PATCH",
              body: {
                ...common,
                ...(pin ? { kraPin: pin } : form.clearKraPin ? { kraPin: null } : {}),
                status: form.status,
                statusReason: form.status === "active" ? "" : form.statusReason.trim(),
                version: existing.supplier.version,
              },
            }
          : { method: "POST", body: { ...common, ...(pin ? { kraPin: pin } : {}) } },
      );
      router.push(`/suppliers/${saved.supplier.id}`);
      router.refresh();
    } catch (error) {
      setFailure(problem(error));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{existing ? t("editTitle", { code: existing.supplier.code }) : t("createTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {failure ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) void submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="supplier-legal-name">{t("legalName")}</FieldLabel>
            <Input
              id="supplier-legal-name"
              value={form.legalName}
              maxLength={200}
              onChange={(event) => setForm({ ...form, legalName: event.target.value })}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-trading-name">{t("tradingName")}</FieldLabel>
            <Input
              id="supplier-trading-name"
              value={form.tradingName}
              maxLength={200}
              onChange={(event) => setForm({ ...form, tradingName: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-kra-pin">{t("kraPin")}</FieldLabel>
            <Input
              id="supplier-kra-pin"
              value={form.kraPin}
              maxLength={20}
              autoComplete="off"
              aria-invalid={!pinValid}
              onChange={(event) => setForm({ ...form, kraPin: event.target.value })}
            />
            <FieldDescription>
              {t("kraPinHint")}{" "}
              {supplier?.kraPinMasked ? t("kraPinKeep", { masked: supplier.kraPinMasked }) : null}
            </FieldDescription>
            {supplier?.kraPinMasked ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={form.clearKraPin}
                  onChange={(event) => setForm({ ...form, clearKraPin: event.target.checked })}
                />
                {t("kraPinClear")}
              </label>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-etims">{t("etimsStatus")}</FieldLabel>
            <select
              id="supplier-etims"
              value={form.etimsStatus}
              className={selectClass}
              onChange={(event) =>
                setForm({ ...form, etimsStatus: event.target.value as EtimsStatus })
              }
            >
              {ETIMS_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {tEtims(status)}
                </option>
              ))}
            </select>
            <FieldDescription>{t("etimsHint")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-etims-date">{t("etimsCheckedOn")}</FieldLabel>
            <Input
              id="supplier-etims-date"
              type="date"
              value={form.etimsCheckedOn}
              onChange={(event) => setForm({ ...form, etimsCheckedOn: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-credit-days">{t("creditDays")}</FieldLabel>
            <Input
              id="supplier-credit-days"
              inputMode="numeric"
              value={form.creditDays}
              maxLength={3}
              onChange={(event) => setForm({ ...form, creditDays: event.target.value.trim() })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="supplier-credit-limit">{t("creditLimit")}</FieldLabel>
            <Input
              id="supplier-credit-limit"
              inputMode="decimal"
              value={form.creditLimit}
              onChange={(event) => setForm({ ...form, creditLimit: event.target.value })}
            />
          </Field>
          {existing ? (
            <>
              <Field>
                <FieldLabel htmlFor="supplier-status">{t("status")}</FieldLabel>
                <select
                  id="supplier-status"
                  value={form.status}
                  className={selectClass}
                  onChange={(event) =>
                    setForm({ ...form, status: event.target.value as SupplierStatus })
                  }
                >
                  {SUPPLIER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {tStatuses(status)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-status-reason">{t("statusReason")}</FieldLabel>
                <Input
                  id="supplier-status-reason"
                  value={form.statusReason}
                  maxLength={500}
                  disabled={form.status === "active"}
                  onChange={(event) => setForm({ ...form, statusReason: event.target.value })}
                />
              </Field>
            </>
          ) : null}
          <Field className="md:col-span-2">
            <FieldLabel htmlFor="supplier-notes">{t("notes")}</FieldLabel>
            <Textarea
              id="supplier-notes"
              value={form.notes}
              maxLength={2000}
              rows={2}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
            />
          </Field>
          <div className="space-y-3 md:col-span-2">
            <h3 className="text-sm font-medium">{t("contacts")}</h3>
            {contacts.map((contact, index) => {
              const id = `contact-${contact.key}`;
              return (
                <fieldset
                  key={contact.key}
                  className="grid gap-3 rounded-lg border p-3 md:grid-cols-2"
                >
                  <legend className="px-1 text-sm font-medium">
                    {t("contactLegend", { number: index + 1 })}
                  </legend>
                  <Field>
                    <FieldLabel htmlFor={`${id}-name`}>{t("contactName")}</FieldLabel>
                    <Input
                      id={`${id}-name`}
                      value={contact.name}
                      maxLength={100}
                      onChange={(event) => update(contact.key, { name: event.target.value })}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-role`}>{t("contactRole")}</FieldLabel>
                    <Input
                      id={`${id}-role`}
                      value={contact.role}
                      maxLength={60}
                      onChange={(event) => update(contact.key, { role: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-phone`}>{t("contactPhone")}</FieldLabel>
                    <Input
                      id={`${id}-phone`}
                      inputMode="tel"
                      autoComplete="off"
                      value={contact.phone}
                      maxLength={20}
                      onChange={(event) => update(contact.key, { phone: event.target.value })}
                    />
                    {contact.phoneMasked ? (
                      <>
                        <FieldDescription>
                          {t("contactPhoneKeep", { masked: contact.phoneMasked })}
                        </FieldDescription>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={contact.clearPhone}
                            onChange={(event) =>
                              update(contact.key, { clearPhone: event.target.checked })
                            }
                          />
                          {t("contactPhoneClear")}
                        </label>
                      </>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-email`}>{t("contactEmail")}</FieldLabel>
                    <Input
                      id={`${id}-email`}
                      type="email"
                      value={contact.email}
                      maxLength={254}
                      onChange={(event) => update(contact.key, { email: event.target.value })}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="primary-contact"
                        className="size-4 accent-primary"
                        checked={contact.primary}
                        onChange={() => update(contact.key, { primary: true })}
                      />
                      {t("primary")}
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setContacts(contacts.filter((entry) => entry.key !== contact.key))
                      }
                    >
                      <Trash2 aria-hidden /> {t("removeContact", { number: index + 1 })}
                    </Button>
                  </div>
                </fieldset>
              );
            })}
            {contacts.length < 5 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setContacts([
                    ...contacts,
                    {
                      key: crypto.randomUUID(),
                      name: "",
                      role: "",
                      phone: "",
                      phoneMasked: null,
                      clearPhone: false,
                      email: "",
                      primary: contacts.length === 0,
                    },
                  ])
                }
              >
                <Plus aria-hidden /> {t("addContact")}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={busy || !valid}>
              {existing ? t("save") : t("submit")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                router.push(existing ? `/suppliers/${existing.supplier.id}` : "/suppliers")
              }
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
