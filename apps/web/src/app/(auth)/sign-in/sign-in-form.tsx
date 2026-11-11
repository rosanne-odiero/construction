"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startAuthentication } from "@simplewebauthn/browser";
import type { z } from "zod";
import { Building2, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { PORTAL_HOME, portalFor } from "@pm-buddy/types";
import {
  authResponseSchema,
  csrfResponseSchema,
  messageResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  tenantsResponseSchema,
  type AuthResponse,
  type GoogleSignInOutcome,
  type TenantsResponse,
} from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FoundationApiError, foundationRequest } from "@/lib/foundation-api";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { refreshSession } from "@/lib/live-api";
import { normalizeKenyanPhone } from "@/lib/format";

type Step = "checking" | "credentials" | "mfa" | "enrol" | "company" | "noCompany" | "done";
type Company = TenantsResponse["tenants"][number];
type ErrorKey =
  | "invalidCredentials"
  | "invalidPin"
  | "invalidCode"
  | "rateLimited"
  | "network"
  | "invalidResponse"
  | "passkeyCancelled"
  | "unexpected";

function errorKey(error: unknown, credentials: boolean | "pin"): ErrorKey {
  if (!(error instanceof FoundationApiError)) return "unexpected";
  if (error.code === "passkey-cancelled") return "passkeyCancelled";
  if (error.status === 401 || error.status === 400)
    return credentials === "pin"
      ? "invalidPin"
      : credentials
        ? "invalidCredentials"
        : "invalidCode";
  if (error.status === 429) return "rateLimited";
  if (error.code === "network") return "network";
  if (error.code === "invalidResponse") return "invalidResponse";
  return "unexpected";
}

async function post<T>(path: string, schema: z.ZodType<T>, body: Record<string, unknown> = {}) {
  const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
  return foundationRequest(path, schema, {
    method: "POST",
    body,
    headers: { "X-CSRF-Token": csrfToken },
  });
}

const googleErrors = {
  cancelled: "cancelled",
  unavailable: "unavailable",
  "rate-limited": "rateLimited",
  "email-unsupported": "emailUnsupported",
  "account-conflict": "accountConflict",
  failed: "failed",
} as const satisfies Record<GoogleSignInOutcome, string>;

/**
 * Real sign-in for the office app: password or Google, then TOTP, passkey or recovery-code
 * verification when required, then company selection. Tokens stay in httpOnly cookies set by
 * the API; this component only sees the parsed account summary. `next` is already a safe
 * relative path. Google returns to this page with a session (resumed below) or `googleOutcome`.
 */
export function SignInForm({
  next,
  google = false,
  googleOutcome,
}: {
  next: string;
  google?: boolean;
  googleOutcome?: GoogleSignInOutcome;
}) {
  const t = useTranslations("signIn");
  const router = useRouter();
  const [step, setStep] = useState<Step>("checking");
  const [googleFailure, setGoogleFailure] = useState(googleOutcome);
  const [method, setMethod] = useState<"email" | "phone" | "pin">("email");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [account, setAccount] = useState<AuthResponse | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ErrorKey | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const normalised = normalizeKenyanPhone(phone);

  /** Staff go to `next`; clients and labourers to their own portal (unless `next` is inside it). */
  const finish = useCallback(
    (company?: Company) => {
      const portal = company ? portalFor(company.permissions) : "office";
      const home = PORTAL_HOME[portal];
      const inPortal = next === home || next.startsWith(`${home}/`) || next.startsWith(`${home}?`);
      setStep("done");
      router.replace(portal === "office" || inPortal ? next : home);
      router.refresh();
    },
    [next, router],
  );

  const selectCompany = useCallback(
    async (company: Company) => {
      try {
        setAccount(
          await post(`/tenants/${encodeURIComponent(company.id)}/select`, authResponseSchema),
        );
        finish(company);
      } catch (error) {
        // Companies whose role requires MFA need a verification within the last five minutes.
        if (error instanceof FoundationApiError && error.status === 403) setStep("mfa");
        else throw error;
      }
    },
    [finish],
  );

  const afterAuthentication = useCallback(
    async (current: AuthResponse) => {
      setAccount(current);
      if (current.mfaRequired) {
        setStep(current.user.mfaEnabled ? "mfa" : "enrol");
        return;
      }
      const { tenants } = await foundationRequest("/tenants", tenantsResponseSchema);
      setCompanies(tenants);
      const selected = tenants.find((tenant) => tenant.id === current.session.tenantId);
      if (selected) {
        finish(selected);
      } else if (tenants.length === 1) {
        await selectCompany(tenants[0]!);
      } else {
        setStep(tenants.length ? "company" : "noCompany");
      }
    },
    [finish, selectCompany],
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const current = await foundationRequest("/auth/me", authResponseSchema).catch(
          async (error: unknown) => {
            // An expired access token with a live refresh credential resumes the session.
            if (
              error instanceof FoundationApiError &&
              error.status === 401 &&
              (await refreshSession())
            )
              return foundationRequest("/auth/me", authResponseSchema);
            throw error;
          },
        );
        if (active) await afterAuthentication(current);
      } catch (error) {
        if (!active) return;
        setStep("credentials");
        if (!(error instanceof FoundationApiError && error.status === 401))
          setFailure(errorKey(error, true));
      }
    })();
    return () => {
      active = false;
    };
  }, [afterAuthentication]);

  useEffect(() => {
    if (step !== "checking") heading.current?.focus();
  }, [step]);

  async function run(operation: () => Promise<void>, credentials: boolean | "pin" = false) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setGoogleFailure(undefined);
    try {
      await operation();
    } catch (error) {
      setFailure(errorKey(error, credentials));
    } finally {
      setBusy(false);
    }
  }

  const identifier = method === "email" ? email.trim() : (normalised ?? "");
  const usingPin = method === "pin";
  const status = (
    <div aria-live="polite" className="min-h-0">
      {busy ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> {t("working")}
        </p>
      ) : null}
    </div>
  );
  const alert = failure ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {t(`errors.${failure}`)}
    </p>
  ) : googleFailure ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {t(`googleErrors.${googleErrors[googleFailure]}`)}
    </p>
  ) : null;
  const restart = (
    <Button
      type="button"
      variant="link"
      className="h-auto px-0"
      disabled={busy}
      onClick={() =>
        void run(async () => {
          await post("/auth/logout", messageResponseSchema);
          setAccount(null);
          setCode("");
          setRecoveryCode("");
          setStep("credentials");
        })
      }
    >
      {t("useAnotherAccount")}
    </Button>
  );

  if (step === "checking" || step === "done") {
    return (
      <Card className="w-full max-w-sm">
        <CardContent>
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {step === "done" ? t("redirecting") : t("checking")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (step === "mfa") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <CardTitle className="text-xl">
            <h2 ref={heading} tabIndex={-1} className="outline-none">
              {t("mfaTitle")}
            </h2>
          </CardTitle>
          <CardDescription>
            {t("mfaDescription", { name: account?.user.displayName ?? "" })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {alert}
          {status}
          {recovery ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await afterAuthentication(
                    await post("/auth/mfa/recover", authResponseSchema, {
                      code: recoveryCode.trim(),
                    }),
                  );
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor="recovery-code">{t("recoveryLabel")}</FieldLabel>
                <Input
                  id="recovery-code"
                  autoComplete="one-time-code"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  minLength={16}
                  maxLength={64}
                  required
                />
                <FieldDescription>{t("recoveryHint")}</FieldDescription>
              </Field>
              <Button
                type="submit"
                className="w-full"
                disabled={busy || recoveryCode.trim().length < 16}
              >
                {t("verify")}
              </Button>
            </form>
          ) : account?.user.totpEnabled !== false ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await afterAuthentication(
                    await post("/auth/mfa/step-up", authResponseSchema, { code }),
                  );
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor="otp">{t("codeLabel")}</FieldLabel>
                <InputOTP
                  id="otp"
                  maxLength={6}
                  value={code}
                  onChange={setCode}
                  pattern="^[0-9]*$"
                  autoFocus
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                  </InputOTPGroup>
                  <InputOTPSeparator />
                  <InputOTPGroup>
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
                <FieldDescription>{t("codeHint")}</FieldDescription>
              </Field>
              <Button type="submit" className="w-full" disabled={busy || code.length < 6}>
                {t("verify")}
              </Button>
            </form>
          ) : null}
          <div className="grid gap-2">
            {account && account.user.passkeys > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { options } = await post(
                      "/auth/passkeys/step-up/options",
                      passkeyAuthenticationOptionsResponseSchema,
                    );
                    let credential;
                    try {
                      credential = await startAuthentication({ optionsJSON: options });
                    } catch {
                      throw new FoundationApiError(0, "passkey-cancelled");
                    }
                    await afterAuthentication(
                      await post("/auth/passkeys/step-up", authResponseSchema, { credential }),
                    );
                  })
                }
              >
                <KeyRound aria-hidden /> {t("usePasskey")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setFailure(null);
                setRecovery((value) => !value);
              }}
            >
              {recovery ? t("useCode") : t("useRecovery")}
            </Button>
          </div>
        </CardContent>
        <CardFooter>{restart}</CardFooter>
      </Card>
    );
  }

  if (step === "enrol" || step === "noCompany") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">
            <h2 ref={heading} tabIndex={-1} className="outline-none">
              {step === "enrol" ? t("enrolTitle") : t("noCompanyTitle")}
            </h2>
          </CardTitle>
          <CardDescription>
            {step === "enrol" ? t("enrolDescription") : t("noCompanyDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {alert}
          <Button asChild className="w-full">
            <Link href="/foundation">{t("consoleLink")}</Link>
          </Button>
        </CardContent>
        <CardFooter>{restart}</CardFooter>
      </Card>
    );
  }

  if (step === "company") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">
            <h2 ref={heading} tabIndex={-1} className="outline-none">
              {t("companyTitle")}
            </h2>
          </CardTitle>
          <CardDescription>{t("companyDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {alert}
          {status}
          <ul className="space-y-2" aria-label={t("companyTitle")}>
            {companies.map((company) => (
              <li key={company.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start gap-3 py-3 text-left"
                  disabled={busy}
                  onClick={() => void run(() => selectCompany(company))}
                >
                  <Building2 className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{company.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
        <CardFooter>{restart}</CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">
          <h2 ref={heading} tabIndex={-1} className="outline-none">
            {t("title")}
          </h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!identifier) {
            setFailure(usingPin ? "invalidPin" : "invalidCredentials");
            return;
          }
          if (usingPin) {
            void run(async () => {
              const result = await post("/auth/pin/login", authResponseSchema, { identifier, pin });
              setPin("");
              await afterAuthentication(result);
            }, "pin");
            return;
          }
          void run(async () => {
            const result = await post("/auth/login", authResponseSchema, { identifier, password });
            setPassword("");
            await afterAuthentication(result);
          }, true);
        }}
      >
        <CardContent>
          <FieldGroup>
            {alert}
            <Tabs
              value={method}
              onValueChange={(value) => setMethod(value as "email" | "phone" | "pin")}
            >
              <TabsList className="w-full">
                <TabsTrigger value="email">{t("emailTab")}</TabsTrigger>
                <TabsTrigger value="phone">{t("phoneTab")}</TabsTrigger>
                <TabsTrigger value="pin">{t("pinTab")}</TabsTrigger>
              </TabsList>
              {/* Both panels stay mounted so each tab's aria-controls points at a real panel. */}
              <TabsContent value="email" forceMount hidden={method !== "email"}>
                {method === "email" ? (
                  <Field>
                    <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      maxLength={254}
                      required
                    />
                  </Field>
                ) : null}
              </TabsContent>
              <TabsContent value="phone" forceMount hidden={method !== "phone"}>
                {method === "phone" ? (
                  <Field>
                    <FieldLabel htmlFor="phone">{t("phone")}</FieldLabel>
                    <Input
                      id="phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="username"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      aria-invalid={phone.length > 0 && !normalised}
                      aria-describedby="phone-hint"
                      required
                    />
                    <FieldDescription id="phone-hint">
                      {normalised ? t("phoneNormalised", { phone: normalised }) : t("phoneHint")}
                    </FieldDescription>
                  </Field>
                ) : null}
              </TabsContent>
              <TabsContent value="pin" forceMount hidden={method !== "pin"}>
                {method === "pin" ? (
                  <Field>
                    <FieldLabel htmlFor="pin-phone">{t("phone")}</FieldLabel>
                    <Input
                      id="pin-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="username"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      aria-invalid={phone.length > 0 && !normalised}
                      aria-describedby="pin-phone-hint"
                      required
                    />
                    <FieldDescription id="pin-phone-hint">
                      {normalised ? t("phoneNormalised", { phone: normalised }) : t("pinTabHint")}
                    </FieldDescription>
                  </Field>
                ) : null}
              </TabsContent>
            </Tabs>
            {usingPin ? (
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="pin">{t("pin")}</FieldLabel>
                  <Link
                    href="/worker/pin"
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("forgotPin")}
                  </Link>
                </div>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  maxLength={6}
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  required
                />
              </Field>
            ) : (
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="password">{t("password")}</FieldLabel>
                  <Link
                    href="/foundation"
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("forgot")}
                  </Link>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="pr-10"
                    maxLength={128}
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </Button>
                </div>
              </Field>
            )}
            {status}
            <Button type="submit" className="w-full" disabled={busy}>
              {t("submit")}
            </Button>
            {google && !usingPin ? <GoogleSignInButton next={next} /> : null}
          </FieldGroup>
        </CardContent>
      </form>
      <CardFooter>
        <p className="text-xs text-muted-foreground">
          {t.rich("consoleNote", {
            link: (chunks) => (
              <Link
                href="/foundation"
                className="font-medium text-primary underline underline-offset-4"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      </CardFooter>
    </Card>
  );
}
