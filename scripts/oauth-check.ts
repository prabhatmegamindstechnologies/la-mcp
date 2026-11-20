// Walks through the OAuth sign-in the way ChatGPT or Inspector would, against a running server, then calls tools.
//   npx tsx scripts/oauth-check.ts http://localhost:3000
// Uses CMS_EMAIL / CMS_PASSWORD from the environment or .env (never printed).
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const email = process.env.CMS_EMAIL, password = process.env.CMS_PASSWORD;
if (!email || !password) throw new Error("Set CMS_EMAIL and CMS_PASSWORD (a CMS account to sign in with).");
const redirect = "http://localhost:6274/oauth/callback";
const step = (s: string) => console.log(`\n--- ${s}`);

step("discovery");
const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
console.log("protected resource:", JSON.stringify(pr));
const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
console.log("authorization server:", as.authorization_endpoint, as.token_endpoint, as.registration_endpoint);

step("register");
const reg = await fetch(as.registration_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: [redirect], client_name: "la-mcp oauth-check", token_endpoint_auth_method: "none" }),
});
const { client_id } = (await reg.json()) as { client_id: string };
console.log("status", reg.status, "client_id length", client_id.length);

step("authorize (sign-in page)");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const auth = new URL(as.authorization_endpoint!);
auth.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "check", resource: `${base}/mcp` }).toString();
const page = await fetch(auth);
const html = await page.text();
const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
console.log("status", page.status, "| page shows app name:", html.includes("la-mcp oauth-check"));

step("sign in with a wrong password");
const wrong = await fetch(`${base}/oauth/login`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
  body: new URLSearchParams({ request: request!, email, password: "definitely-wrong" }).toString(),
});
console.log("status", wrong.status, "|", /role="alert">([^<]+)/.exec(await wrong.text())?.[1]);

step("sign in");
const login = await fetch(`${base}/oauth/login`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
  body: new URLSearchParams({ request: request!, email, password }).toString(),
});
const location = login.headers.get("location");
console.log("status", login.status, "| back to:", location ? new URL(location).origin + new URL(location).pathname : /role="alert">([^<]+)/.exec(await login.text())?.[1]);
if (!location) process.exit(1);
const code = new URL(location).searchParams.get("code")!;

step("token");
const tok = await fetch(as.token_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirect }).toString(),
});
const tokens = (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number };
console.log("status", tok.status, "| expires_in", tokens.expires_in, "| refresh token:", !!tokens.refresh_token);

step("/mcp without a token");
const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
console.log("status", anon.status, "|", anon.headers.get("www-authenticate"));

step("tools as the signed-in person");
const client = new Client({ name: "oauth-check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const dash = await client.callTool({ name: "get_cms_dashboard", arguments: {} });
console.log("dashboard:", (dash.content as { text: string }[])[0].text.split("\n").slice(0, 6).join(" "));
const msgs = await client.callTool({ name: "search_contact_messages", arguments: { status: "all" } });
console.log("messages:", (msgs.content as { text: string }[])[0].text.split("\n").slice(0, 4).join(" "));
await client.close();

step("refresh");
const ref = await fetch(as.token_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }).toString(),
});
console.log("status", ref.status, "| new access token:", !!((await ref.json()) as { access_token?: string }).access_token);

step("revoke (signs out of this CMS session)");
const rev = await fetch(`${base}/revoke`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ token: tokens.refresh_token, client_id }).toString(),
});
console.log("status", rev.status);
const after = await fetch(as.token_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }).toString(),
});
console.log("refresh after revoke: status", after.status, JSON.stringify(await after.json()));
