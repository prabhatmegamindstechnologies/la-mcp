# Task: Connect la-mcp to the LiveAccess CMS API

- Date: 2026-11-20
- Flow: FEATURE
- Status: DONE. Live check against the real CMS passed (2026-11-20)

## Live check against the real CMS

- Server printed `MCP on http://localhost:3000/mcp (CMS at http://localhost:8787/la-studio/api)` and listed all 10 CMS tools.
- Dashboard, messages (0 in the inbox), process areas and guides were read from the real CMS. Draft guide **id 37** was created and its summary updated; delete it in the admin.
- First attempt failed:
  - `.env` still said `LA_DATA=sample`.
  - Then the CMS refused the sign-in, because the unquoted `#` in `CMS_PASSWORD` cut the password from 12 characters to 10.
  - Fixed by quoting the value. The 60 s cooldown meant only one failed sign-in reached the CMS.

## Outcome (2026-11-20)

- `npm test`: 20/20 pass (5 sample + 15 CMS against a fake CMS). `npm run typecheck`: clean.
- Sample mode live over HTTP: `MCP on http://localhost:3099/mcp (sample data)`, and live-check listed 3 tools and searched.
- CMS mode without settings stops with: `LA_DATA=cms needs CMS_API_URL, CMS_EMAIL, CMS_PASSWORD (set them in .env).`
- Checked: Node `fetch` sends no `Origin` / `Sec-Fetch-Site`, so the CMS's cross-site guard lets la-mcp's writes through.
- Checked: `process.loadEnvFile` doesn't override variables already set in the shell.
- Changes from the plan:
  - `.env` is loaded in `server.ts` (`process.loadEnvFile`) instead of an npm script flag.
  - After a failed sign-in the client waits 60 s before trying again, to protect against the CMS's 5-failure lockout.
  - CMS mode refuses a non-https `CMS_API_URL` unless it points to localhost.
  - `live-check.ts` only writes with `--write`.
- Security pass:
  - The password is only in `.env` (git-ignored) and the login body. Errors and logs never include it, and a test covers this.
  - Ids are validated as integers and query text goes through `URLSearchParams`, so tool input can't inject into paths.
  - No delete or publish tools; the bot user is an Editor.
  - The personal-data warning is in the README.

## Goal

**Done =** with `LA_DATA=cms`, la-mcp signs in to the CMS API (`http://localhost:8787/la-studio/api`) as a dedicated editor user and its tools read and write real CMS data (contact messages, guides, areas, dashboard). With `LA_DATA=sample` (the default) it keeps working on in-memory sample data. `npm test` and `npm run typecheck` pass, and a live check against the running CMS works.

## Decisions (from brainstorm)

| # | Decision | Rejected |
|---|---|---|
| 1 | Tools for CMS data: contact messages, guides/areas, dashboard. Writes: change a message's status, create/update guide **drafts**. Publishing stays with a human. | Keeping service-request tools (the CMS has no such data) |
| 2 | One dedicated CMS user (`editor` role, not super admin). Email + password in la-mcp `.env`. Every change shows in the CMS audit log as that user. | Per-user OAuth (later phase) |
| 3 | Call the CMS HTTP API, so its validation, role checks, rate limits and audit log still apply. | Reading the Neon database directly |
| 4 | Keep sample mode: `LA_DATA=sample` (default) or `LA_DATA=cms`. | Removing the sample data |

## What the CMS API does (read from `D:\LiveAccess-Website-CMS\cms\api`)

- Base: `/<ADMIN_PATH>/api`, with `ADMIN_PATH=la-studio` and local port `8787`.
- Sign-in: `POST /auth/login` `{email, password}` (needs `Content-Type: application/json`) returns `{ accessToken, expiresIn: 900 }`. Every other route needs `Authorization: Bearer <token>`.
  - Refresh uses a browser cookie, so la-mcp **signs in again** when the token is about to expire or a call returns 401.
  - **5 wrong passwords lock the account for 15 minutes.** la-mcp must never retry sign-in in a loop: one try per tool call, then a clear error.
  - A user on a temporary password gets `403 passwordChangeRequired`. The bot user must change its password once in the admin UI before use.
- Changes (`POST/PUT/PATCH/DELETE`) are refused only if `Origin` is from another host. Server-to-server calls send no `Origin`, so they pass.
- Messages: `GET /messages?status=new|read|replied|archived|all&topic=&q=&page=` (30 per page). `GET /messages/:id` **marks a new message as read** (side effect). `PATCH /messages/:id {status}`.
- Guides/areas: `GET /guides`, `GET /guides/:id` (full blocks), `POST /guides {title}` (creates a draft with a starter template), `PUT /guides/:id` (needs `baseVersion`; returns 409 if someone else changed it). Same for `/areas`. Rate limit 120 saves/min (areas: 30/min).
- Dashboard: `GET /dashboard` returns content waiting to publish, recent activity, the count of new messages, and the last publish.

## Tools

The sample-mode tools (`search_service_requests`, `get_service_request`, `create_service_request`) stay **only** in sample mode. CMS mode registers these instead:

| Tool | CMS call | Annotations | Notes |
|---|---|---|---|
| `get_cms_dashboard` | `GET /dashboard` | readOnly | What needs attention |
| `search_contact_messages` | `GET /messages` | readOnly | Inputs: `status` (default `new`), `topic`, `query`, `page` |
| `get_contact_message` | `GET /messages/:id` | **not readOnly**, idempotent | Opening a new message marks it read; the description says so |
| `update_contact_message_status` | `PATCH /messages/:id` | write, idempotent, not destructive | `new` / `read` / `replied` / `archived` |
| `list_guides` / `list_process_areas` | `GET /guides`, `GET /areas` | readOnly | Without block contents |
| `get_guide` / `get_process_area` | `GET /guides/:id`, `GET /areas/:id` | readOnly | Blocks as returned, plus `problems` |
| `create_guide_draft` | `POST /guides` | write, not idempotent | Title only; returns the new draft with its id |
| `update_guide_draft` | `GET /guides/:id` then `PUT /guides/:id` | write, not destructive | Changes `title`, `summary`, `areaSlug`, `seo` only; keeps blocks and slug as they are; sends `baseVersion`; a 409 is shown as "changed by someone else, try again" |

Not included: delete tools, publishing, pages, menus, SEO, users, media, settings. These are only available to a super admin, or are too risky for a first version.

Editing guide **blocks** (the body text) is left out of v1. The block format (`@liveaccess/shared` `validateGuide`) is complex. I can add it in a follow-up once the basic tools work.

## Files

| File | Change |
|---|---|
| `src/cms-client.ts` | new: `CmsClient` with `get`/`post`/`put`/`patch`, token cache, one sign-in on expiry or 401, 15 s timeout, CMS `{error}` messages passed through, never logs the password or token |
| `src/cms-tools.ts` | new: registers the CMS tools on the server |
| `src/mcp.ts` | `buildServer(opts)` registers sample tools or CMS tools based on mode |
| `src/config.ts` | new: reads `LA_DATA`, `CMS_API_URL`, `CMS_EMAIL`, `CMS_PASSWORD`. In CMS mode it stops at startup with a clear message if any is missing |
| `server.ts` | loads config, passes it to `buildServer`. Still bound to `127.0.0.1` |
| `.env.example` | new, placeholders only (no real values) |
| `.gitignore` | new: `.env`, `node_modules` |
| `test/cms.test.ts` | new: tests against a **fake CMS** (small local Hono/Express app or stubbed `fetch`): sign-in, token reuse, re-sign-in on 401, no retry loop on a wrong password, message status update, guide update sends `baseVersion` and keeps blocks, 409 message |
| `test/mcp.test.ts` | unchanged (sample mode) |
| `scripts/live-check.ts` | add a CMS-mode check |
| `README.md` | CMS mode setup: create the bot user, `.env`, run both servers |

Env loading: Node 24 `--env-file-if-exists=.env` in the npm scripts, so no new dependency is needed.

## Security

- The bot user is an **editor**, so it can't delete messages, publish, or manage users (the CMS enforces this).
- Password only in `.env` (git-ignored). Never put in tool output, logs or errors.
- ⚠️ **Contact messages hold personal data** (name, email, company, message text). In CMS mode these go to whichever AI tool is connected (ChatGPT, Copilot Studio). That needs to be OK under the privacy policy before it's connected to an outside AI tool. For now it's local only.
- Still bound to `127.0.0.1`, still no la-mcp login. Don't expose it publicly until OAuth is added.
- Separate issue: `D:\LiveAccess-Website-CMS\.env.example` contains a real Neon database password. Rotate it and replace it with a placeholder (not done in this task, since it's a different repo).

## Verification

1. `npm test`: sample tests and fake-CMS tests pass (output pasted).
2. `npm run typecheck`: clean.
3. Live: CMS running (`pnpm dev:api` in the CMS repo) plus `LA_DATA=cms npm run dev`, then `scripts/live-check.ts` lists the CMS tools, reads the dashboard and messages, and creates and updates a test guide draft (deleted afterwards in the admin UI).
4. User: MCP Inspector connects and runs the tools.

## Needs from you before the live check

- The CMS running locally (`pnpm dev:api`, with `JWT_SECRET` set in its `.env`).
- An editor user for the bot, created in the admin UI (Users), with its first password change done. Its email and password go in `D:\la-mcp\.env`.
