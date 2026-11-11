import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

/**
 * A local stand-in for Google's OpenID Connect endpoints (discovery, JWKS, token), so e2e tests
 * run the real openid-client exchange and ID token validation without network access. It
 * enforces what Google enforces for the code flow: single-use codes, client authentication,
 * the registered redirect URI and the PKCE S256 verifier.
 */
export type Tweaks = {
  audience?: string;
  nonce?: string;
  expiresIn?: number;
  /** Sign the ID token with a key that is not in the published JWKS. */
  forge?: boolean;
};
type Grant = { claims: Record<string, unknown>; tweaks: Tweaks; nonce: string; challenge: string };

export class FakeGoogle {
  issuer = "";
  private server!: Server;
  private keys!: { privateKey: CryptoKey; publicKey: CryptoKey };
  private forger!: CryptoKey;
  private readonly codes = new Map<string, Grant>();
  tokenRequests = 0;

  constructor(
    readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  async start(): Promise<void> {
    this.keys = await generateKeyPair("RS256", { extractable: true });
    this.forger = (await generateKeyPair("RS256")).privateKey;
    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const path = new URL(req.url ?? "/", this.issuer).pathname;
          if (path === "/.well-known/openid-configuration")
            return send(200, {
              issuer: this.issuer,
              authorization_endpoint: `${this.issuer}/o/oauth2/v2/auth`,
              token_endpoint: `${this.issuer}/token`,
              jwks_uri: `${this.issuer}/certs`,
              response_types_supported: ["code"],
              subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
            });
          if (path === "/certs")
            return send(200, {
              keys: [
                { ...(await exportJWK(this.keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" },
              ],
            });
          if (path !== "/token" || req.method !== "POST") return send(404, { error: "not_found" });
          this.tokenRequests += 1;
          const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
          const [id, secret] = basic
            ? Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent)
            : [form.get("client_id"), form.get("client_secret")];
          if (id !== this.clientId || secret !== this.clientSecret)
            return send(401, { error: "invalid_client" });
          const code = form.get("code") ?? "";
          const grant = this.codes.get(code);
          this.codes.delete(code);
          const verifier = form.get("code_verifier") ?? "";
          if (
            !grant ||
            form.get("grant_type") !== "authorization_code" ||
            form.get("redirect_uri") !== this.redirectUri ||
            createHash("sha256").update(verifier).digest("base64url") !== grant.challenge
          )
            return send(400, { error: "invalid_grant" });
          const now = Math.floor(Date.now() / 1000);
          const idToken = await new SignJWT({
            ...grant.claims,
            nonce: grant.tweaks.nonce ?? grant.nonce,
          })
            .setProtectedHeader({ alg: "RS256", kid: "k1", typ: "JWT" })
            .setIssuer(this.issuer)
            .setAudience(grant.tweaks.audience ?? this.clientId)
            .setIssuedAt(now)
            .setExpirationTime(now + (grant.tweaks.expiresIn ?? 300))
            .sign(grant.tweaks.forge ? this.forger : this.keys.privateKey);
          send(200, {
            access_token: randomBytes(16).toString("hex"),
            token_type: "Bearer",
            expires_in: 3599,
            scope: "openid email profile",
            id_token: idToken,
          });
        })().catch(() => send(500, { error: "server_error" }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /**
   * The user signs in at "Google": checks the authorisation request the API redirected to and
   * returns the callback path (relative to /api/v1/) Google would redirect the browser to.
   */
  authorize(location: string, claims: Record<string, unknown>, tweaks: Tweaks = {}): string {
    const url = new URL(location);
    const params = url.searchParams;
    if (
      `${url.origin}${url.pathname}` !== `${this.issuer}/o/oauth2/v2/auth` ||
      params.get("client_id") !== this.clientId ||
      params.get("redirect_uri") !== this.redirectUri ||
      params.get("response_type") !== "code" ||
      params.get("code_challenge_method") !== "S256" ||
      !params.get("scope")?.split(" ").includes("openid")
    )
      throw new Error(`Unexpected authorisation request: ${location}`);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, {
      claims,
      tweaks,
      nonce: params.get("nonce") ?? "",
      challenge: params.get("code_challenge") ?? "",
    });
    const callback = new URL(this.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params.get("state") ?? "");
    return `${callback.pathname.replace(/^\/api\/v1\//, "")}${callback.search}`;
  }
}
