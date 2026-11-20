import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp.js";
import { CmsClient } from "../src/cms-client.js";
import { loadConfig } from "../src/config.js";

const BASE = "http://cms.test/la-studio/api";
const CFG = { baseUrl: BASE, email: "bot@example.com", password: "right-password" };

type Call = { method: string; path: string; auth?: string; body?: any };

/** A small stand-in for the CMS API, recording every call. */
function fakeCms(opts: { password?: string } = {}) {
  const calls: Call[] = [];
  const valid = new Set<string>();
  let logins = 0;
  const guide = {
    id: 7, slug: "pump-cavitation", title: "Pump cavitation", summary: "", areaSlug: "", publishedDate: "2026-11-20",
    blocks: [{ type: "heading", level: 2, text: "Symptoms" }], seo: { title: "", description: "", noindex: false },
    status: "draft", live: false, hasChanges: true, version: 3,
  };
  const messages = [
    { id: 1, name: "Asha", email: "asha@example.com", company: "X", topic: "Something else", message: "a".repeat(400), status: "new" },
    { id: 2, name: "Ravi", email: "ravi@example.com", company: "Y", topic: "Help with the app", message: "Call me on +91 98765 43210 or mail ravi.k@corp.example.in about order 2026-11-20.", status: "new" },
  ];
  let conflictNext = false;

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/la-studio/api", "") + url.search;
    const auth = (init?.headers as Record<string, string>)?.authorization;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path, auth, body });

    if (path === "/auth/login") {
      if (body.password !== (opts.password ?? "right-password")) return reply(401, { error: "Email or password is wrong." });
      const token = `tok-${++logins}`;
      valid.add(token);
      return reply(200, { accessToken: token, expiresIn: 900, user: {} });
    }
    if (!auth || !valid.has(auth.replace("Bearer ", ""))) return reply(401, { error: "Not signed in." });

    if (method === "GET" && path === "/dashboard") return reply(200, { messages: 1, waiting: { items: [], total: 0 } });
    if (method === "GET" && path.startsWith("/messages?")) return reply(200, { messages, total: 1, page: 1, pageSize: 30, counts: { new: 1 } });
    if (method === "PATCH" && path === "/messages/1") return reply(200, { message: { ...messages[0], status: body.status } });
    if (method === "GET" && path === "/guides/7") return reply(200, { guide, areas: [], template: "<html>…</html>", mediaFiles: {}, problems: {} });
    if (method === "PUT" && path === "/guides/7") {
      if (conflictNext) {
        conflictNext = false;
        return reply(409, { error: "This guide was changed by Ravi at 2026-11-20T10:00:00.000Z. Reload to see their changes.", version: 4 });
      }
      return reply(200, { version: 4, guide: { ...guide, ...body, version: 4 } });
    }
    if (method === "POST" && path === "/guides") return reply(201, { guide: { ...guide, id: 8, title: body.title, version: 1 } });
    return reply(404, { error: "Not found." });
  }) as typeof fetch;

  return {
    calls,
    fetchFn,
    expireAllTokens: () => valid.clear(),
    conflictOnNextSave: () => {
      conflictNext = true;
    },
    loginCount: () => calls.filter((c) => c.path === "/auth/login").length,
  };
}

async function connect(cms: CmsClient) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildServer({ cms }).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0].text;
const payload = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse(text(r));

// --- client ---

test("signs in once and reuses the token", async () => {
  const fake = fakeCms();
  const cms = new CmsClient(CFG, fake.fetchFn);
  await cms.get("/dashboard");
  await cms.get("/dashboard");
  assert.equal(fake.loginCount(), 1);
  assert.equal(fake.calls.at(-1)!.auth, "Bearer tok-1");
});

test("signs in again before the token expires", async () => {
  const fake = fakeCms();
  let now = 0;
  const cms = new CmsClient(CFG, fake.fetchFn, () => now);
  await cms.get("/dashboard");
  now = 850_000; // within a minute of the 900 s expiry
  await cms.get("/dashboard");
  assert.equal(fake.loginCount(), 2);
});

test("signs in once more after a 401, then succeeds", async () => {
  const fake = fakeCms();
  const cms = new CmsClient(CFG, fake.fetchFn);
  await cms.get("/dashboard");
  fake.expireAllTokens();
  await cms.get("/dashboard");
  assert.equal(fake.loginCount(), 2);
});

test("a wrong password is tried once, then not again during the cooldown", async () => {
  const fake = fakeCms({ password: "something-else" });
  let now = 0;
  const cms = new CmsClient(CFG, fake.fetchFn, () => now);
  await assert.rejects(cms.get("/dashboard"), /refused the MCP user's email or password/);
  await assert.rejects(cms.get("/dashboard"), /Not retrying/);
  assert.equal(fake.loginCount(), 1);
  now = 61_000;
  await assert.rejects(cms.get("/dashboard"), /refused/);
  assert.equal(fake.loginCount(), 2);
});

test("parallel calls share one sign-in", async () => {
  const fake = fakeCms();
  const cms = new CmsClient(CFG, fake.fetchFn);
  await Promise.all([cms.get("/dashboard"), cms.get("/dashboard"), cms.get("/dashboard")]);
  assert.equal(fake.loginCount(), 1);
});

test("the password never appears in an error", async () => {
  const fake = fakeCms({ password: "x" });
  const cms = new CmsClient(CFG, fake.fetchFn);
  const err = await cms.get("/dashboard").catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, /right-password/);
});

// --- tools ---

test("CMS mode lists only the CMS tools", async () => {
  const client = await connect(new CmsClient(CFG, fakeCms().fetchFn));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_guide_draft", "get_cms_dashboard", "get_contact_message", "get_guide", "get_process_area",
    "list_guides", "list_process_areas", "search_contact_messages", "update_contact_message_status", "update_guide_draft",
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.get_contact_message.annotations?.readOnlyHint, false, "opening a message marks it read");
  assert.equal(byName.search_contact_messages.annotations?.readOnlyHint, true);
});

test("search_contact_messages sends the filters and shortens long text", async () => {
  const fake = fakeCms();
  const client = await connect(new CmsClient(CFG, fake.fetchFn));
  const r = payload(await client.callTool({ name: "search_contact_messages", arguments: { status: "all", topic: "Help with the app" } }));
  assert.equal(fake.calls.at(-1)!.path, "/messages?status=all&page=1&topic=Help+with+the+app");
  assert.equal(r.messages[0].message.length, 301);
});

test("contact messages leave out name, email and company and mask contact details", async () => {
  const fake = fakeCms();
  const client = await connect(new CmsClient(CFG, fake.fetchFn));
  const out = text(await client.callTool({ name: "search_contact_messages", arguments: {} }));
  for (const secret of ["Asha", "asha@example.com", "Ravi", "ravi@example.com", "ravi.k@corp.example.in", "98765"]) {
    assert.ok(!out.includes(secret), `${secret} must not reach the AI`);
  }
  const ravi = JSON.parse(out).messages[1];
  assert.equal(ravi.message, "Call me on [phone hidden] or mail [email hidden] about order 2026-11-20.");
  assert.equal(ravi.name, undefined);
  assert.equal(ravi.company, undefined);
});

test("search_contact_messages no longer offers a text search (it searched names and emails)", async () => {
  const client = await connect(new CmsClient(CFG, fakeCms().fetchFn));
  const { tools } = await client.listTools();
  const search = tools.find((t) => t.name === "search_contact_messages")!;
  assert.equal((search.inputSchema.properties as Record<string, unknown>).query, undefined);
});

test("update_contact_message_status sends a PATCH", async () => {
  const fake = fakeCms();
  const client = await connect(new CmsClient(CFG, fake.fetchFn));
  const r = payload(await client.callTool({ name: "update_contact_message_status", arguments: { id: 1, status: "replied" } }));
  assert.deepEqual(fake.calls.at(-1), { method: "PATCH", path: "/messages/1", auth: "Bearer tok-1", body: { status: "replied" } });
  assert.equal(r.status, "replied");
  assert.equal(r.email, undefined);
});

test("get_guide leaves out the preview template", async () => {
  const client = await connect(new CmsClient(CFG, fakeCms().fetchFn));
  const r = payload(await client.callTool({ name: "get_guide", arguments: { id: 7 } }));
  assert.equal(r.template, undefined);
  assert.equal(r.guide.slug, "pump-cavitation");
});

test("update_guide_draft sends baseVersion and keeps blocks and slug", async () => {
  const fake = fakeCms();
  const client = await connect(new CmsClient(CFG, fake.fetchFn));
  const r = await client.callTool({ name: "update_guide_draft", arguments: { id: 7, summary: "How to spot cavitation." } });
  assert.equal(r.isError, undefined);
  const put = fake.calls.find((c) => c.method === "PUT")!;
  assert.equal(put.body.baseVersion, 3);
  assert.equal(put.body.slug, "pump-cavitation");
  assert.equal(put.body.title, "Pump cavitation");
  assert.equal(put.body.summary, "How to spot cavitation.");
  assert.deepEqual(put.body.blocks, [{ type: "heading", level: 2, text: "Symptoms" }]);
});

test("update_guide_draft explains a conflict instead of overwriting", async () => {
  const fake = fakeCms();
  fake.conflictOnNextSave();
  const client = await connect(new CmsClient(CFG, fake.fetchFn));
  const r = await client.callTool({ name: "update_guide_draft", arguments: { id: 7, title: "New title" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /changed by Ravi.*Nothing was saved/);
});

test("CMS errors come back as readable tool errors", async () => {
  const client = await connect(new CmsClient(CFG, fakeCms().fetchFn));
  const r = await client.callTool({ name: "get_process_area", arguments: { id: 99 } });
  assert.equal(r.isError, true);
  assert.equal(text(r), "Not found.");
});

test("create_guide_draft posts the title", async () => {
  const fake = fakeCms();
  const client = await connect(new CmsClient(CFG, fake.fetchFn));
  const r = payload(await client.callTool({ name: "create_guide_draft", arguments: { title: "Seal leak checks" } }));
  assert.deepEqual(fake.calls.at(-1)!.body, { title: "Seal leak checks" });
  assert.equal(r.id, 8);
});

// --- config ---

test("config: OAuth mode needs a secret and refuses a bot login on a public URL", () => {
  const base = { MCP_PUBLIC_URL: "https://la-mcp.vercel.app", CMS_API_URL: "https://liveaccess.ai/la-studio/api", MCP_TOKEN_SECRET: "x".repeat(32) };
  const ok = loadConfig(base);
  assert.equal(ok.mode, "oauth");
  assert.throws(() => loadConfig({ ...base, MCP_TOKEN_SECRET: "short" }), /MCP_TOKEN_SECRET/);
  assert.throws(() => loadConfig({ ...base, CMS_EMAIL: "bot@x", CMS_PASSWORD: "p" }), /Remove CMS_EMAIL/);
  assert.throws(() => loadConfig({ ...base, MCP_PUBLIC_URL: "http://la-mcp.example.com" }), /https/);
  assert.throws(() => loadConfig({ ...base, MCP_PUBLIC_URL: "https://la-mcp.vercel.app/mcp" }), /no path/);
  // Locally the bot settings may stay in .env while trying OAuth.
  assert.equal(loadConfig({ ...base, MCP_PUBLIC_URL: "http://localhost:3000", CMS_EMAIL: "bot@x", CMS_PASSWORD: "p" }).mode, "oauth");
});

test("config: sample by default, cms needs all settings, http only for localhost", () => {
  assert.deepEqual(loadConfig({}), { mode: "sample" });
  assert.throws(() => loadConfig({ LA_DATA: "cms", CMS_API_URL: "http://localhost:8787/la-studio/api" }), /CMS_EMAIL, CMS_PASSWORD/);
  assert.throws(() => loadConfig({ LA_DATA: "cms", CMS_API_URL: "http://cms.example.com/api", CMS_EMAIL: "a", CMS_PASSWORD: "b" }), /https/);
  const ok = loadConfig({ LA_DATA: "cms", CMS_API_URL: "http://localhost:8787/la-studio/api/", CMS_EMAIL: "a", CMS_PASSWORD: "b" });
  assert.equal(ok.mode === "cms" && ok.cms.baseUrl, "http://localhost:8787/la-studio/api");
});
