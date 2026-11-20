# LiveAccess MCP server

An MCP server that lets AI tools (ChatGPT Business, Copilot Studio, Claude, MCP Inspector) read and write LiveAccess website CMS data (`D:\LiveAccess-Website-CMS`) through the CMS's HTTP API.

## Modes

| Mode | Turned on by | Who the CMS sees | Use |
|---|---|---|---|
| **OAuth** | `MCP_PUBLIC_URL` is set | **Each person**, signed in with their own CMS email and password | Vercel (production), and a local try-out |
| Bot | `LA_DATA=cms` | One shared CMS user from `.env` | Local development only |
| Sample | default | Nobody; in-memory sample data | Tests, demos |

## How sign-in works (OAuth mode)

1. When someone adds the server in ChatGPT, Copilot Studio or Inspector, the app finds la-mcp's OAuth endpoints (`/.well-known/...`), registers itself, and opens la-mcp's **sign-in page**.
2. The person signs in with their **CMS email and password**. la-mcp checks them with the CMS (`/auth/login`) and never stores the password.
3. Every tool call then reaches the CMS **as that person**:
   - changes appear under their name in the CMS audit log
   - the CMS's own role rules apply (Editor or Super Admin)
4. Access tokens last 15 minutes and are renewed automatically from the CMS session. The person signs in again when the CMS session ends: after 8 hours unused, 7 days at most, or when they sign out or change their password in the CMS.

la-mcp stores nothing. Client registrations, codes and tokens are encrypted with `MCP_TOKEN_SECRET` (AES-256-GCM). Changing that secret signs everyone out.

## Tools

| Tool | Type | What it does |
|---|---|---|
| `get_cms_dashboard` | read | Unpublished changes, recent edits, new messages, last publish |
| `search_contact_messages` | read | Contact-form messages by status and topic (30 per page) |
| `get_contact_message` | read* | One message. *Opening a `new` message marks it `read`. |
| `update_contact_message_status` | write | `new` / `read` / `replied` / `archived` |
| `list_guides`, `list_process_areas` | read | Lists, without body content |
| `get_guide`, `get_process_area` | read | Full content, plus any problems that would block publishing |
| `create_guide_draft` | write | New guide draft with the starter sections |
| `update_guide_draft` | write | Title, summary, process area and SEO fields. The body and address stay unchanged. Refuses to overwrite someone else's newer save. |

**Privacy:** contact messages never include the sender's name, email or company. Email addresses and phone numbers inside the message text are replaced with `[email hidden]` / `[phone hidden]`. There is no text search, because the CMS search also matches names and emails.

No delete or publish tools: publishing stays a manual step in the CMS admin. (Sample mode has its own three service-request tools.)

## Deploy to Vercel

1. **Put la-mcp in Git** (GitHub, GitLab or Bitbucket) and import the repo in Vercel (**Add New → Project**). No build settings are needed. `vercel.json` routes every path to `api/index.ts` and pins the region to `sin1` (Singapore, like the CMS).
2. **Environment variables** (Project → Settings → Environment Variables, for Production):

   | Name | Value |
   |---|---|
   | `MCP_PUBLIC_URL` | The deployment's own address, for example `https://la-mcp.vercel.app` (origin only, no `/mcp`) |
   | `MCP_TOKEN_SECRET` | 48 random bytes: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
   | `CMS_API_URL` | The production CMS API, for example `https://liveaccess.ai/la-studio/api` |

   Don't set `CMS_EMAIL` or `CMS_PASSWORD`; the server refuses to start on a public URL with them.
3. **Deploy**, then check it:
   - `https://<your-url>/health` returns `{"ok":true}`
   - `npx tsx scripts/oauth-check.ts https://<your-url>` runs the whole sign-in and calls tools. It signs in with `CMS_EMAIL`/`CMS_PASSWORD` from your local `.env`.
4. **Custom domain (optional):** add it in Vercel, for example `mcp.liveaccess.ai`, then change `MCP_PUBLIC_URL` to it and redeploy.

   Requests addressed to any other host are refused, so each Vercel preview URL needs its own `MCP_PUBLIC_URL` (Preview environment) to work.

## Connect the AI tools

The MCP URL is `<MCP_PUBLIC_URL>/mcp`, for example `https://la-mcp.vercel.app/mcp`. Each person signs in with their own CMS account the first time.

- **MCP Inspector:**
  1. Run `npx @modelcontextprotocol/inspector`.
  2. Choose **Add Servers**, then **Streamable HTTP**, and enter the MCP URL.
  3. Connect. The sign-in page opens in the browser.
- **ChatGPT Business, Enterprise or Edu** (on Business, only admins and owners can create these):
  1. Go to **chatgpt.com/plugins** and click **+**, then **Add custom MCP server**.
  2. Enter the MCP URL, set Authentication to **OAuth**, and click **Create as a plugin**.
  3. Install the plugin, then type `@` in a chat to use it.
- **Copilot Studio** (the free trial is enough for testing):
  1. Open the agent and go to **Tools → Add a tool → New tool → Model Context Protocol**.
  2. Enter the server URL, choose **OAuth 2.0 → Dynamic discovery**, then create a connection and sign in.
  3. Generative orchestration must be on for the agent.
- **Claude:**
  1. Go to **Settings → Connectors → Add custom connector** and enter the MCP URL.
  2. Sign in. This was tested on 2026-11-20.

See [docs/connector-support.md](docs/connector-support.md) for plans, limits and sources (checked 2026-11-20).

## Run locally

```powershell
cd D:\la-mcp
npm install
copy .env.example .env   # then edit .env
npm run dev              # prints which mode it's in
```

`server.ts` reads `.env`; variables set in the shell win over `.env`.

- **Local CMS:** `cd D:\LiveAccess-Website-CMS; pnpm dev:api` serves `http://localhost:8787/la-studio/api`. Its `.env` needs `JWT_SECRET`.
- **Try OAuth locally:** set `MCP_PUBLIC_URL=http://localhost:3000` and `MCP_TOKEN_SECRET=<32+ chars>`, run `npm run dev`, then use Inspector or `npx tsx scripts/oauth-check.ts http://localhost:3000`.
- **Bot mode:** set `LA_DATA=cms`, `CMS_EMAIL` and `CMS_PASSWORD="<password>"` (keep the quotes; a `#` would otherwise cut the password off).

## Test

```powershell
npm test               # sample tools, CMS tools, and the full OAuth flow, all against fakes (no CMS needed)
npm run typecheck
npx tsx scripts/oauth-check.ts http://localhost:3000             # OAuth flow against a running server + real CMS
npx tsx scripts/live-check.ts http://localhost:3000/mcp --write  # bot/sample mode; --write creates a draft guide
```

## Security notes

- **Brute force:**
  - the CMS locks an account for 15 minutes after 5 wrong passwords
  - la-mcp also limits sign-in attempts per IP
  - on Vercel that IP limit only applies within one server instance, so the CMS lockout is the real protection
- **Audit log:** CMS sign-ins through la-mcp show la-mcp's server IP, not the person's IP.
- **Open registration:** any app can register (ChatGPT needs this). Protections:
  - the sign-in page shows the app's name and where it will send the person
  - redirect addresses must be `https` (or `http://localhost`)
  - redirect addresses are checked exactly
- **Changing `MCP_TOKEN_SECRET`:** this invalidates every app's registration as well as every sign-in. Apps that keep their old `client_id` then get `invalid_client`, and have to remove and re-add the connector.
  - Keep the secret stable in production.
  - Locally, MCP Inspector v2 keeps its registration in `%USERPROFILE%\.mcp-inspector\storage\oauth.json`, not in the browser. Remove that server's entry and restart Inspector.
- **Codes:** an authorization code stays valid for its one-minute life, because la-mcp stores nothing and can't mark it as used. PKCE still means only the app that started the sign-in can use it.
- **Personal data:** contact messages leave out name, email and company, and contact details in the text are masked (see **Privacy** above).

## Files

- `server.ts`: Express app (MCP endpoint, OAuth routes, sign-in POST, host check) and the local server
- `api/index.ts`, `vercel.json`: the Vercel function
- `src/config.ts`: settings and mode selection
- `src/oauth-provider.ts`: OAuth server (registration, codes, tokens, refresh, revoke)
- `src/cms-auth.ts`: CMS sign-in, refresh and sign-out
- `src/seal.ts`: token encryption
- `src/login-page.ts`: the sign-in page
- `src/cms-client.ts`: CMS API client (bot or signed-in person)
- `src/cms-tools.ts`: CMS tools and contact-detail masking
- `src/mcp.ts`, `src/data.ts`: server builder, sample tools and data
- `test/`: `oauth.test.ts` (end to end), `cms.test.ts`, `mcp.test.ts`
