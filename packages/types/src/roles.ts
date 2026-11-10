/** System roles from brief §3. Tenants may add custom roles later (D1.4). */
export const SYSTEM_ROLES = [
  "platform_admin",
  "owner",
  "project_manager",
  "site_agent",
  "foreman",
  "quantity_surveyor",
  "storekeeper",
  "finance",
  "client",
  "consultant",
  "supplier",
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Roles that must enrol TOTP or a passkey before they can sign in (brief §7; config auth.mfa.required_roles). */
export const MFA_REQUIRED_ROLES: readonly SystemRole[] = ["platform_admin", "owner", "finance"];
