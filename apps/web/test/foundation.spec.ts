import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { permissionCatalogue, type Role } from "@pm-buddy/validation";

const userId = "10000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000002";
const tenantId = "10000000-0000-4000-8000-000000000003";
const projectId = "10000000-0000-4000-8000-000000000004";
const memberId = "10000000-0000-4000-8000-000000000005";
const timestamp = "2026-11-10T12:00:00.000Z";
const customRoleId = "10000000-0000-4000-8000-000000000007";
const catalogue = permissionCatalogue();
const tenantPermissions = catalogue.areas.flatMap((area) =>
  area.permissions.filter((entry) => entry.assignable).map((entry) => entry.key),
);
const systemRole = (
  id: "owner" | "project_manager" | "client",
  permissions: Role["permissions"],
  extra: { memberCount?: number; assignable?: boolean } = {},
): Role => ({
  kind: "system",
  id,
  name: null,
  permissions,
  tenantWide: id === "owner",
  mfaRequired: id === "owner",
  memberCount: 1,
  assignable: true,
  ...extra,
});
const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("live UI uses CSRF, validates MFA and wires tenant/project permissions without demo fallbacks", async ({
  page,
}) => {
  let signedIn = false;
  let mfaEnabled = false;
  let companyCreated = false;
  let projectCreated = false;
  let revoked = false;
  let assignedPermissions: unknown;
  let createdRole: unknown;
  let updatedRole: unknown;
  let memberRole: unknown;
  let customRole: Role | null = null;
  const unexpected: string[] = [];
  const account = () => ({
    user: {
      id: userId,
      identifier: "worker@example.invalid",
      displayName: "Synthetic Owner",
      verified: true,
      mfaEnabled,
    },
    session: {
      id: sessionId,
      tenantId: companyCreated ? tenantId : null,
      mfaVerified: mfaEnabled,
      expiresAt: timestamp,
    },
    mfaRequired: false,
  });
  const project = { id: projectId, name: "Synthetic site", createdAt: timestamp };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method !== "GET") expect(request.headers()["x-csrf-token"]).toBe("synthetic-csrf");
    if (path === "/auth/csrf") return json({ csrfToken: "synthetic-csrf" });
    if (path === "/auth/me")
      return signedIn ? json(account()) : json({ code: "unauthorized" }, 401);
    if (path === "/auth/login") {
      expect(request.postDataJSON()).toEqual({
        identifier: "worker@example.invalid",
        password: "synthetic-test-password",
      });
      signedIn = true;
      return json(account());
    }
    if (path === "/auth/mfa/enroll")
      return json({
        secret: "SYNTHETICSECRET",
        uri: "otpauth://totp/PM-Buddy:synthetic?secret=SYNTHETICSECRET",
      });
    if (path === "/auth/mfa/verify") {
      expect(request.postDataJSON()).toEqual({ code: "012345" });
      mfaEnabled = true;
      return json({
        ...account(),
        recoveryCodes: Array.from(
          { length: 10 },
          (_, index) => `synthetic-recovery-code-${String(index + 1).padStart(2, "0")}`,
        ),
      });
    }
    if (path === "/tenants" && method === "POST") {
      expect(mfaEnabled).toBe(true);
      companyCreated = true;
      return json({ tenant: { id: tenantId, name: "Synthetic contractor" } }, 201);
    }
    if (path === "/tenants")
      return json({
        tenants: companyCreated
          ? [
              {
                id: tenantId,
                name: "Synthetic contractor",
                role: "owner",
                roleName: null,
                tenantWide: true,
                permissions: tenantPermissions,
              },
            ]
          : [],
      });
    if (path === "/projects" && method === "POST") {
      expect(request.postDataJSON()).toEqual({ name: "Synthetic site" });
      projectCreated = true;
      return json({ project }, 201);
    }
    if (path === "/projects") return json({ projects: projectCreated ? [project] : [] });
    if (path === "/auth/sessions")
      return json({
        sessions: [
          {
            id: sessionId,
            createdAt: timestamp,
            lastSeenAt: timestamp,
            expiresAt: timestamp,
            current: true,
          },
        ],
      });
    if (path === "/tenants/current/members") {
      if (revoked) return json({ code: "unauthorized", traceId: "synthetic-revocation" }, 401);
      return json({
        members: [
          {
            userId,
            role: "owner",
            roleName: null,
            joinedAt: timestamp,
            user: {
              displayName: "Synthetic Owner",
              identifier: "worker@example.invalid",
              mfaEnabled: true,
            },
          },
          {
            userId: memberId,
            role: memberRole ? customRoleId : "project_manager",
            roleName: memberRole && customRole?.kind === "custom" ? customRole.name : null,
            joinedAt: timestamp,
            user: {
              displayName: "Synthetic Manager",
              identifier: "manager@example.invalid",
              mfaEnabled: false,
            },
          },
        ],
      });
    }
    if (path === "/permissions") return json(catalogue);
    if (path === "/tenants/current/roles" && method === "POST") {
      createdRole = request.postDataJSON();
      customRole = {
        kind: "custom",
        id: customRoleId,
        name: "Site clerk",
        permissions: ["bq.view", "projects.view"],
        tenantWide: false,
        mfaRequired: false,
        memberCount: 0,
        assignable: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return json({ role: customRole }, 201);
    }
    if (path === "/tenants/current/roles")
      return json({
        roles: [
          systemRole("owner", tenantPermissions),
          systemRole("project_manager", ["projects.view", "projects.manage"], {
            memberCount: memberRole ? 0 : 1,
          }),
          systemRole("client", ["projects.view", "bq.view", "portal.client"], { memberCount: 0 }),
          ...(customRole ? [customRole] : []),
        ],
      });
    if (path === `/tenants/current/roles/${customRoleId}` && method === "PATCH") {
      updatedRole = request.postDataJSON();
      customRole = {
        ...customRole!,
        kind: "custom",
        name: "Site clerk lead",
        permissions: ["projects.view"],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return json({ role: customRole });
    }
    if (path === `/tenants/current/roles/${customRoleId}` && method === "DELETE")
      return json({ code: "conflict", traceId: "synthetic-role-in-use" }, 409);
    if (path === `/tenants/current/members/${memberId}/role` && method === "PUT") {
      memberRole = request.postDataJSON();
      customRole = { ...customRole!, memberCount: 1 };
      return json({
        message: "Role changed and the member's active sessions in this company revoked.",
      });
    }
    if (path === `/projects/${projectId}/members/${memberId}` && method === "PUT") {
      assignedPermissions = request.postDataJSON();
      return json({ message: "Project permissions updated." });
    }
    if (path === "/tenants/current/audit")
      return json({
        events: [
          {
            id: "10000000-0000-4000-8000-000000000006",
            tenantId,
            actorId: userId,
            action: "tenant.created",
            resourceId: tenantId,
            requestId: "synthetic-request",
            metadata: {},
            createdAt: timestamp,
            sequence: "1",
            previousHash: "0".repeat(64),
            hash: "a".repeat(64),
          },
        ],
      });
    unexpected.push(`${method} ${path}`);
    return json({ code: "not-found" }, 404);
  });

  await page.goto("/foundation");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.locator("#login-identifier").fill("worker@example.invalid");
  await page.locator("#login-password").fill("synthetic-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Signed in as Synthetic Owner", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up authenticator MFA", exact: true }).click();
  await expect(page.getByText("SYNTHETICSECRET", { exact: true })).toBeVisible();
  await page.locator("#mfa-code").fill("012345");
  await page
    .locator("#mfa-code")
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "Verify", exact: true })
    .click();
  await expect(page.getByText("synthetic-recovery-code-01", { exact: true })).toBeVisible();
  await expect(page.getByText("SYNTHETICSECRET", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "I saved the codes; hide them" }).click();
  await expect(page.getByText("synthetic-recovery-code-01", { exact: true })).toHaveCount(0);
  await page.locator("#company-name").fill("Synthetic contractor");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await expect(page.getByText("Synthetic contractor", { exact: false })).toBeVisible();
  await page.locator("#project-name").fill("Synthetic site");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByText("Project created.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load company members" }).click();
  await page.locator("#assignment-member").selectOption(memberId);
  await page.locator("#assignment-access").selectOption("manage");
  await page.getByRole("button", { name: "Update project access", exact: true }).click();
  await expect(page.getByText("Project permissions updated.", { exact: true })).toBeVisible();
  expect(assignedPermissions).toEqual({ permissions: ["projects.view", "projects.manage"] });

  await page.getByRole("button", { name: "Load roles and permissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Roles and permissions" })).toBeVisible();
  await expect(page.getByText("System role", { exact: true }).first()).toBeVisible();
  await page.locator("#role-name").fill("Site clerk");
  await page.getByRole("checkbox", { name: "View projects", exact: true }).check();
  await page.getByRole("checkbox", { name: "View the BQ", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Approve payments · needs MFA" })).toBeEnabled();
  await page.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(page.getByText("Custom role created.", { exact: true })).toBeVisible();
  expect(createdRole).toEqual({
    name: "Site clerk",
    permissions: ["projects.view", "bq.view"],
    tenantWide: false,
  });
  await expect(page.locator("#role-name")).toHaveValue("");
  await page.getByRole("button", { name: "Edit Site clerk", exact: true }).click();
  await expect(page.locator("#role-name")).toHaveValue("Site clerk");
  await expect(page.getByRole("checkbox", { name: "View the BQ", exact: true })).toBeChecked();
  await page.locator("#role-name").fill("Site clerk lead");
  await page.getByRole("checkbox", { name: "View the BQ", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(page.getByText("Role updated.", { exact: true })).toBeVisible();
  expect(updatedRole).toEqual({
    name: "Site clerk lead",
    permissions: ["projects.view"],
    tenantWide: false,
  });
  await page.locator("#member-role-member").selectOption(memberId);
  await page.locator("#member-role-role").selectOption(customRoleId);
  await page.getByRole("button", { name: "Change a member's role", exact: true }).click();
  await expect(
    page.getByText("Role changed. The member's sessions in this company were signed out.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(memberRole).toEqual({ role: customRoleId });
  await expect(page.getByText("(Site clerk lead)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete Site clerk lead", exact: true }).click();
  await expect(page.locator('main [role="alert"]')).toContainText("deleting roles still in use");
  const rolesScan = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  expect(rolesScan.violations).toEqual([]);
  await page.getByRole("button", { name: "Load audit events" }).click();
  await expect(page.getByText("tenant.created", { exact: true })).toBeVisible();
  const scan = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  expect(scan.violations).toEqual([]);
  revoked = true;
  await page.getByRole("button", { name: "Load company members" }).click();
  await expect(page.locator('main [role="alert"]')).toContainText("could not be verified");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic contractor", { exact: false })).toHaveCount(0);
  await expect(page.getByText("tenant.created", { exact: true })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

for (const locale of ["en", "sw"] as const) {
  test(`signed-out foundation is accessible in ${locale} and refuses malformed success responses`, async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: locale, url: "http://127.0.0.1:3100" },
    ]);
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/problem+json",
        body: JSON.stringify({ code: "unauthorized" }),
      }),
    );
    await page.route("**/api/v1/auth/csrf", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ csrfToken: "synthetic-csrf" }),
      }),
    );
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fakeSuccess: true }),
      }),
    );
    await page.goto("/foundation");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("#login-identifier")).toBeEnabled();
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(scan.violations).toEqual([]);
    await page.locator("#login-identifier").fill("worker@example.invalid");
    await page.locator("#login-password").fill("synthetic-test-password");
    await page
      .locator("#login-password")
      .locator("xpath=ancestor::form")
      .getByRole("button")
      .click();
    await expect(page.locator('main [role="alert"]')).toBeVisible();
    await expect(page.locator("#company-name")).toHaveCount(0);
  });
}

test("roles panel works in Kiswahili and offers a delegated manager only what they hold", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "sw", url: "http://127.0.0.1:3100" }]);
  const held: Role["permissions"] = ["bq.view", "projects.view", "roles.manage", "users.invite"];
  const unexpected: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/me")
      return json({
        user: {
          id: userId,
          identifier: "delegate@example.invalid",
          displayName: "Synthetic Delegate",
          verified: true,
          mfaEnabled: true,
        },
        session: { id: sessionId, tenantId, mfaVerified: true, expiresAt: timestamp },
        mfaRequired: false,
      });
    if (path === "/tenants")
      return json({
        tenants: [
          {
            id: tenantId,
            name: "Kampuni ya majaribio",
            role: customRoleId,
            roleName: "Msimamizi wa timu",
            tenantWide: false,
            permissions: held,
          },
        ],
      });
    if (path === "/projects") return json({ projects: [] });
    if (path === "/auth/sessions") return json({ sessions: [] });
    if (path === "/permissions") return json(catalogue);
    if (path === "/tenants/current/roles")
      return json({
        roles: [
          systemRole("owner", tenantPermissions, { assignable: false }),
          systemRole("client", ["projects.view", "bq.view", "portal.client"], { memberCount: 0 }),
          {
            kind: "custom",
            id: customRoleId,
            name: "Msimamizi wa timu",
            permissions: held,
            tenantWide: false,
            mfaRequired: true,
            memberCount: 1,
            assignable: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
    unexpected.push(path);
    return json({ code: "not-found" }, 404);
  });

  await page.goto("/foundation");
  await expect(page.locator("html")).toHaveAttribute("lang", "sw");
  await page.getByRole("button", { name: "Pakia kampuni, miradi na vipindi" }).click();
  await expect(page.getByText("(Msimamizi wa timu)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unda mradi" })).toHaveCount(0);
  await page.getByRole("button", { name: "Pakia majukumu na ruhusa" }).click();
  await expect(page.getByRole("heading", { name: "Majukumu na ruhusa" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Kuona miradi", exact: true })).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "Kuidhinisha malipo" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Kuidhinisha malipo" })).toHaveAccessibleName(
    "Kuidhinisha malipo · inahitaji MFA · huna ruhusa hii",
  );
  await expect(
    page.getByRole("checkbox", { name: "Linatumika kwa miradi yote ya kampuni" }),
  ).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Usimamizi wa jukwaa" })).toHaveCount(0);
  const scan = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  expect(scan.violations).toEqual([]);
  expect(unexpected).toEqual([]);
});
