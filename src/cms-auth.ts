// Sign-in calls to the CMS on behalf of one person (OAuth mode). The CMS keeps its session in the `la_refresh` cookie
// (path /<ADMIN_PATH>/api/auth); la-mcp holds that cookie, sealed inside the person's refresh token, and replays it.
import { CmsError } from "./cms-client.js";

const TIMEOUT_MS = 15_000;
const REFRESH_COOKIE = "la_refresh";

export interface CmsUser {
  id: number;
  name: string;
  role: string;
}

export interface CmsSession {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  user: CmsUser;
  csrfToken: string;
}

export interface CmsSignIn extends CmsSession {
  refreshCookie: string;
}

type Fetch = typeof fetch;

async function call(fetchFn: Fetch, url: string, init: RequestInit): Promise<{ res: Response; data: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timeout = (err as { name?: string })?.name === "TimeoutError";
    throw new CmsError(timeout ? "The CMS did not answer in time. Try again." : "The CMS can't be reached right now. Try again later.", 503);
  }
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    /* not JSON */
  }
  return { res, data };
}

function session(data: Record<string, unknown> | null, now: number): CmsSession | null {
  const user = data?.user as Partial<CmsUser & { mustChangePassword: boolean }> | undefined;
  if (typeof data?.accessToken !== "string" || typeof data.csrfToken !== "string" || !user || typeof user.id !== "number") return null;
  const ttl = typeof data.expiresIn === "number" && data.expiresIn > 0 ? data.expiresIn : 900;
  return {
    accessToken: data.accessToken,
    accessExpiresAt: now + ttl * 1000,
    user: { id: user.id, name: String(user.name ?? ""), role: String(user.role ?? "") },
    csrfToken: data.csrfToken,
  };
}

function refreshCookieOf(res: Response): string | null {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq).trim() === REFRESH_COOKIE) return pair!.slice(eq + 1).trim() || null;
  }
  return null;
}

/** Signs a person in. Throws CmsError with a message fit to show on the sign-in page. */
export async function cmsLogin(baseUrl: string, email: string, password: string, fetchFn: Fetch = fetch, now = Date.now): Promise<CmsSignIn> {
  const { res, data } = await call(fetchFn, `${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 401) throw new CmsError("Email or password is wrong.", 401);
  if (!res.ok) throw new CmsError(typeof data?.error === "string" ? data.error : "Sign-in failed. Try again.", res.status);
  if ((data?.user as { mustChangePassword?: boolean } | undefined)?.mustChangePassword) {
    throw new CmsError("You still have a temporary password. Sign in to the LiveAccess CMS admin once to choose a new one, then try again.", 403);
  }
  const s = session(data, now());
  const refreshCookie = refreshCookieOf(res);
  if (!s || !refreshCookie) throw new CmsError("The CMS answered in an unexpected way. Try again later.", 502);
  return { ...s, refreshCookie };
}

/** A new access token for an existing CMS session. 401 means the session has ended (signed out, 8 h idle, 7 days old). */
export async function cmsRefresh(baseUrl: string, refreshCookie: string, fetchFn: Fetch = fetch, now = Date.now): Promise<CmsSession> {
  const { res, data } = await call(fetchFn, `${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { cookie: `${REFRESH_COOKIE}=${refreshCookie}`, accept: "application/json" },
  });
  if (res.status === 401) throw new CmsError("Your LiveAccess CMS session has ended. Sign in again.", 401);
  const s = res.ok ? session(data, now()) : null;
  if (!s) throw new CmsError(typeof data?.error === "string" ? data.error : "The CMS could not renew the session.", res.status === 200 ? 502 : res.status);
  return s;
}

/** Ends the CMS session. Errors are ignored: revocation must not fail loudly. */
export async function cmsLogout(baseUrl: string, refreshCookie: string, csrfToken: string, fetchFn: Fetch = fetch): Promise<void> {
  await call(fetchFn, `${baseUrl}/auth/logout`, {
    method: "POST",
    headers: { cookie: `${REFRESH_COOKIE}=${refreshCookie}`, "x-csrf-token": csrfToken },
  }).catch(() => undefined);
}
