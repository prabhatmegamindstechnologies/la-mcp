// la-mcp as its own OAuth authorization server, with sign-in checked against the LiveAccess CMS. Nothing is stored:
// client registrations, sign-in requests, codes and tokens are all sealed (see seal.ts). The person's CMS session
// (access token + refresh cookie) travels inside the sealed tokens, so every MCP call reaches the CMS as that person.
import { createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { cmsLogin, cmsLogout, cmsRefresh, type CmsSession, type CmsSignIn, type CmsUser } from "./cms-auth.js";
import { CmsClient, CmsError } from "./cms-client.js";
import { sendLoginPage } from "./login-page.js";
import { Sealer } from "./seal.js";

const REQUEST_TTL_SEC = 10 * 60;
const CODE_TTL_SEC = 60;
/** The CMS ends a session after 7 days at most; the refresh token never outlives that. */
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

type ClientInfo = Omit<OAuthClientInformationFull, "client_id">;

/** What the sign-in page posts back (sealed). */
interface SignInRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}

interface CodePayload {
  cid: string;
  redirectUri: string;
  codeChallenge: string;
  cms: CmsSignIn;
}

interface AccessPayload {
  cid: string;
  exp: number;
  cmsToken: string;
  user: CmsUser;
}

interface RefreshPayload {
  cid: string;
  refreshCookie: string;
  csrfToken: string;
  user: CmsUser;
}

/** What tools get from a verified access token (AuthInfo.extra). */
export interface CmsAuthExtra {
  cmsToken: string;
  user: CmsUser;
}

export interface CmsOAuthOptions {
  cmsBaseUrl: string;
  /** Public origin of this server, e.g. https://la-mcp.vercel.app */
  publicUrl: URL;
  tokenSecret: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** A short, fixed-length id for a (long, sealed) client_id, to bind codes and tokens to the client. */
const fingerprint = (clientId: string) => createHash("sha256").update(clientId).digest("base64url").slice(0, 22);

function checkRedirectUri(uri: string) {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`Invalid redirect URI: ${uri}`);
  }
  if (u.hash) throw new InvalidClientMetadataError("Redirect URIs must not contain a fragment.");
  const loopback = u.protocol === "http:" && LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !loopback) throw new InvalidClientMetadataError("Redirect URIs must use https (or http on localhost).");
}

export class CmsOAuthProvider implements OAuthServerProvider {
  readonly publicUrl: URL;
  readonly resourceUrl: URL;
  readonly cmsBaseUrl: string;
  private readonly sealer: Sealer;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(opts: CmsOAuthOptions) {
    this.publicUrl = new URL(opts.publicUrl.origin);
    this.resourceUrl = new URL("/mcp", this.publicUrl);
    this.cmsBaseUrl = opts.cmsBaseUrl;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sealer = new Sealer(opts.tokenSecret, this.now);
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId: string) => {
      const info = this.sealer.unseal<ClientInfo>("client", clientId);
      return info ? { ...info, client_id: clientId } : undefined;
    },
    registerClient: (client) => {
      if (!client.redirect_uris?.length) throw new InvalidClientMetadataError("At least one redirect URI is required.");
      client.redirect_uris.forEach((u) => checkRedirectUri(String(u)));
      // Only what later steps need, to keep the client_id short.
      const info: ClientInfo = {
        redirect_uris: client.redirect_uris,
        client_name: client.client_name?.slice(0, 120),
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: client.grant_types,
        response_types: client.response_types,
        client_secret: client.client_secret,
        client_secret_expires_at: client.client_secret_expires_at,
        client_id_issued_at: Math.floor(this.now() / 1000),
      };
      return { ...client, ...info, client_id: this.sealer.seal("client", info, 0) };
    },
  };

  /** Shows the sign-in page. The sealed request carries everything the login POST needs. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !this.isOurResource(params.resource)) throw new InvalidGrantError("This server only issues tokens for its own /mcp endpoint.");
    const request: SignInRequest = { clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state };
    sendLoginPage(res, {
      request: this.sealer.seal("request", request, REQUEST_TTL_SEC),
      clientName: client.client_name,
      redirectHost: new URL(params.redirectUri).host,
    });
  }

  /** Reads a sealed sign-in request posted by the sign-in page; null if forged or older than 10 minutes. */
  openSignInRequest(sealed: string) {
    const req = this.sealer.unseal<SignInRequest>("request", sealed);
    if (!req) return null;
    const client = this.clientsStore.getClient(req.clientId) as OAuthClientInformationFull | undefined;
    return client ? { req, client } : null;
  }

  /**
   * Checks the person's CMS email and password. On success returns where to send the browser (with the code);
   * on failure throws CmsError with a message for the sign-in page.
   */
  async signIn(req: SignInRequest, email: string, password: string): Promise<string> {
    const cms = await cmsLogin(this.cmsBaseUrl, email, password, this.fetchFn, this.now);
    const code: CodePayload = { cid: fingerprint(req.clientId), redirectUri: req.redirectUri, codeChallenge: req.codeChallenge, cms };
    const back = new URL(req.redirectUri);
    back.searchParams.set("code", this.sealer.seal("code", code, CODE_TTL_SEC));
    if (req.state !== undefined) back.searchParams.set("state", req.state);
    return back.href;
  }

  private openCode(client: OAuthClientInformationFull, code: string): CodePayload {
    const c = this.sealer.unseal<CodePayload>("code", code);
    if (!c || c.cid !== fingerprint(client.client_id)) throw new InvalidGrantError("The authorization code is invalid or has expired.");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.openCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const c = this.openCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    if (resource && !this.isOurResource(resource)) throw new InvalidGrantError("This server only issues tokens for its own /mcp endpoint.");
    return this.issue(c.cid, c.cms, c.cms.refreshCookie);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const r = this.sealer.unseal<RefreshPayload>("refresh", refreshToken);
    if (!r || r.cid !== fingerprint(client.client_id)) throw new InvalidGrantError("The refresh token is invalid or has expired. Sign in again.");
    if (resource && !this.isOurResource(resource)) throw new InvalidGrantError("This server only issues tokens for its own /mcp endpoint.");
    let session: CmsSession;
    try {
      session = await cmsRefresh(this.cmsBaseUrl, r.refreshCookie, this.fetchFn, this.now);
    } catch (err) {
      // An ended CMS session means the person must sign in again; anything else is a temporary failure.
      if (err instanceof CmsError && err.status === 401) throw new InvalidGrantError(err.message);
      throw err;
    }
    return this.issue(r.cid, session, r.refreshCookie);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const a = this.sealer.unseal<AccessPayload>("access", token);
    if (!a) throw new InvalidTokenError("The access token is invalid or has expired.");
    const extra: CmsAuthExtra = { cmsToken: a.cmsToken, user: a.user };
    return { token, clientId: a.cid, scopes: [], expiresAt: Math.floor(a.exp / 1000), resource: this.resourceUrl, extra: { ...extra } };
  }

  /** Revoking a refresh token signs the person out of that CMS session. Access tokens just run out (15 minutes). */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const r = this.sealer.unseal<RefreshPayload>("refresh", request.token);
    if (r && r.cid === fingerprint(client.client_id)) await cmsLogout(this.cmsBaseUrl, r.refreshCookie, r.csrfToken, this.fetchFn);
  }

  /** A CMS client acting as the person behind a verified access token. */
  clientFor(auth: AuthInfo): CmsClient {
    const { cmsToken } = auth.extra as unknown as CmsAuthExtra;
    return new CmsClient({ baseUrl: this.cmsBaseUrl, accessToken: cmsToken }, this.fetchFn, this.now);
  }

  private issue(cid: string, s: CmsSession, refreshCookie: string): OAuthTokens {
    const ttl = Math.max(1, Math.floor((s.accessExpiresAt - this.now()) / 1000));
    const access: AccessPayload = { cid, exp: s.accessExpiresAt, cmsToken: s.accessToken, user: s.user };
    const refresh: RefreshPayload = { cid, refreshCookie, csrfToken: s.csrfToken, user: s.user };
    return {
      access_token: this.sealer.seal("access", access, ttl),
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: this.sealer.seal("refresh", refresh, REFRESH_TTL_SEC),
    };
  }

  private isOurResource(resource: URL) {
    const strip = (u: URL) => `${u.origin}${u.pathname.replace(/\/$/, "")}`;
    return strip(resource) === strip(this.resourceUrl);
  }
}
