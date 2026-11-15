/**
 * Payment callback paths carry an unguessable per-company token (D4.2): `/payments/hooks/<token>/<kind>`.
 * Request logs and traces keep only the endpoint kind.
 */
const CALLBACK_TOKEN = /(\/payments\/hooks\/)[^/?#\s"]+/g;

export const redactCallbackPath = (value: string) => value.replace(CALLBACK_TOKEN, "$1[REDACTED]");
