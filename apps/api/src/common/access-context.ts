/**
 * Who made a request, noted when the API resolves its signed-in session (AuthService.principal),
 * for the access log and the request log line. Keyed by the request object, so nothing outlives
 * the request.
 */
export type AccessIdentity = {
  userId: string;
  sessionId: string;
  /** The company selected when the request was made; null outside a company. */
  tenantId: string | null;
  authMethod: string;
  /** The matched route template (`/api/v1/projects/:id`), never the concrete path. */
  route: string | null;
  params: Readonly<Record<string, unknown>>;
  /** The parsed query; the access log keeps only its UUID values. */
  query: Readonly<Record<string, unknown>>;
};

type RoutedRequest = { route?: unknown; params?: unknown; query?: unknown };
type SessionPrincipal = {
  user: { id: string };
  session: { id: string; activeTenantId: string | null; authMethod: string };
};

const identities = new WeakMap<object, AccessIdentity>();
const plain = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};

export function noteAccess(req: RoutedRequest, principal: SessionPrincipal): void {
  const route = (req.route as { path?: unknown } | undefined)?.path;
  identities.set(req, {
    userId: principal.user.id,
    sessionId: principal.session.id,
    tenantId: principal.session.activeTenantId,
    authMethod: principal.session.authMethod,
    route: typeof route === "string" ? route : null,
    params: plain(req.params),
    query: plain(req.query),
  });
}

export const accessIdentity = (req: object): AccessIdentity | undefined => identities.get(req);
