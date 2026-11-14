import { permanentRedirect } from "next/navigation";

/**
 * The D0 client-portal prototype was replaced by the live client portal (D7.1); old links land
 * there (clients sign in; staff are sent to the office app).
 */
export default function ClientPortalPrototype() {
  permanentRedirect("/portal");
}
