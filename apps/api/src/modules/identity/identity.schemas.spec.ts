import { describe, expect, it } from "vitest";
import {
  identifierSchema,
  passwordSchema,
  inviteSchema,
  assignmentSchema,
  registerSchema,
} from "./identity.schemas.js";
import { hashPassword, verifyPassword } from "./auth-security.service.js";

describe("Foundation input and password contracts", () => {
  it("normalizes emails and Kenyan mobile identifiers", () => {
    expect(identifierSchema.parse(" Person@Example.com ")).toBe("person@example.com");
    expect(identifierSchema.parse("+254 712 345678")).toBe("254712345678");
    expect(identifierSchema.parse("0712345678")).toBe("254712345678");
    expect(identifierSchema.parse("0112345678")).toBe("254112345678");
    expect(identifierSchema.safeParse("not-an-identifier").success).toBe(false);
    expect(identifierSchema.safeParse("+1 555 123 4567").success).toBe(false);
  });
  it("enforces password bounds and rejects common passwords without composition requirements", () => {
    expect(passwordSchema.safeParse("password1234").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("an uncommon long phrase for construction").success).toBe(true);
  });
  it("rejects mass assignment and unsupported roles or permissions", () => {
    expect(
      registerSchema.safeParse({
        identifier: "person@example.test",
        password: "uncommon valid long phrase",
        displayName: "A",
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      inviteSchema.safeParse({ identifier: "person@example.test", role: "platform_admin" }).success,
    ).toBe(false);
    expect(assignmentSchema.safeParse({ permissions: ["payment.approve"] }).success).toBe(false);
    expect(assignmentSchema.parse({ permissions: ["projects.view", "projects.manage"] })).toEqual({
      permissions: ["projects.view", "projects.manage"],
    });
    expect(assignmentSchema.safeParse({ permissions: ["project.read"] }).success).toBe(false);
    expect(assignmentSchema.safeParse({ permissions: ["project.update"] }).success).toBe(false);
  });
  it("uses salted Argon2id hashes and verifies without custom crypto", async () => {
    const password = "A sufficiently uncommon valid phrase";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).toMatch(/^\$argon2id\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, "Not the correct password")).toBe(false);
  });
});
