import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { buildServer } from "./src/mcp.js";
import { CmsClient, CmsError } from "./src/cms-client.js";
import { loadConfig, type Config } from "./src/config.js";
import { CmsOAuthProvider } from "./src/oauth-provider.js";
import { sendLoginPage, sendMessagePage } from "./src/login-page.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);

function rpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export interface AppOptions {
  /** Local bot mode: one shared CMS client. */
  cms?: CmsClient;
  /** OAuth mode: each request acts as the signed-in person. */
  oauth?: CmsOAuthProvider;
  /** Behind Vercel's proxy: use X-Forwarded-For for rate limits. */
  trustProxy?: boolean;
  port?: number;
}

/** Sample data unless `cms` (bot) or `oauth` (per person) is given. */
export function createApp(opts: AppOptions = {}) {
  const app = express();
  const port = opts.port ?? PORT;
  if (opts.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Block DNS rebinding: only requests addressed to this server's own names.
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (opts.oauth) allowedHosts.add(opts.oauth.publicUrl.host);
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host ?? "")) return rpcError(res, 403, -32000, "Forbidden host");
    next();
  });

  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const mcpGuards: express.RequestHandler[] = [];
  if (opts.oauth) {
    const provider = opts.oauth;
    // Discovery metadata, /register, /authorize, /token and /revoke (with the SDK's rate limits).
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: provider.publicUrl,
        resourceServerUrl: provider.resourceUrl,
        resourceName: "LiveAccess CMS",
        // Client ids are sealed and never expire; a secret that expired would break a connector silently.
        clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0 },
      })
    );
    app.post("/oauth/login", loginLimiter(), express.urlencoded({ extended: false, limit: "20kb" }), (req, res) => signInRoute(provider, req, res));
    mcpGuards.push(
      requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resourceUrl),
        expectedResource: provider.resourceUrl,
      })
    );
  }

  // Stateless mode: a new server + transport per request, so it scales horizontally.
  app.post("/mcp", ...mcpGuards, async (req, res) => {
    const cms = opts.oauth && req.auth ? opts.oauth.clientFor(req.auth) : opts.cms;
    const server = buildServer({ cms });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });

  // No sessions or server-initiated streams in stateless mode.
  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    rpcError(res, 405, -32000, "Method not allowed");
  });

  // Malformed JSON and other errors: never send stack traces to the client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isParse = (err as { type?: string })?.type === "entity.parse.failed";
    if (!isParse) console.error("Unhandled error:", err);
    if (res.headersSent) return;
    if (isParse) return rpcError(res, 400, -32700, "Parse error");
    rpcError(res, 500, -32603, "Internal server error");
  });

  return app;
}

/** Per-IP limit on password attempts. In-memory, so per instance on Vercel; the CMS account lockout is the real guard. */
function loginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendMessagePage(res, 429, "Too many sign-in attempts", "Wait 15 minutes, then start again from your AI app."),
  });
}

async function signInRoute(provider: CmsOAuthProvider, req: Request, res: Response) {
  // The form is only ever posted by our own page.
  const origin = req.headers.origin;
  if (origin && origin !== provider.publicUrl.origin) {
    return sendMessagePage(res, 403, "Sign-in refused", "This sign-in form was sent from another site.");
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const opened = typeof body.request === "string" ? provider.openSignInRequest(body.request) : null;
  if (!opened) {
    return sendMessagePage(res, 400, "Sign-in link expired", "This sign-in page is more than 10 minutes old. Start again from your AI app.");
  }
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
  const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
  const view = { request: body.request as string, clientName: opened.client.client_name, redirectHost: new URL(opened.req.redirectUri).host, email };
  if (!email || !password) return sendLoginPage(res, { ...view, error: "Enter your email and password." }, 400);
  try {
    res.redirect(302, await provider.signIn(opened.req, email, password));
  } catch (err) {
    if (!(err instanceof CmsError)) console.error("Sign-in failed:", err);
    const message = err instanceof CmsError ? err.message : "Sign-in failed. Try again.";
    sendLoginPage(res, { ...view, error: message }, err instanceof CmsError && err.status === 401 ? 401 : 400);
  }
}

/** Builds the app from settings (also used by the Vercel function). */
export function appFromConfig(config: Config, opts: { trustProxy?: boolean } = {}) {
  if (config.mode === "oauth") {
    const oauth = new CmsOAuthProvider(config.oauth);
    return { app: createApp({ oauth, trustProxy: opts.trustProxy }), source: `CMS at ${config.oauth.cmsBaseUrl}, OAuth sign-in at ${oauth.publicUrl.origin}` };
  }
  // One client for the whole process, so its CMS sign-in is reused across requests.
  const cms = config.mode === "cms" ? new CmsClient(config.cms) : undefined;
  const source = config.mode === "cms" ? `CMS at ${config.cms.baseUrl} as ${config.cms.email}` : "sample data";
  return { app: createApp({ cms, trustProxy: opts.trustProxy }), source };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { app, source } = appFromConfig(config);
  app.listen(PORT, HOST, () => console.log(`MCP on http://localhost:${PORT}/mcp (${source})`));
}
