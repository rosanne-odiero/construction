"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LoaderCircle } from "lucide-react";
import { pinProblem, type PinProblem } from "@pm-buddy/domain";
import { authResponseSchema, messageResponseSchema, type AuthResponse } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FoundationApiError, foundationRequest } from "@/lib/foundation-api";
import { postWithCsrf } from "@/lib/csrf-post";
import { normalizeKenyanPhone } from "@/lib/format";

type Failure =
  | "invalidLink"
  | "accountExists"
  | "mismatch"
  | "phone"
  | "rateLimited"
  | "network"
  | "staffInvitation"
  | "unexpected"
  | `pin.${PinProblem}`;

function failureOf(error: unknown): Failure {
  if (!(error instanceof FoundationApiError)) return "unexpected";
  if (error.code === "account-exists") return "accountExists";
  if (error.code === "pin-session-limited") return "staffInvitation";
  if (error.code === "pin-too-weak") return "pin.repeated";
  if (error.status === 401 || error.status === 404) return "invalidLink";
  if (error.status === 429) return "rateLimited";
  if (error.code === "network") return "network";
  return "unexpected";
}

/** Labourer invitation: set a PIN (new account) or, when already signed in, accept. */
export function JoinForm({ token }: { token: string | null }) {
  const t = useTranslations("portals.join");
  const tPin = useTranslations("portals.pinRules");
  const router = useRouter();
  const [account, setAccount] = useState<AuthResponse | null | undefined>(undefined);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const normalised = normalizeKenyanPhone(phone);

  useEffect(() => {
    let active = true;
    foundationRequest("/auth/me", authResponseSchema)
      .then((value) => active && setAccount(value))
      .catch(() => active && setAccount(null));
    return () => {
      active = false;
    };
  }, []);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await operation();
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  }

  const message = (key: Failure) =>
    key.startsWith("pin.")
      ? tPin(key.slice(4) as PinProblem)
      : t(`errors.${key as Exclude<Failure, `pin.${string}`>}`);
  const alert = failure ? (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <p>{message(failure)}</p>
      {failure === "accountExists" && token ? (
        <Link
          className="font-medium underline"
          href={`/sign-in?next=${encodeURIComponent(`/worker/join?token=${token}`)}`}
        >
          {t("signIn")}
        </Link>
      ) : null}
    </div>
  ) : null;

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{t("title")}</h1>
        </CardTitle>
        <CardDescription>
          {account ? t("acceptDescription", { name: account.user.displayName }) : t("description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!token ? (
          <p role="alert" className="text-sm">
            {t("missingToken")}
          </p>
        ) : account === undefined ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> {t("checking")}
          </p>
        ) : account ? (
          <FieldGroup>
            {alert}
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await postWithCsrf("/tenants/invitations/accept", messageResponseSchema, {
                    token,
                  });
                  router.replace("/sign-in?next=%2Fworker");
                  router.refresh();
                })
              }
            >
              {t("accept")}
            </Button>
            <Button
              variant="link"
              className="h-auto px-0"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await postWithCsrf("/auth/logout", messageResponseSchema, {});
                  setAccount(null);
                })
              }
            >
              {t("anotherAccount")}
            </Button>
          </FieldGroup>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalised) return setFailure("phone");
              const problem = pinProblem(pin, normalised);
              if (problem) return setFailure(`pin.${problem}`);
              if (pin !== confirm) return setFailure("mismatch");
              void run(async () => {
                await postWithCsrf("/auth/pin/join", authResponseSchema, {
                  identifier: normalised,
                  token,
                  displayName: name.trim(),
                  pin,
                });
                setPin("");
                setConfirm("");
                router.replace("/worker");
                router.refresh();
              });
            }}
          >
            <FieldGroup>
              {alert}
              <Field>
                <FieldLabel htmlFor="join-phone">{t("phone")}</FieldLabel>
                <Input
                  id="join-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  aria-describedby="join-phone-hint"
                  required
                />
                <FieldDescription id="join-phone-hint">
                  {normalised ? t("phoneNormalised", { phone: normalised }) : t("phoneHint")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="join-name">{t("name")}</FieldLabel>
                <Input
                  id="join-name"
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="join-pin">{t("pin")}</FieldLabel>
                <Input
                  id="join-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  aria-describedby="join-pin-hint"
                  required
                />
                <FieldDescription id="join-pin-hint">{t("pinHint")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="join-confirm">{t("confirmPin")}</FieldLabel>
                <Input
                  id="join-confirm"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ""))}
                  required
                />
              </Field>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {t("submit")}
              </Button>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
