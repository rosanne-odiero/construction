import { z } from "zod";
import { normalizeKenyanPhone } from "@pm-buddy/domain";
import { projectPermissionSchema, roleReferenceSchema } from "@pm-buddy/validation";

export const identifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .transform((value, ctx) => {
    if (value.includes("@")) {
      const email = z.email().safeParse(value.toLowerCase());
      if (email.success) return email.data;
    } else {
      const phone = normalizeKenyanPhone(value);
      if (phone) return phone;
    }
    ctx.addIssue({ code: "custom", message: "Use an email address or Kenyan mobile number" });
    return z.NEVER;
  });

const commonPasswords = new Set([
  "password1234",
  "password12345",
  "password123456",
  "123456789012",
  "1234567890123",
  "qwerty123456",
  "qwertyuiop123",
  "letmein123456",
  "welcome123456",
  "changeme12345",
  "correct horse battery staple",
]);
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => !commonPasswords.has(value.toLowerCase()), "Choose a less common password");
export const registerSchema = z
  .object({
    identifier: identifierSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(100),
  })
  .strict();
export const loginSchema = z
  .object({
    identifier: identifierSchema,
    password: z.string().min(1).max(128),
  })
  .strict();
export const identifierBody = z.object({ identifier: identifierSchema }).strict();
export const verifySchema = z
  .object({
    identifier: identifierSchema,
    code: z.string().regex(/^\d{6}$/),
    password: z.string().min(1).max(128),
  })
  .strict();
export const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const recoverySchema = z.object({ code: z.string().min(16).max(64) }).strict();
export const resetSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: passwordSchema,
  })
  .strict();
export const uuidSchema = z.uuid();
export const nameSchema = z.object({ name: z.string().trim().min(1).max(150) }).strict();
export const inviteSchema = z
  .object({
    identifier: identifierSchema,
    role: roleReferenceSchema,
    projectIds: z.array(uuidSchema).max(100).default([]),
  })
  .strict();
export const acceptSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const assignmentSchema = z
  .object({
    permissions: z.array(projectPermissionSchema).max(projectPermissionSchema.options.length),
  })
  .strict();
