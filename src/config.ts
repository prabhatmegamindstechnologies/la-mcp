export interface CmsConfig {
  /** e.g. http://localhost:8787/la-studio/api */
  baseUrl: string;
  email: string;
  password: string;
}

export interface OAuthConfig {
  cmsBaseUrl: string;
  /** Public origin of this server, e.g. https://la-mcp.vercel.app */
  publicUrl: URL;
  tokenSecret: string;
}

/**
 * sample: in-memory sample data, no sign-in (local only).
 * cms:    the CMS as one bot user from .env (local only).
 * oauth:  the CMS as each signed-in person (MCP_PUBLIC_URL is set; this is what runs on Vercel).
 */
export type Config = { mode: "sample" } | { mode: "cms"; cms: CmsConfig } | { mode: "oauth"; oauth: OAuthConfig };

const isLocal = (u: URL) => ["localhost", "127.0.0.1"].includes(u.hostname);

function parseUrl(name: string, value: string | undefined, example: string): URL {
  let url: URL;
  try {
    url = new URL((value ?? "").trim());
  } catch {
    throw new Error(`${name} is not a valid URL, e.g. ${example}`);
  }
  if (url.protocol !== "https:" && !isLocal(url)) throw new Error(`${name} must use https unless it points to localhost.`);
  return url;
}

/** Reads the settings and throws a readable error if something is missing or unsafe. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const has = (k: string) => !!env[k]?.trim();

  if (has("MCP_PUBLIC_URL")) {
    const publicUrl = parseUrl("MCP_PUBLIC_URL", env.MCP_PUBLIC_URL, "https://la-mcp.vercel.app");
    if (publicUrl.pathname !== "/" || publicUrl.search) throw new Error("MCP_PUBLIC_URL must be just the origin, e.g. https://la-mcp.vercel.app (no path).");
    if (!has("CMS_API_URL")) throw new Error("MCP_PUBLIC_URL is set (OAuth mode), so CMS_API_URL is needed too.");
    const secret = env.MCP_TOKEN_SECRET ?? "";
    if (secret.length < 32) throw new Error("MCP_PUBLIC_URL is set (OAuth mode), so MCP_TOKEN_SECRET must be set to at least 32 random characters.");
    // A shared bot login has no place on a public server: everyone signs in as themselves there.
    if (!isLocal(publicUrl) && (has("CMS_EMAIL") || has("CMS_PASSWORD"))) {
      throw new Error("Remove CMS_EMAIL and CMS_PASSWORD: on a public server every person signs in with their own CMS account.");
    }
    const cmsUrl = parseUrl("CMS_API_URL", env.CMS_API_URL, "https://liveaccess.ai/la-studio/api");
    return { mode: "oauth", oauth: { cmsBaseUrl: cmsUrl.href.replace(/\/+$/, ""), publicUrl: new URL(publicUrl.origin), tokenSecret: secret } };
  }

  const mode = (env.LA_DATA ?? "sample").trim().toLowerCase();
  if (mode === "sample") return { mode: "sample" };
  if (mode !== "cms") throw new Error(`LA_DATA must be "sample" or "cms" (got "${env.LA_DATA}").`);

  const missing = ["CMS_API_URL", "CMS_EMAIL", "CMS_PASSWORD"].filter((k) => !has(k));
  if (missing.length) throw new Error(`LA_DATA=cms needs ${missing.join(", ")} (set them in .env).`);
  const url = parseUrl("CMS_API_URL", env.CMS_API_URL, "http://localhost:8787/la-studio/api");
  return {
    mode: "cms",
    cms: { baseUrl: url.href.replace(/\/+$/, ""), email: env.CMS_EMAIL!.trim(), password: env.CMS_PASSWORD! },
  };
}
