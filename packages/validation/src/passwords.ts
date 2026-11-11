/**
 * Problem codes for a refused new password (registration and reset). They say only "too weak" or
 * "found in a data breach": the strength score and any matched pattern stay on the server.
 */
export const PASSWORD_PROBLEM_CODES = ["password-too-weak", "password-breached"] as const;
export type PasswordProblemCode = (typeof PASSWORD_PROBLEM_CODES)[number];
