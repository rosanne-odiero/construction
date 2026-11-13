import { identifierSchema } from "./identity.schemas.js";

export const GOOGLE_ISSUER = "https://accounts.google.com";
/** Consumer Google addresses: Google is the email provider, so it vouches for ownership. */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export type GoogleProfile = { subject: string; email: string; displayName: string };

const printable = (value: string) =>
  Array.from(value)
    .filter((character) => character >= " " && character !== "\u007f")
    .join("")
    .trim();

/**
 * The account PM-Buddy may sign in from validated ID token claims, or null. Only addresses Google
 * is authoritative for are accepted: verified @gmail.com / @googlemail.com, or a verified Google
 * Workspace address whose `hd` (hosted domain) claim equals the email's domain. A Google account
 * registered with some other provider's address is refused: Google has not proven its ownership.
 */
export function googleProfile(claims: Readonly<Record<string, unknown>>): GoogleProfile | null {
  const { sub, email, email_verified: verified, hd, name } = claims;
  if (typeof sub !== "string" || sub.length < 1 || sub.length > 255 || printable(sub) !== sub)
    return null;
  if (verified !== true || typeof email !== "string" || !email.includes("@")) return null;
  const parsed = identifierSchema.safeParse(email);
  if (!parsed.success || !parsed.data.includes("@")) return null;
  const address = parsed.data;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const authoritative =
    CONSUMER_DOMAINS.has(domain) || (typeof hd === "string" && hd.toLowerCase() === domain);
  if (!authoritative) return null;
  const displayName =
    (typeof name === "string" ? printable(name).slice(0, 100) : "") ||
    address.slice(0, address.lastIndexOf("@")).slice(0, 100);
  return { subject: sub, email: address, displayName };
}
