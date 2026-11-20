// Calls the LiveAccess CMS API as one dedicated user. The CMS refreshes tokens through a browser cookie, so this
// client simply signs in again when its token is close to expiry or a call comes back 401.
// The password and token are never put in errors or logs.
import type { CmsConfig } from "./config.js";

const TIMEOUT_MS = 15_000;
/** Sign in again this long before the token's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;
/** After a failed sign-in, wait this long before trying again: 5 wrong passwords lock the CMS account for 15 minutes. */
const LOGIN_COOLDOWN_MS = 60_000;

export class CmsError extends Error {
  constructor(message: string, readonly status: number, readonly fields?: Record<string, string>) {
    super(message);
    this.name = "CmsError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH";

/** OAuth mode: act as the signed-in person with their CMS access token (never signs in by itself). */
export interface CmsUserAuth {
  baseUrl: string;
  accessToken: string;
}

export const SESSION_ENDED = "Your LiveAccess CMS session has ended. Reconnect the LiveAccess connector and sign in again.";

export class CmsClient {
  private token: string | null = null;
  private expiresAt = 0;
  private signingIn: Promise<string> | null = null;
  private loginBlockedUntil = 0;
  private loginBlockedReason = "";
  private readonly cfg: CmsConfig | CmsUserAuth;
  private readonly asUser: boolean;

  constructor(
    cfg: CmsConfig | CmsUserAuth,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    this.cfg = cfg;
    this.asUser = "accessToken" in cfg;
    if ("accessToken" in cfg) {
      this.token = cfg.accessToken;
      this.expiresAt = Number.POSITIVE_INFINITY;
    }
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    if (this.asUser) {
      const res = await this.send(method, path, this.token!, body);
      if (res.status === 401) throw new CmsError(SESSION_ENDED, 401);
      const data = await readJson(res);
      if (!res.ok) throw toError(res.status, data);
      return data as T;
    }
    const hadToken = this.hasFreshToken();
    let res = await this.send(method, path, await this.getToken(), body);
    // A cached token can be ended early (sign-out, password reset). Sign in once more and retry; never loop.
    if (res.status === 401 && hadToken) {
      this.token = null;
      res = await this.send(method, path, await this.getToken(), body);
    }
    const data = await readJson(res);
    if (!res.ok) throw toError(res.status, data);
    return data as T;
  }

  private hasFreshToken() {
    return this.token !== null && this.now() < this.expiresAt - EXPIRY_MARGIN_MS;
  }

  private async getToken(): Promise<string> {
    if (this.hasFreshToken()) return this.token!;
    // Parallel tool calls share one sign-in.
    this.signingIn ??= this.signIn().finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  private async signIn(): Promise<string> {
    const cfg = this.cfg as CmsConfig;
    if (this.now() < this.loginBlockedUntil) {
      const secs = Math.ceil((this.loginBlockedUntil - this.now()) / 1000);
      throw new CmsError(`${this.loginBlockedReason} Not retrying for another ${secs} s.`, 503);
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${cfg.baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: cfg.email, password: cfg.password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw unreachable(err);
    }
    const data = (await readJson(res)) as { accessToken?: unknown; expiresIn?: unknown; passwordChangeRequired?: unknown; error?: unknown } | null;
    if (!res.ok || typeof data?.accessToken !== "string") {
      const reason =
        res.status === 401
          ? "The CMS refused the MCP user's email or password (check CMS_EMAIL / CMS_PASSWORD; 5 failures lock the account for 15 minutes)."
          : data?.passwordChangeRequired
            ? "The MCP user still has a temporary password. Sign in to the CMS admin once as that user and set a new password."
            : `CMS sign-in failed (HTTP ${res.status}).`;
      this.loginBlockedUntil = this.now() + LOGIN_COOLDOWN_MS;
      this.loginBlockedReason = reason;
      throw new CmsError(reason, res.status === 401 ? 401 : 502);
    }
    const ttlSec = typeof data.expiresIn === "number" && data.expiresIn > 0 ? data.expiresIn : 900;
    this.token = data.accessToken;
    this.expiresAt = this.now() + ttlSec * 1000;
    this.loginBlockedUntil = 0;
    return this.token;
  }

  private async send(method: Method, path: string, token: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchFn(`${this.cfg.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw unreachable(err);
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toError(status: number, data: unknown): CmsError {
  const d = data as { error?: unknown; errors?: unknown } | null;
  const message = typeof d?.error === "string" ? d.error : `The CMS answered HTTP ${status}.`;
  const fields =
    d?.errors && typeof d.errors === "object"
      ? Object.fromEntries(Object.entries(d.errors as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
  return new CmsError(message, status, fields);
}

function unreachable(err: unknown): CmsError {
  const timeout = (err as { name?: string })?.name === "TimeoutError";
  return new CmsError(timeout ? "The CMS did not answer within 15 seconds." : "Could not reach the CMS API. Is it running (pnpm dev:api)?", 503);
}
