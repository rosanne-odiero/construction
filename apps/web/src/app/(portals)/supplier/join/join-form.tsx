"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LoaderCircle } from "lucide-react";
import { normalizeKenyanPhone } from "@pm-buddy/domain";
import { authResponseSchema, messageResponseSchema, type AuthResponse } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FoundationApiError, foundationRequest } from "@/lib/foundation-api";
import { postWithCsrf } from "@/lib/csrf-post";

type Failure =
  | "invalidLink"
  | "weakPassword"
  | "invalidCode"
  | "identifier"
  | "rateLimited"
  | "network"
  | "unexpected";

const passwordCodes = new Set(["password-too-weak", "password-breached"]);

/** An email address (lower-cased) or a Kenyan mobile number (normalised); null otherwise. */
export function joinIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.includes("@"))
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
  return normalizeKenyanPhone(trimmed);
}

/**
 * A supplier contact's invitation link (D7.2): signed in, accept it; otherwise create an account
 * (email or phone, name, password, then the verification code) or sign in and come back. After
 * accepting, sign-in selects the company and opens the supplier portal.
 */
export function SupplierJoinForm({ token }: { token: string | null }) {
  const t = useTranslations("supplierPortal.join");
  const router = useRouter();
  const [account, setAccount] = useState<AuthResponse | null | undefined>(undefined);
  const [step, setStep] = useState<"create" | "code">("create");
  const [identifier, setIdentifier] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const normalised = joinIdentifier(identifier);
  const next = token ? `/supplier/join?token=${token}` : "/supplier";

  useEffect(() => {
    let active = true;
    foundationRequest("/auth/me", authResponseSchema)
      .then((value) => active && setAccount(value))
      .catch(() => active && setAccount(null));
    return () => {
      active = false;
    };
  }, []);

  async function run(operation: () => Promise<void>, onError: (error: unknown) => Failure) {
    setBusy(true);
    setFailure(null);
    try {
      await operation();
    } catch (error) {
      setFailure(onError(error));
    } finally {
      setBusy(false);
    }
  }
  const common = (error: unknown): Failure => {
    if (!(error instanceof FoundationApiError)) return "unexpected";
    if (error.status === 429) return "rateLimited";
    if (error.code === "network") return "network";
    return "unexpected";
  };
  const acceptFailure = (error: unknown): Failure =>
    error instanceof FoundationApiError && [401, 404, 409].includes(error.status)
      ? "invalidLink"
      : common(error);
  const accept = async () => {
    await postWithCsrf("/tenants/invitations/accept", messageResponseSchema, { token });
    router.replace("/sign-in?next=%2Fsupplier");
    router.refresh();
  };

  const alert = failure ? (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <p>{t(`errors.${failure}`)}</p>
      {failure === "invalidCode" ? (
        <Link className="font-medium underline" href={`/sign-in?next=${encodeURIComponent(next)}`}>
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
          {account ? t("signedInAs", { name: account.user.displayName }) : t("description")}
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
            <Button disabled={busy} onClick={() => void run(accept, acceptFailure)}>
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
                }, common)
              }
            >
              {t("anotherAccount")}
            </Button>
          </FieldGroup>
        ) : step === "create" ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalised) return setFailure("identifier");
              void run(
                async () => {
                  await postWithCsrf("/auth/register", messageResponseSchema, {
                    identifier: normalised,
                    displayName: name.trim(),
                    password,
                  });
                  setStep("code");
                },
                (error) =>
                  error instanceof FoundationApiError && passwordCodes.has(error.code)
                    ? "weakPassword"
                    : error instanceof FoundationApiError && error.status === 400
                      ? "weakPassword"
                      : common(error),
              );
            }}
          >
            <FieldGroup>
              <h2 className="text-base font-semibold">{t("createTitle")}</h2>
              {alert}
              <Field>
                <FieldLabel htmlFor="join-identifier">{t("identifier")}</FieldLabel>
                <Input
                  id="join-identifier"
                  autoComplete="username"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  aria-describedby="join-identifier-hint"
                  required
                />
                <FieldDescription id="join-identifier-hint">{t("identifierHint")}</FieldDescription>
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
                <FieldLabel htmlFor="join-password">{t("password")}</FieldLabel>
                <Input
                  id="join-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-describedby="join-password-hint"
                  required
                />
                <FieldDescription id="join-password-hint">{t("passwordHint")}</FieldDescription>
              </Field>
              <Button type="submit" disabled={busy || !name.trim() || password.length < 12}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {t("create")}
              </Button>
              <p className="text-sm">
                {t("haveAccount")}{" "}
                <Link className="underline" href={`/sign-in?next=${encodeURIComponent(next)}`}>
                  {t("signIn")}
                </Link>
              </p>
            </FieldGroup>
          </form>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                async () => {
                  await postWithCsrf("/auth/verify", messageResponseSchema, {
                    identifier: normalised,
                    code: code.trim(),
                    password,
                  });
                  await postWithCsrf("/auth/login", authResponseSchema, {
                    identifier: normalised,
                    password,
                  });
                  setPassword("");
                  await accept();
                },
                (error) =>
                  error instanceof FoundationApiError && error.status === 401
                    ? "invalidCode"
                    : error instanceof FoundationApiError && error.status === 404
                      ? "invalidLink"
                      : common(error),
              );
            }}
          >
            <FieldGroup>
              {alert}
              <Field>
                <FieldLabel htmlFor="join-code">{t("code")}</FieldLabel>
                <Input
                  id="join-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                  aria-describedby="join-code-hint"
                  required
                />
                <FieldDescription id="join-code-hint">
                  {t("codeHint", { identifier: normalised ?? "" })}
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={busy || code.length !== 6}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
                {t("verify")}
              </Button>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
