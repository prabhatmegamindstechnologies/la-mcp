# Task: Per-user OAuth sign-in + Vercel deployment

- Date: 2026-11-20
- Flow: FEATURE
- Status: BUILT and verified locally against the real CMS. Vercel deploy and the ChatGPT / Copilot connections are waiting on the user (Vercel account, admin access).

## Outcome (2026-11-20)

- `npm test`: 36/36 pass. That's 5 sample, 18 CMS (including privacy and config), and 13 end-to-end OAuth tests against a fake CMS. `npm run typecheck`: clean, now also covering `api/` and `scripts/`.
- `scripts/oauth-check.ts` against the **real local CMS** in OAuth mode (`MCP_PUBLIC_URL=http://localhost:3000`):
  - discovery and register: 201
  - sign-in page: 200
  - wrong password: 401 with "Email or password is wrong."
  - sign-in: 302 back to the redirect address
  - token: 200, `expires_in` 899, with a refresh token
  - `/mcp` without a token: 401 with `resource_metadata`
  - all 10 tools listed; dashboard and messages read as the signed-in person
  - refresh: 200
  - revoke: 200; a later refresh gets 400 `invalid_grant`, "Your LiveAccess CMS session has ended"
- Found by tests and fixed: phone-number masking also hid dates like `2026-11-20`. Date-shaped matches are now kept.
- Changes from the plan:
  - `express-rate-limit` is now a direct dependency (8.7.5, already installed by the SDK).
  - Bot credentials are only refused when `MCP_PUBLIC_URL` isn't localhost, so a local OAuth try-out works with the existing `.env`.
  - Added `scripts/oauth-check.ts`.
- Not verified yet:
  - the Vercel build: `@vercel/node` compiling the `.js`-suffixed imports with TypeScript 7 (the CMS uses the same TypeScript on Vercel)
  - ChatGPT and Copilot Studio connections; the menu names in the README are from memory
- Security pass:
  - **Encryption:** sealed tokens (AES-256-GCM, a type tag bound as associated data, expiry), checked by tests for tampering, wrong kind and a foreign key.
  - **Nothing readable inside:** no password, session cookie or CMS token is readable in issued tokens (test).
  - **Redirects:** https only, or localhost; exact match at authorize and at token exchange.
  - **Sign-in page:** CSP `default-src 'none'`, can't be framed, rejects other `Origin`s, escapes the app name (test).
  - **Rest:** the host check now includes the public host; no stack traces sent to clients; the privacy masking is tested.

## Goal

**Done =** la-mcp runs on Vercel (Singapore) at a public HTTPS URL. ChatGPT Business, Copilot Studio and MCP Inspector can add it as an MCP server. Each person signs in with **their own CMS email and password**, every CMS change is recorded under their name, and contact messages reach the AI tools without name, email or company. `npm test` and `npm run typecheck` pass. The full sign-in flow is tested end to end, locally and on the deployed URL.

## Decisions (from brainstorm)

| # | Decision | Rejected |
|---|---|---|
| 1 | Sign-in with CMS accounts. la-mcp is its own OAuth server; its sign-in page checks the person's email and password against the CMS. | Microsoft Entra ID (needs IT setup and a CMS change, and ChatGPT's automatic client registration doesn't work with it) |
| 2 | Hosting: Vercel, region `sin1` (same as the CMS) | Azure, own VM |
| 3 | Privacy: contact messages without `name`, `email`, `company`; email addresses and phone numbers in the message text are masked | Sending everything; removing the message tools |
| 4 | Writes unchanged: message status, guide draft create and update (metadata) | Guide body editing, area editing |
| 5 | Any CMS user can connect (editors and super admins). The CMS's own role checks decide what each person can do. | An allow-list |

## How sign-in works

1. ChatGPT, Copilot or Inspector reads `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` from la-mcp, registers itself (`POST /register`, dynamic client registration), then opens `/authorize` in the user's browser.
2. la-mcp shows a **sign-in page**. It says which app is asking (for example "ChatGPT wants to use your LiveAccess CMS account") and has email and password fields.
3. la-mcp calls the CMS `POST /auth/login` with those details. The password is passed through and never stored.
   - On success the CMS returns a 15-minute access token and its `la_refresh` session cookie. la-mcp keeps both, **encrypted inside the tokens it hands out**.
   - Wrong password, a locked account or a temporary password each show the CMS's message on the page.
4. la-mcp redirects back to the app with a one-minute authorization code (PKCE S256 required). The app swaps the code for:
   - **an access token:** contains the person's CMS access token, valid 15 minutes, the same as the CMS token
   - **a refresh token:** contains the CMS session cookie. When the access token runs out, the app uses it; la-mcp calls the CMS `/auth/refresh` and returns a new access token.
5. Every `/mcp` call needs `Authorization: Bearer …`. la-mcp decrypts it and calls the CMS **as that person**.

How long people stay connected follows the CMS session rules: it ends after **8 hours unused** or **7 days** at most, after which the app asks the person to sign in again. Signing out or changing the password in the CMS ends it too. Revoking the token in the app calls the CMS `/auth/logout`.

### Why the tokens are encrypted instead of stored

Vercel functions keep no memory between requests, and adding a database or Redis is an extra moving part. So everything la-mcp issues is sealed with **AES-256-GCM** using `MCP_TOKEN_SECRET`: client registrations, authorization codes, access tokens and refresh tokens. Nothing is stored on la-mcp's side; the CMS session stays the single source of truth.

Trade-off: an authorization code can't be marked as used, so it can be swapped twice within its one-minute life. PKCE still requires the code verifier, which only the app that started the sign-in has. This is the accepted risk for not having a store. Rotating `MCP_TOKEN_SECRET` signs everyone out.

## Changes

| File | Change |
|---|---|
| `src/seal.ts` | new: `seal(obj, ttl)` / `unseal(token)`, AES-256-GCM with a key derived from `MCP_TOKEN_SECRET`, a type tag per token kind (so a refresh token can't be used as an access token), and an expiry |
| `src/oauth-provider.ts` | new: implements the SDK's `OAuthServerProvider` (client store without storage, authorize renders the sign-in page, code and refresh exchange via the CMS, verify, revoke) |
| `src/login-page.ts` | new: the sign-in page. Plain HTML, no external assets. CSP `default-src 'none'`, `frame-ancestors 'none'`. Shows the app name and redirect host. POSTs to `/oauth/login` with the sealed request and checks `Origin`. |
| `src/cms-client.ts` | split the token source: `BotAuth` (today's email and password from `.env`, local development only) and `UserAuth` (the signed-in person's CMS token from the bearer token). A 401 in user mode becomes "Your CMS session ended. Reconnect the LiveAccess connector." Add `login()`, `refresh(cookie)` and `logout()` helpers that return the session cookie and CSRF token. |
| `src/cms-tools.ts` | messages: drop `name`, `email`, `company`, mask emails and phone numbers in `message`, and remove the `query` filter (it searched names and emails). Tool descriptions say which CMS user acts. |
| `src/config.ts` | new settings: `MCP_PUBLIC_URL` (for example `https://<project>.vercel.app`). When set, **OAuth is required**, `MCP_TOKEN_SECRET` must be at least 32 characters, and bot credentials are refused. Without it, today's local modes stay as they are. |
| `server.ts` | host check: allows `localhost` plus the host of `MCP_PUBLIC_URL`. In OAuth mode it mounts `mcpAuthRouter` and `requireBearerAuth` on `/mcp`, and sets `trust proxy` for Vercel's forwarded IP so the SDK's rate limits work. Exports the app for Vercel. |
| `api/index.ts`, `vercel.json` | new: Vercel function wrapping the Express app, region `sin1`, rewrite of every path to it. I'm guessing at Vercel's current way to host an Express app; I'll verify it against the Vercel docs and a preview deploy. |
| `test/oauth.test.ts` | new, end-to-end against the Express app with a fake CMS: discovery metadata, register, sign-in page, wrong password, correct password, code, token, `tools/list` with the bearer token, refresh, no token or a tampered token or an expired token gives 401, an unregistered redirect URI is refused, a wrong PKCE verifier is refused, a refresh token is refused as an access token |
| `test/cms.test.ts` | adds the privacy assertions (no name, email or company; masking) |
| `README.md`, `.env.example` | deployment steps, environment variables, connection steps for ChatGPT, Copilot Studio and Inspector |

Sample mode and local bot mode stay for development and tests.

## Security

- **Passwords:** go only from the sign-in page to the CMS over HTTPS. They're never logged or stored, and never appear in tokens.
- **Tokens:**
  - sealed, so a client can't read or change them
  - a type tag per token kind, so one kind can't be used as another
  - an audience check against `MCP_PUBLIC_URL/mcp`
- **Dynamic client registration is open,** because ChatGPT needs it. Protections:
  - the sign-in page names the app and the redirect host
  - redirect URIs must be `https`, or `http://localhost` for Inspector
  - the exact redirect URI is checked at `/authorize` and at token exchange
- **Brute force:**
  - the CMS locks an account after 5 failures
  - the SDK rate-limits the OAuth endpoints, and I add a per-IP limit on `/oauth/login`
  - on serverless these in-memory limits are per instance, so best effort only; the CMS lockout is the real protection
- **CMS audit log:** sign-ins from la-mcp show **la-mcp's server IP**, not the person's. That's acceptable for now and is documented.
- **Clickjacking:** the sign-in page can't be framed and loads nothing external.
- **CMS repo:** no change needed. Server-to-server calls send no `Origin` header (checked earlier), and the refresh and logout routes work with the cookie and CSRF token that la-mcp holds.

## Verification

1. `npm test` (sample, CMS and OAuth end-to-end) plus `npm run typecheck`, with output pasted.
2. Local: run with `MCP_PUBLIC_URL=http://localhost:3000` (an http exception for localhost), then MCP Inspector, sign in with a real CMS account, run tools, and check that the CMS audit log shows that person's name.
3. Vercel preview deploy: the same check in Inspector against the HTTPS URL.
4. You: add the connector in ChatGPT Business and in Copilot Studio (I'll write the exact steps).

## Needs from you

- **Vercel:** a Vercel project for la-mcp. Either push la-mcp to a Git repo (it isn't one yet; I can run `git init` and make the first commit) and import it in Vercel, or log in with the Vercel CLI here.
- **Production CMS URL:** I'm assuming `https://liveaccess.ai/la-studio/api`, based on the CMS code comments. Please confirm.
- **Domain:** the Vercel URL to start with; a custom domain such as `mcp.liveaccess.ai` can be added later in Vercel.
- **Admin access:** ChatGPT Business needs a workspace admin to allow custom connectors, and Copilot Studio needs access to an environment where you can build agents.
- **Not code:** rotate the Neon password (separate from this task).

## Out of scope

Guide body editing, area editing, Microsoft Entra sign-in, a persistent token store, and changes to the CMS repo.
