"use client";

import { useEffect, useState, type HTMLInputTypeAttribute, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import {
  authResponseSchema,
  auditEventsResponseSchema,
  createRoleRequestSchema,
  csrfResponseSchema,
  invitationResponseSchema,
  memberRoleRequestSchema,
  membersResponseSchema,
  messageResponseSchema,
  mfaEnrollmentResponseSchema,
  mfaVerificationResponseSchema,
  passkeyAuthenticationOptionsResponseSchema,
  passkeyRegistrationOptionsResponseSchema,
  passkeyRegistrationResponseSchema,
  passkeysResponseSchema,
  permissionCatalogueResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  roleReferenceSchema,
  roleResponseSchema,
  rolesResponseSchema,
  sessionsResponseSchema,
  tenantCreatedResponseSchema,
  tenantRoleSchema,
  tenantsResponseSchema,
  updateRoleRequestSchema,
  type Passkey,
  type PermissionCatalogueResponse,
  type Role,
} from "@pm-buddy/validation";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FoundationApiError, foundationRequest } from "@/lib/foundation-api";
import { formatDateTime } from "@/lib/format";
import type { Messages } from "@pm-buddy/i18n";
import { PasskeysPanel } from "./passkeys-panel";
import { RolesPanel, useRoleLabel, type RoleDraft } from "./roles-panel";

type NoticeKey = keyof Messages["foundation"]["notices"];
type Account = z.infer<typeof authResponseSchema>;
type Tenant = z.infer<typeof tenantsResponseSchema>["tenants"][number];
type Project = z.infer<typeof projectsResponseSchema>["projects"][number];
type Session = z.infer<typeof sessionsResponseSchema>["sessions"][number];
type Member = z.infer<typeof membersResponseSchema>["members"][number];
type AuditEvent = z.infer<typeof auditEventsResponseSchema>["events"][number];
type Enrollment = z.infer<typeof mfaEnrollmentResponseSchema>;
type InputField = {
  name: string;
  label: string;
  type?: HTMLInputTypeAttribute;
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

function value(data: FormData, key: string): string {
  const result = data.get(key);
  if (typeof result !== "string") throw new FoundationApiError(400, "validation-error");
  return result;
}

function ActionForm({
  id,
  title,
  submit,
  fields,
  disabled,
  onSubmit,
  children,
  footer,
}: {
  id: string;
  title: string;
  submit: string;
  fields: InputField[];
  disabled: boolean;
  onSubmit: (data: FormData) => void;
  children?: ReactNode;
  /** Shown below the form, outside it (for example another way to complete the step). */
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(new FormData(event.currentTarget));
          }}
        >
          <fieldset disabled={disabled} className="space-y-4">
            {fields.map((field) => (
              <Field key={field.name}>
                <FieldLabel htmlFor={`${id}-${field.name}`}>{field.label}</FieldLabel>
                <Input
                  id={`${id}-${field.name}`}
                  name={field.name}
                  type={field.type ?? "text"}
                  autoComplete={field.autoComplete ?? "off"}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  pattern={field.pattern}
                  inputMode={field.name === "code" && field.pattern ? "numeric" : undefined}
                  required
                />
              </Field>
            ))}
            {children}
            <Button type="submit">{submit}</Button>
          </fieldset>
        </form>
        {footer ? <div className="mt-4">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}

function errorKey(error: unknown) {
  if (!(error instanceof FoundationApiError)) return "unexpected";
  switch (error.code) {
    case "network":
      return "network";
    case "invalidResponse":
      return "invalidResponse";
    case "validation-error":
      return "validation";
    case "unauthorized":
      return "unauthorized";
    case "forbidden":
    case "step-up-required":
      return "forbidden";
    case "not-found":
      return "notFound";
    case "conflict":
      return "conflict";
    case "rate-limited":
      return "rateLimited";
    case "service-unavailable":
      return "unavailable";
    case "password-too-weak":
      return "passwordWeak";
    case "password-breached":
      return "passwordBreached";
    case "passkey-invalid":
      return "passkeyInvalid";
    case "passkey-cancelled":
      return "passkeyCancelled";
    default:
      return "unexpected";
  }
}

/**
 * Runs the browser's WebAuthn ceremony. A cancelled, timed-out or unsupported prompt becomes one
 * local error; nothing is sent to the API in that case.
 */
async function ceremony<T>(prompt: () => Promise<T>): Promise<T> {
  try {
    return await prompt();
  } catch {
    throw new FoundationApiError(0, "passkey-cancelled");
  }
}

/** `google`: the API offers "Continue with Google" (shown on the create-account card). */
export function FoundationConsole({ google = false }: { google?: boolean }) {
  const t = useTranslations("foundation");
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    key: ReturnType<typeof errorKey>;
    traceId?: string;
  } | null>(null);
  const [notice, setNotice] = useState<NoticeKey | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [catalogue, setCatalogue] = useState<PermissionCatalogueResponse | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    foundationRequest("/auth/me", authResponseSchema)
      .then((result) => {
        if (active) setAccount(result);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof FoundationApiError && error.status === 401) {
          setAccount(null);
        } else {
          setFailure({
            key: errorKey(error),
            traceId: error instanceof FoundationApiError ? error.traceId : undefined,
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function clearWorkspace() {
    setTenants([]);
    setProjects([]);
    setSessions([]);
    setMembers([]);
    setAudit([]);
    setRoles([]);
    setCatalogue(null);
    setPasskeys([]);
  }

  function applyAccount(next: Account | null) {
    setAccount(next);
    clearWorkspace();
    setEnrollment(null);
    setRecoveryCodes([]);
  }

  async function run(key: string, operation: () => Promise<void>, success?: NoticeKey) {
    if (busy) return;
    setBusy(key);
    setFailure(null);
    setNotice(null);
    try {
      await operation();
      if (success) setNotice(success);
    } catch (error) {
      if (
        error instanceof FoundationApiError &&
        error.status === 401 &&
        ![
          "login",
          "mfa",
          "recovery",
          "enroll",
          "register",
          "verify",
          "forgot",
          "reset",
          "resend",
          "passkeyRegister",
          "passkeyStepUp",
        ].includes(key)
      ) {
        applyAccount(null);
      }
      setFailure({
        key: errorKey(error),
        traceId: error instanceof FoundationApiError ? error.traceId : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  async function mutate<T>(
    path: string,
    schema: z.ZodType<T>,
    body: Record<string, unknown> = {},
    method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  ) {
    const { csrfToken } = await foundationRequest("/auth/csrf", csrfResponseSchema);
    return foundationRequest(path, schema, {
      method,
      body,
      headers: { "X-CSRF-Token": csrfToken },
    });
  }

  async function loadWorkspace() {
    clearWorkspace();
    const current = await foundationRequest("/auth/me", authResponseSchema);
    setAccount(current);
    if (current.mfaRequired) throw new FoundationApiError(403, "forbidden");
    const companies = await foundationRequest("/tenants", tenantsResponseSchema);
    setTenants(companies.tenants);
    if (current.session.tenantId) {
      const result = await foundationRequest("/projects", projectsResponseSchema);
      setProjects(result.projects);
    }
    const result = await foundationRequest("/auth/sessions", sessionsResponseSchema);
    setSessions(result.sessions);
    await loadPasskeys();
  }

  async function loadPasskeys() {
    setPasskeys((await foundationRequest("/auth/passkeys", passkeysResponseSchema)).passkeys);
  }

  function registerPasskey(name: string) {
    void run(
      "passkeyRegister",
      async () => {
        const { options } = await mutate(
          "/auth/passkeys/registration/options",
          passkeyRegistrationOptionsResponseSchema,
        );
        const credential = await ceremony(() => startRegistration({ optionsJSON: options }));
        const result = await mutate(
          "/auth/passkeys/registration",
          passkeyRegistrationResponseSchema,
          {
            name,
            credential,
          },
        );
        applyAccount(result);
        setRecoveryCodes(result.recoveryCodes ?? []);
        if (!result.mfaRequired) await loadPasskeys();
      },
      "passkeyAdded",
    );
  }

  function passkeyStepUp() {
    void run(
      "passkeyStepUp",
      async () => {
        const { options } = await mutate(
          "/auth/passkeys/step-up/options",
          passkeyAuthenticationOptionsResponseSchema,
        );
        const credential = await ceremony(() => startAuthentication({ optionsJSON: options }));
        applyAccount(await mutate("/auth/passkeys/step-up", authResponseSchema, { credential }));
      },
      "mfaVerified",
    );
  }

  function removePasskey(passkey: Passkey) {
    void run(
      "passkeyRemove",
      async () => {
        await mutate(
          `/auth/passkeys/${encodeURIComponent(passkey.id)}`,
          messageResponseSchema,
          {},
          "DELETE",
        );
        setAccount(await foundationRequest("/auth/me", authResponseSchema));
        await loadPasskeys();
      },
      "passkeyRemoved",
    );
  }

  async function loadMembers() {
    setMembers(
      (await foundationRequest("/tenants/current/members", membersResponseSchema)).members,
    );
  }

  async function loadRoles() {
    setCatalogue(await foundationRequest("/permissions", permissionCatalogueResponseSchema));
    setRoles((await foundationRequest("/tenants/current/roles", rolesResponseSchema)).roles);
  }

  async function saveRole(draft: RoleDraft) {
    let saved = false;
    await run(
      "role",
      async () => {
        const input = (draft.id ? updateRoleRequestSchema : createRoleRequestSchema).safeParse({
          name: draft.name,
          permissions: draft.permissions,
          tenantWide: draft.tenantWide,
        });
        if (!input.success) throw new FoundationApiError(400, "validation-error");
        await mutate(
          draft.id
            ? `/tenants/current/roles/${encodeURIComponent(draft.id)}`
            : "/tenants/current/roles",
          roleResponseSchema,
          input.data,
          draft.id ? "PATCH" : "POST",
        );
        await loadRoles();
        saved = true;
      },
      draft.id ? "roleUpdated" : "roleCreated",
    );
    return saved;
  }

  const disabled = busy !== null || loading;
  const activeTenant = tenants.find((tenant) => tenant.id === account?.session.tenantId);
  // UI gating mirrors the API's permission checks; the API remains the authority.
  const held: readonly string[] = activeTenant?.permissions ?? [];
  const can = (permission: string) => held.includes(permission);
  const roleLabel = useRoleLabel();
  const identifier: InputField = {
    name: "identifier",
    label: t("identifier"),
    autoComplete: "username",
    maxLength: 254,
  };
  const password: InputField = {
    name: "password",
    label: t("password"),
    type: "password",
    autoComplete: "current-password",
    minLength: 12,
    maxLength: 128,
  };
  const code: InputField = {
    name: "code",
    label: t("code"),
    autoComplete: "one-time-code",
    pattern: "[0-9]{6}",
    minLength: 6,
    maxLength: 6,
  };
  const token: InputField = {
    name: "token",
    label: t("token"),
    minLength: 43,
    maxLength: 43,
    pattern: "[A-Za-z0-9_-]{43}",
  };
  const name = (label: string): InputField => ({ name: "name", label, maxLength: 150 });

  return (
    <div className="space-y-6" aria-busy={disabled}>
      <p className="rounded border bg-muted p-4 text-sm">{t("development")}</p>
      <div aria-live="polite">
        {loading ? <p role="status">{t("loading")}</p> : null}
        {busy ? <p role="status">{t("working")}</p> : null}
        {notice ? (
          <p role="status" className="rounded border p-3">
            {t(`notices.${notice}`)}
          </p>
        ) : null}
      </div>
      {failure ? (
        <div role="alert" className="rounded border border-destructive p-4">
          <p>{t(`errors.${failure.key}`)}</p>
          {failure.traceId ? (
            <p className="mt-1 text-xs">{t("trace", { id: failure.traceId })}</p>
          ) : null}
        </div>
      ) : null}

      {!loading && !account ? (
        <>
          <p>{t("signedOut")}</p>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run("restore", async () => {
                applyAccount(await mutate("/auth/refresh", authResponseSchema));
              })
            }
          >
            {t("refresh")}
          </Button>
          <div className="grid gap-6 md:grid-cols-2">
            <ActionForm
              id="login"
              title={t("signIn")}
              submit={t("signIn")}
              fields={[identifier, password]}
              disabled={disabled}
              onSubmit={(data) =>
                void run(
                  "login",
                  async () => {
                    applyAccount(
                      await mutate("/auth/login", authResponseSchema, {
                        identifier: value(data, "identifier"),
                        password: value(data, "password"),
                      }),
                    );
                  },
                  "signedIn",
                )
              }
            />
            <ActionForm
              id="register"
              title={t("register")}
              submit={t("register")}
              fields={[
                {
                  name: "displayName",
                  label: t("displayName"),
                  autoComplete: "name",
                  maxLength: 100,
                },
                identifier,
                { ...password, autoComplete: "new-password" },
              ]}
              disabled={disabled}
              footer={google ? <GoogleSignInButton next="/foundation" /> : null}
              onSubmit={(data) =>
                void run(
                  "register",
                  async () => {
                    await mutate("/auth/register", messageResponseSchema, {
                      displayName: value(data, "displayName"),
                      identifier: value(data, "identifier"),
                      password: value(data, "password"),
                    });
                  },
                  "instructions",
                )
              }
            />
            <ActionForm
              id="verify"
              title={t("verifyIdentity")}
              submit={t("verify")}
              fields={[identifier, password, code]}
              disabled={disabled}
              onSubmit={(data) =>
                void run(
                  "verify",
                  async () => {
                    await mutate("/auth/verify", messageResponseSchema, {
                      identifier: value(data, "identifier"),
                      password: value(data, "password"),
                      code: value(data, "code"),
                    });
                  },
                  "verified",
                )
              }
            />
            <ActionForm
              id="resend"
              title={t("resend")}
              submit={t("resend")}
              fields={[identifier]}
              disabled={disabled}
              onSubmit={(data) =>
                void run(
                  "resend",
                  async () => {
                    await mutate("/auth/verification/resend", messageResponseSchema, {
                      identifier: value(data, "identifier"),
                    });
                  },
                  "instructions",
                )
              }
            />
            <ActionForm
              id="forgot"
              title={t("forgot")}
              submit={t("requestReset")}
              fields={[identifier]}
              disabled={disabled}
              onSubmit={(data) =>
                void run(
                  "forgot",
                  async () => {
                    await mutate("/auth/password/forgot", messageResponseSchema, {
                      identifier: value(data, "identifier"),
                    });
                  },
                  "instructions",
                )
              }
            />
            <ActionForm
              id="reset"
              title={t("reset")}
              submit={t("reset")}
              fields={[token, { ...password, autoComplete: "new-password" }]}
              disabled={disabled}
              onSubmit={(data) =>
                void run(
                  "reset",
                  async () => {
                    await mutate("/auth/password/reset", messageResponseSchema, {
                      token: value(data, "token"),
                      password: value(data, "password"),
                    });
                    applyAccount(null);
                  },
                  "passwordChanged",
                )
              }
            />
          </div>
        </>
      ) : null}

      {account ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{t("account")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>{t("signedInAs", { name: account.user.displayName })}</p>
              <p className="text-sm">
                {account.mfaRequired
                  ? t("mfaNeeded")
                  : t("mfaStatus", {
                      state: account.session.mfaVerified
                        ? t("verifiedState")
                        : t("notVerifiedState"),
                    })}
              </p>
              <p className="text-sm text-muted-foreground">{t("freshMfaHint")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={disabled || account.mfaRequired}
                  onClick={() => void run("load", loadWorkspace)}
                >
                  {t("loadWorkspace")}
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void run(
                      "refresh",
                      async () => {
                        applyAccount(await mutate("/auth/refresh", authResponseSchema));
                      },
                      "refreshed",
                    )
                  }
                >
                  {t("refresh")}
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void run(
                      "logout",
                      async () => {
                        await mutate("/auth/logout", messageResponseSchema);
                        applyAccount(null);
                      },
                      "signedOut",
                    )
                  }
                >
                  {t("signOut")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            {!account.user.totpEnabled ? (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2>{t("enrollMfa")}</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm">{t("enrollHint")}</p>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      void run("enroll", async () => {
                        setEnrollment(
                          await mutate("/auth/mfa/enroll", mfaEnrollmentResponseSchema),
                        );
                      })
                    }
                  >
                    {t("enrollMfa")}
                  </Button>
                  {enrollment ? (
                    <div className="space-y-2">
                      <p className="text-sm">{t("secretHint")}</p>
                      <code className="block break-all rounded bg-muted p-3">
                        {enrollment.secret}
                      </code>
                      <Field>
                        <FieldLabel htmlFor="authenticator-uri">{t("authenticatorUri")}</FieldLabel>
                        <Input id="authenticator-uri" value={enrollment.uri} readOnly />
                      </Field>
                      <Button variant="outline" onClick={() => setEnrollment(null)}>
                        {t("hideSecret")}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
            <ActionForm
              id="mfa"
              title={account.user.totpEnabled ? t("stepUp") : t("confirmEnrollment")}
              submit={t("verify")}
              fields={[code]}
              disabled={disabled}
              onSubmit={(data) =>
                void run(
                  "mfa",
                  async () => {
                    if (account.user.totpEnabled) {
                      applyAccount(
                        await mutate("/auth/mfa/step-up", authResponseSchema, {
                          code: value(data, "code"),
                        }),
                      );
                    } else {
                      const result = await mutate(
                        "/auth/mfa/verify",
                        mfaVerificationResponseSchema,
                        { code: value(data, "code") },
                      );
                      applyAccount(result);
                      setRecoveryCodes(result.recoveryCodes);
                    }
                  },
                  "mfaVerified",
                )
              }
            />
            {account.user.mfaEnabled ? (
              <ActionForm
                id="recovery"
                title={t("recoverMfa")}
                submit={t("recoverMfa")}
                fields={[{ name: "code", label: t("recoveryCode"), minLength: 16, maxLength: 64 }]}
                disabled={disabled}
                onSubmit={(data) =>
                  void run(
                    "recovery",
                    async () => {
                      applyAccount(
                        await mutate("/auth/mfa/recover", authResponseSchema, {
                          code: value(data, "code"),
                        }),
                      );
                    },
                    "mfaVerified",
                  )
                }
              />
            ) : null}
            <PasskeysPanel
              passkeys={passkeys}
              registered={account.user.passkeys}
              disabled={disabled}
              onRegister={registerPasskey}
              onStepUp={passkeyStepUp}
              onRemove={removePasskey}
            />
          </div>
          {recoveryCodes.length ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>{t("recoveryCodes")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p>{t("recoveryHint")}</p>
                <ul className="grid gap-2 font-mono text-sm sm:grid-cols-2">
                  {recoveryCodes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <Button onClick={() => setRecoveryCodes([])}>{t("savedCodes")}</Button>
              </CardContent>
            </Card>
          ) : null}

          {!account.mfaRequired ? (
            <>
              <div className="grid gap-6 md:grid-cols-2">
                <ActionForm
                  id="company"
                  title={t("createCompany")}
                  submit={t("createCompany")}
                  fields={[name(t("companyName"))]}
                  disabled={disabled}
                  onSubmit={(data) =>
                    void run(
                      "company",
                      async () => {
                        await mutate("/tenants", tenantCreatedResponseSchema, {
                          name: value(data, "name"),
                        });
                        applyAccount(await foundationRequest("/auth/me", authResponseSchema));
                        await loadWorkspace();
                      },
                      "companyCreated",
                    )
                  }
                />
                <ActionForm
                  id="accept"
                  title={t("acceptInvitation")}
                  submit={t("acceptInvitation")}
                  fields={[token]}
                  disabled={disabled}
                  onSubmit={(data) =>
                    void run(
                      "accept",
                      async () => {
                        await mutate("/tenants/invitations/accept", messageResponseSchema, {
                          token: value(data, "token"),
                        });
                        await loadWorkspace();
                      },
                      "invitationAccepted",
                    )
                  }
                />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2>{t("companies")}</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="mb-3 text-sm text-muted-foreground">{t("loadHint")}</p>
                  <ul className="space-y-3">
                    {tenants.map((tenant) => (
                      <li
                        key={tenant.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
                      >
                        <span>
                          {tenant.name}{" "}
                          <span className="text-sm text-muted-foreground">
                            ({roleLabel(tenant.role, tenant.roleName)})
                          </span>
                        </span>
                        <Button
                          variant="outline"
                          disabled={disabled || tenant.id === account.session.tenantId}
                          onClick={() =>
                            void run(
                              "select",
                              async () => {
                                applyAccount(
                                  await mutate(
                                    `/tenants/${encodeURIComponent(tenant.id)}/select`,
                                    authResponseSchema,
                                  ),
                                );
                                await loadWorkspace();
                              },
                              "companySelected",
                            )
                          }
                        >
                          {tenant.id === account.session.tenantId ? t("selected") : t("select")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              {account.session.tenantId ? (
                <>
                  {can("projects.create") ? (
                    <ActionForm
                      id="project"
                      title={t("createProject")}
                      submit={t("createProject")}
                      fields={[name(t("projectName"))]}
                      disabled={disabled}
                      onSubmit={(data) =>
                        void run(
                          "project",
                          async () => {
                            await mutate("/projects", projectResponseSchema, {
                              name: value(data, "name"),
                            });
                            await loadWorkspace();
                          },
                          "projectCreated",
                        )
                      }
                    />
                  ) : null}
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        <h2>{t("projects")}</h2>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {projects.map((project) => (
                          <li key={project.id} className="rounded border p-3">
                            {project.name}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                  {can("users.invite") ? (
                    <ActionForm
                      id="invite"
                      title={t("invite")}
                      submit={t("invite")}
                      fields={[identifier]}
                      disabled={disabled}
                      onSubmit={(data) =>
                        void run(
                          "invite",
                          async () => {
                            const projectIds = data.getAll("projectIds");
                            if (!projectIds.every((id): id is string => typeof id === "string"))
                              throw new FoundationApiError(400, "validation-error");
                            const role = roleReferenceSchema.safeParse(value(data, "role"));
                            if (!role.success)
                              throw new FoundationApiError(400, "validation-error");
                            await mutate("/tenants/current/invitations", invitationResponseSchema, {
                              identifier: value(data, "identifier"),
                              role: role.data,
                              projectIds,
                            });
                          },
                          "invitationSent",
                        )
                      }
                    >
                      <Field>
                        <FieldLabel htmlFor="invite-role">{t("role")}</FieldLabel>
                        <select
                          id="invite-role"
                          name="role"
                          className="h-10 rounded border bg-background px-3"
                          defaultValue="project_manager"
                        >
                          {roles.length
                            ? roles
                                .filter((role) => role.assignable)
                                .map((role) => (
                                  <option key={role.id} value={role.id}>
                                    {roleLabel(role.id, role.name)}
                                  </option>
                                ))
                            : tenantRoleSchema.options.map((role) => (
                                <option key={role} value={role}>
                                  {t(`roles.${role}`)}
                                </option>
                              ))}
                        </select>
                      </Field>
                      <fieldset className="space-y-2">
                        <legend className="mb-2 text-sm font-medium">
                          {t("assignedProjects")}
                        </legend>
                        {projects.map((project) => (
                          <label key={project.id} className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="projectIds" value={project.id} />
                            {project.name}
                          </label>
                        ))}
                      </fieldset>
                    </ActionForm>
                  ) : null}
                  {can("users.invite") || can("roles.manage") || can("audit.view") ? (
                    <div className="flex flex-wrap gap-2">
                      {can("users.invite") || can("roles.manage") ? (
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() => void run("members", loadMembers)}
                        >
                          {t("loadMembers")}
                        </Button>
                      ) : null}
                      {can("audit.view") ? (
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() =>
                            void run("audit", async () =>
                              setAudit(
                                (
                                  await foundationRequest(
                                    "/tenants/current/audit",
                                    auditEventsResponseSchema,
                                  )
                                ).events,
                              ),
                            )
                          }
                        >
                          {t("loadAudit")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {members.length ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          <h2>{t("members")}</h2>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-3">
                          {members.map((member) => (
                            <li
                              key={member.userId}
                              className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"
                            >
                              <span>
                                {member.user.displayName}{" "}
                                <span className="text-sm text-muted-foreground">
                                  ({roleLabel(member.role, member.roleName)})
                                </span>
                              </span>
                              {can("roles.manage") ? (
                                <Button
                                  variant="outline"
                                  disabled={disabled || member.userId === account.user.id}
                                  onClick={() =>
                                    void run(
                                      "remove",
                                      async () => {
                                        await mutate(
                                          `/tenants/current/members/${encodeURIComponent(member.userId)}`,
                                          messageResponseSchema,
                                          {},
                                          "DELETE",
                                        );
                                        await loadMembers();
                                      },
                                      "memberRemoved",
                                    )
                                  }
                                >
                                  {t("removeMember", { name: member.user.displayName })}
                                </Button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  ) : null}
                  {can("users.invite") && members.length && projects.length ? (
                    <ActionForm
                      id="assignment"
                      title={t("assignPermissions")}
                      submit={t("assignPermissions")}
                      fields={[]}
                      disabled={disabled}
                      onSubmit={(data) =>
                        void run(
                          "assign",
                          async () => {
                            const access = value(data, "access");
                            if (!["none", "read", "manage"].includes(access))
                              throw new FoundationApiError(400, "validation-error");
                            const permissions =
                              access === "manage"
                                ? ["projects.view", "projects.manage"]
                                : access === "read"
                                  ? ["projects.view"]
                                  : [];
                            await mutate(
                              `/projects/${encodeURIComponent(value(data, "project"))}/members/${encodeURIComponent(value(data, "member"))}`,
                              messageResponseSchema,
                              { permissions },
                              "PUT",
                            );
                          },
                          "permissionsUpdated",
                        )
                      }
                    >
                      <Field>
                        <FieldLabel htmlFor="assignment-project">{t("projectName")}</FieldLabel>
                        <select
                          id="assignment-project"
                          name="project"
                          required
                          className="h-10 rounded border bg-background px-3"
                        >
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="assignment-member">{t("member")}</FieldLabel>
                        <select
                          id="assignment-member"
                          name="member"
                          required
                          className="h-10 rounded border bg-background px-3"
                        >
                          {members.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.user.displayName}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="assignment-access">{t("access")}</FieldLabel>
                        <select
                          id="assignment-access"
                          name="access"
                          className="h-10 rounded border bg-background px-3"
                        >
                          <option value="read">{t("readAccess")}</option>
                          <option value="manage">{t("manageAccess")}</option>
                          <option value="none">{t("noAccess")}</option>
                        </select>
                      </Field>
                    </ActionForm>
                  ) : null}
                  {can("roles.manage") || can("users.invite") ? (
                    <RolesPanel
                      disabled={disabled}
                      held={held}
                      heldTenantWide={activeTenant?.tenantWide ?? false}
                      canManage={can("roles.manage")}
                      roles={roles}
                      catalogue={catalogue}
                      members={members}
                      onLoad={() => void run("roles", loadRoles)}
                      onSave={saveRole}
                      onDelete={(role) =>
                        void run(
                          "deleteRole",
                          async () => {
                            await mutate(
                              `/tenants/current/roles/${encodeURIComponent(role.id)}`,
                              messageResponseSchema,
                              {},
                              "DELETE",
                            );
                            await loadRoles();
                          },
                          "roleDeleted",
                        )
                      }
                      onChangeMemberRole={(userId, role) =>
                        void run(
                          "memberRole",
                          async () => {
                            const body = memberRoleRequestSchema.safeParse({ role });
                            if (!body.success)
                              throw new FoundationApiError(400, "validation-error");
                            await mutate(
                              `/tenants/current/members/${encodeURIComponent(userId)}/role`,
                              messageResponseSchema,
                              body.data,
                              "PUT",
                            );
                            if (userId === account.user.id) {
                              applyAccount(null);
                              return;
                            }
                            await loadMembers();
                            await loadRoles();
                          },
                          "memberRoleChanged",
                        )
                      }
                    />
                  ) : null}
                  {audit.length ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          <h2>{t("audit")}</h2>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-2 text-sm">
                          {audit.map((event) => (
                            <li key={event.id} className="rounded border p-3">
                              <time dateTime={event.createdAt}>
                                {formatDateTime(event.createdAt)}
                              </time>{" "}
                              <span className="font-mono">{event.action}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-3 text-sm text-muted-foreground">{t("auditLimit")}</p>
                      </CardContent>
                    </Card>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {sessions.length ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>{t("sessions")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {sessions.map((session) => (
                    <li
                      key={session.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
                    >
                      <span className="text-sm">
                        {session.current ? t("currentSession") : t("otherSession")} ·{" "}
                        {t("lastSeen", { time: formatDateTime(session.lastSeenAt) })}
                      </span>
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          void run(
                            "revoke",
                            async () => {
                              await mutate(
                                `/auth/sessions/${encodeURIComponent(session.id)}`,
                                messageResponseSchema,
                                {},
                                "DELETE",
                              );
                              if (session.current) applyAccount(null);
                              else
                                setSessions(
                                  (
                                    await foundationRequest(
                                      "/auth/sessions",
                                      sessionsResponseSchema,
                                    )
                                  ).sessions,
                                );
                            },
                            "sessionRevoked",
                          )
                        }
                      >
                        {session.current ? t("revokeCurrent") : t("revokeOther")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
