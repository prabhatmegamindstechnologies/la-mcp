// End-to-end OAuth: a real HTTP server (the Express app) with a fake CMS behind it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server.js";
import { CmsOAuthProvider } from "../src/oauth-provider.js";
import { Sealer } from "../src/seal.js";

const CMS = "http://cms.test/la-studio/api";
const SECRET = "test-secret-".padEnd(48, "x");
const REDIRECT = "https://chatgpt.example/connector/callback";

/** Fake CMS: two people, real-looking sessions (access token + la_refresh cookie). */
function fakeCms() {
  const people: Record<string, { id: number; name: string; role: string; password: string }> = {
    "asha@tps.example": { id: 11, name: "Asha", role: "editor", password: "asha-pass#1" },
    "temp@tps.example": { id: 12, name: "Temp", role: "editor", password: "temp-pass" },
  };
  const sessions = new Map<string, { userId: number; csrf: string }>(); // refresh cookie -> session
  const tokens = new Map<string, number>(); // access token -> user id
  const loggedOut: string[] = [];
  let n = 0;
  const byId = (id: number) => Object.values(people).find((p) => p.id === id)!;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const newToken = (userId: number) => {
    const t = `cms-at-${++n}`;
    tokens.set(t, userId);
    return t;
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/la-studio/api", "");
    const h = new Headers(init?.headers);
    const cookie = /la_refresh=([^;]+)/.exec(h.get("cookie") ?? "")?.[1];

    if (path === "/auth/login") {
      const { email, password } = JSON.parse(String(init!.body));
      const p = people[email];
      if (!p || p.password !== password) return reply(401, { error: "Email or password is wrong." });
      const rc = `rc-${++n}`, csrf = `csrf-${n}`;
      sessions.set(rc, { userId: p.id, csrf });
      const user = { id: p.id, name: p.name, email, role: p.role, mustChangePassword: email.startsWith("temp") };
      return reply(200, { user, accessToken: newToken(p.id), expiresIn: 900, csrfToken: csrf }, {
        "set-cookie": `la_refresh=${rc}; Max-Age=28800; Path=/la-studio/api/auth; HttpOnly; Secure; SameSite=Strict`,
      });
    }
    if (path === "/auth/refresh") {
      const s = cookie && sessions.get(cookie);
      if (!s) return reply(401, { error: "Not signed in." });
      const p = byId(s.userId);
      return reply(200, { user: { id: p.id, name: p.name, role: p.role }, accessToken: newToken(p.id), expiresIn: 900, csrfToken: s.csrf });
    }
    if (path === "/auth/logout") {
      const s = cookie && sessions.get(cookie);
      if (!s || h.get("x-csrf-token") !== s.csrf) return reply(403, { error: "Missing or wrong CSRF token." });
      sessions.delete(cookie!);
      loggedOut.push(cookie!);
      return new Response(null, { status: 204 });
    }
    const auth = h.get("authorization")?.replace("Bearer ", "");
    const userId = auth ? tokens.get(auth) : undefined;
    if (!userId) return reply(401, { error: "Not signed in." });
    if (path === "/dashboard") return reply(200, { signedInAs: byId(userId).name, messages: 0 });
    return reply(404, { error: "Not found." });
  }) as typeof fetch;

  return { fetchFn, sessions, tokens, loggedOut };
}

let server: Server;
let base: string;
let cms: ReturnType<typeof fakeCms>;
let provider: CmsOAuthProvider;

before(async () => {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  cms = fakeCms();
  provider = new CmsOAuthProvider({ cmsBaseUrl: CMS, publicUrl: new URL(base), tokenSecret: SECRET, fetchFn: cms.fetchFn });
  server.on("request", createApp({ oauth: provider, port }));
});

after(() => new Promise<void>((r) => server.close(() => r())));

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(redirect = REDIRECT, name = "ChatGPT") {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: name, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  });
  return { res, body: (await res.json()) as { client_id: string; error?: string } };
}

function authorizeUrl(clientId: string, challenge: string, redirect = REDIRECT) {
  const u = new URL(`${base}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: "S256", state: "st-123", resource: `${base}/mcp`,
  }).toString();
  return u;
}

async function openSignIn(clientId: string, challenge: string) {
  const res = await fetch(authorizeUrl(clientId, challenge));
  const html = await res.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, request: request! };
}

function postLogin(request: string, email: string, password: string, origin = base) {
  return fetch(`${base}/oauth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ request, email, password }).toString(),
  });
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { res, body: (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
}

/** Full sign-in as Asha; returns the client id and tokens. */
async function signInAsAsha() {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const { request } = await openSignIn(client.client_id, challenge);
  const back = new URL((await postLogin(request, "asha@tps.example", "asha-pass#1")).headers.get("location")!);
  const { body } = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
  return { clientId: client.client_id, tokens: body };
}

async function mcpAs(accessToken: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return client;
}

test("publishes discovery metadata for MCP clients", async () => {
  const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
  assert.equal(pr.resource, `${base}/mcp`);
  assert.deepEqual(pr.authorization_servers, [`${base}/`]);
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("/mcp without a token answers 401 and points to the metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("full flow: register, sign in, token, then tools run as that person", async () => {
  const { body: client } = await register();
  assert.ok(client.client_id.length > 40);
  const { verifier, challenge } = pkce();
  const page = await openSignIn(client.client_id, challenge);
  assert.equal(page.res.status, 200);
  assert.match(page.html, /<strong>ChatGPT<\/strong> wants to read and change/);
  assert.match(page.html, /chatgpt\.example/);
  assert.equal(page.res.headers.get("x-frame-options"), "DENY");

  const wrong = await postLogin(page.request, "asha@tps.example", "nope");
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Email or password is wrong/);

  const ok = await postLogin(page.request, "asha@tps.example", "asha-pass#1");
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st-123");

  const { res, body } = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
  assert.equal(res.status, 200);
  assert.ok(body.access_token && body.refresh_token);
  assert.ok(body.expires_in > 800 && body.expires_in <= 900);
  // The CMS password and session cookie must not be readable in what the app receives.
  for (const t of [body.access_token, body.refresh_token, client.client_id]) {
    const raw = Buffer.from(t, "base64url").toString("latin1");
    assert.ok(!raw.includes("asha-pass") && !raw.includes("rc-") && !raw.includes("cms-at-"));
  }

  const mcp = await mcpAs(body.access_token);
  const r = await mcp.callTool({ name: "get_cms_dashboard", arguments: {} });
  assert.equal(JSON.parse((r.content as { text: string }[])[0].text).signedInAs, "Asha");
  await mcp.close();
});

test("a wrong PKCE verifier is refused", async () => {
  const { body: client } = await register();
  const { challenge } = pkce();
  const { request } = await openSignIn(client.client_id, challenge);
  const code = new URL((await postLogin(request, "asha@tps.example", "asha-pass#1")).headers.get("location")!).searchParams.get("code")!;
  const { res, body } = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id });
  assert.equal(res.status, 400);
  assert.equal(body.error, "invalid_grant");
});

test("a code can't be used by another client", async () => {
  const { body: a } = await register();
  const { body: b } = await register();
  const { verifier, challenge } = pkce();
  const { request } = await openSignIn(a.client_id, challenge);
  const code = new URL((await postLogin(request, "asha@tps.example", "asha-pass#1")).headers.get("location")!).searchParams.get("code")!;
  const { res } = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: b.client_id });
  assert.equal(res.status, 400);
});

test("refresh gets a new access token from the CMS session; a revoked session can't refresh", async () => {
  const { clientId, tokens } = await signInAsAsha();
  const { res, body } = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(res.status, 200);
  const mcp = await mcpAs(body.access_token);
  const r = await mcp.callTool({ name: "get_cms_dashboard", arguments: {} });
  assert.equal(r.isError, undefined);
  await mcp.close();

  const revoke = await fetch(`${base}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }).toString(),
  });
  assert.equal(revoke.status, 200);
  assert.equal(cms.loggedOut.length, 1, "revoking signs out of the CMS session");
  const again = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(again.res.status, 400);
  assert.equal(again.body.error, "invalid_grant");
});

test("tampered, wrong-kind and foreign tokens are refused at /mcp", async () => {
  const { tokens } = await signInAsAsha();
  const flip = tokens.access_token.slice(0, -2) + (tokens.access_token.endsWith("A") ? "BB" : "AA");
  const other = new Sealer("another-secret-".padEnd(48, "y")).seal("access", { cid: "x", exp: Date.now() + 60_000, cmsToken: "t", user: {} }, 60);
  for (const bad of [flip, tokens.refresh_token, other, "abc"]) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bad}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
  }
});

test("a CMS session that ended shows a reconnect message instead of failing silently", async () => {
  const { tokens } = await signInAsAsha();
  cms.tokens.clear(); // e.g. the person signed out of the CMS
  const mcp = await mcpAs(tokens.access_token);
  const r = await mcp.callTool({ name: "get_cms_dashboard", arguments: {} });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0].text, /Reconnect the LiveAccess connector/);
  await mcp.close();
});

test("access tokens expire with the CMS token", async () => {
  let now = Date.now();
  const p = new CmsOAuthProvider({ cmsBaseUrl: CMS, publicUrl: new URL(base), tokenSecret: SECRET, fetchFn: cms.fetchFn, now: () => now });
  const client = await p.clientsStore.registerClient!({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" } as never);
  const { verifier: _v, challenge } = pkce();
  const location = await p.signIn({ clientId: client.client_id, redirectUri: REDIRECT, codeChallenge: challenge }, "asha@tps.example", "asha-pass#1");
  const t = await p.exchangeAuthorizationCode(client, new URL(location).searchParams.get("code")!);
  assert.ok(await p.verifyAccessToken(t.access_token));
  now += 901_000;
  await assert.rejects(p.verifyAccessToken(t.access_token), /invalid or has expired/);
});

test("registration refuses non-https redirect URIs (except localhost)", async () => {
  assert.equal((await register("http://evil.example/cb")).res.status, 400);
  assert.equal((await register("http://localhost:6274/oauth/callback", "MCP Inspector")).res.status, 201);
});

test("authorize refuses a redirect URI the client didn't register", async () => {
  const { body: client } = await register();
  const res = await fetch(authorizeUrl(client.client_id, pkce().challenge, "https://evil.example/cb"));
  assert.equal(res.status, 400);
});

test("sign-in form: other sites, stale requests and temporary passwords are refused", async () => {
  const { body: client } = await register();
  const { request } = await openSignIn(client.client_id, pkce().challenge);
  assert.equal((await postLogin(request, "asha@tps.example", "asha-pass#1", "https://evil.example")).status, 403);
  assert.equal((await postLogin("forged", "asha@tps.example", "asha-pass#1")).status, 400);
  const temp = await postLogin(request, "temp@tps.example", "temp-pass");
  assert.equal(temp.status, 400);
  assert.match(await temp.text(), /temporary password/);
});

test("the sign-in page lets the browser send its real Origin, and Origin: null is still refused", async () => {
  const { body: client } = await register();
  const { res, request } = await openSignIn(client.client_id, pkce().challenge);
  // With no-referrer, browsers send `Origin: null` on the form POST, which the origin check refuses.
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal((await postLogin(request, "asha@tps.example", "asha-pass#1", "null")).status, 403);
});

test("the sign-in page escapes the app's self-chosen name", async () => {
  const { body: client } = await register(REDIRECT, `<script>alert(1)</script>`);
  const { html } = await openSignIn(client.client_id, pkce().challenge);
  assert.ok(!html.includes("<script>alert(1)"));
  assert.match(html, /&lt;script&gt;/);
});
