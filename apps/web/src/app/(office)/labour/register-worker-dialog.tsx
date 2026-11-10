"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeKenyanPhone } from "@/lib/format";
import { NOW } from "@/mocks/company";
import type { TradeKey } from "@/mocks/labour";

const trades: TradeKey[] = [
  "mason",
  "steel_fixer",
  "carpenter",
  "plumber",
  "electrician",
  "welder",
  "plasterer",
  "machine_operator",
  "watchman",
  "general_labourer",
  "foreman",
];

function ageOn(dobIso: string, onIso: string): number {
  const dob = new Date(dobIso);
  const on = new Date(onIso);
  let age = on.getFullYear() - dob.getFullYear();
  const beforeBirthday =
    on.getMonth() < dob.getMonth() ||
    (on.getMonth() === dob.getMonth() && on.getDate() < dob.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function RegisterWorkerDialog() {
  const t = useTranslations("labour.register");
  const tTrades = useTranslations("trades");
  const [dob, setDob] = useState("2009-03-14");
  const [phone, setPhone] = useState("0722 000 111");

  const age = dob ? ageOn(dob, NOW) : null;
  const underage = age !== null && age < 18;
  const normalised = normalizeKenyanPhone(phone);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <UserPlus aria-hidden /> {t("open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (underage || !normalised) return;
            toast.info(t("savedToast"));
          }}
        >
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="w-name">{t("name")}</FieldLabel>
                <Input id="w-name" defaultValue="Brian Kiprotich Rono" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="w-id">{t("idNumber")}</FieldLabel>
                <Input id="w-id" inputMode="numeric" defaultValue="41234567" required />
              </Field>
              <Field data-invalid={underage || undefined}>
                <FieldLabel htmlFor="w-dob">{t("dob")}</FieldLabel>
                <Input
                  id="w-dob"
                  type="date"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                  aria-invalid={underage}
                  required
                />
                {underage ? (
                  <FieldError>{t("underage", { age: age ?? 0 })}</FieldError>
                ) : (
                  <FieldDescription>{t("dobHint")}</FieldDescription>
                )}
              </Field>
              <Field data-invalid={!normalised || undefined}>
                <FieldLabel htmlFor="w-phone">{t("phone")}</FieldLabel>
                <Input
                  id="w-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  aria-invalid={!normalised}
                />
                {normalised ? (
                  <FieldDescription>{t("phoneNormalised", { phone: normalised })}</FieldDescription>
                ) : (
                  <FieldError>{t("phoneInvalid")}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="w-trade">{t("trade")}</FieldLabel>
                <Select defaultValue="mason">
                  <SelectTrigger id="w-trade" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {trades.map((trade) => (
                      <SelectItem key={trade} value={trade}>
                        {tTrades(trade)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="w-rate">{t("rate")}</FieldLabel>
                <Input id="w-rate" inputMode="numeric" defaultValue="1,500" />
                <FieldDescription>{t("rateHint")}</FieldDescription>
              </Field>
            </div>
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {t("encryptionNote")}
            </p>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                {t("cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={underage || !normalised}>
              {t("next")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
