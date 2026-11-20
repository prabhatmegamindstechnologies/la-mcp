# CMS integration

The "existing API" for la-mcp is the **LiveAccess website CMS** (`D:\LiveAccess-Website-CMS`, Hono + Drizzle + Neon Postgres). It manages the liveaccess.ai website: pages, guides, process areas, menus, SEO, media, users and the contact-form inbox. It has **no service requests or plants**. Those exist only in la-mcp's sample mode.

## Decisions (2026-11-20)

- la-mcp calls the CMS **HTTP API** (`/la-studio/api`), not the database, so the CMS's validation, roles, rate limits and audit log apply.
- It signs in as **one Editor bot user** whose credentials are in `.env`. Per-user OAuth is a later phase.
- Writes are limited to: message status, and guide draft create and update (metadata only, not body blocks). No delete and no publish.
- `LA_DATA=sample` (the default) keeps the in-memory sample data.

## OAuth (2026-11-20)

- `MCP_PUBLIC_URL` set means OAuth mode. la-mcp is its own OAuth server and checks each person's CMS email and password through `/auth/login`.
- It keeps the CMS `la_refresh` cookie and CSRF token sealed inside the refresh token, and calls `/auth/refresh` and `/auth/logout` with them. No CMS change was needed.
- Nothing is stored (Vercel). Everything issued is sealed with `MCP_TOKEN_SECRET`; see `src/seal.ts`.
- Contact messages go to AI tools without name, email or company, with contact details in the text masked (decision 3b). The text search was removed.
- Hosting: Vercel `sin1`, at https://la-mcp-three.vercel.app. The code is in GitHub at prabhatmegamindstechnologies/la-mcp, under the Vercel Hobby account prabhat-5653. Pushing `main` deploys. Use the "Other" preset, not Express.
- Don't set `"types": ["node"]` in tsconfig. Vercel's TS 7 check can't resolve it (TS2688); use `/// <reference types="node" />` in `api/index.ts` and `server.ts` instead.
- Hosting: Vercel `sin1`. `api/index.ts` wraps the Express app; `vercel.json` rewrites everything to it.

- Sign-in page: never use `Referrer-Policy: no-referrer`. Browsers then send `Origin: null` on the form POST and the origin check refuses the sign-in (bug found 2026-11-20, fixed with `same-origin`).

## CMS behaviours to remember

- Access tokens last 15 minutes. Refresh needs a browser cookie, so la-mcp signs in again instead.
- 5 wrong passwords lock the account for 15 minutes, so la-mcp waits 60 s after a failed sign-in before trying again.
- `GET /messages/:id` marks a `new` message as `read`.
- `PUT /guides/:id` needs `baseVersion` and returns 409 if someone else saved first. It validates the whole guide (slug, blocks, seo…), so send the full current guide with only the changed fields replaced.
- The cross-site guard refuses changes whose `Origin` is from another host. Node `fetch` sends no `Origin`, so server-to-server calls pass.
- In `.env`, quote `CMS_PASSWORD`. Node's `.env` parser treats an unquoted `#` as the start of a comment (this broke the first live sign-in on 2026-11-20).
- Contact messages contain personal data. Clear this with the privacy policy before connecting outside AI tools.
- `D:\LiveAccess-Website-CMS\.env.example` held a real Neon password (found 2026-11-20). It should be rotated.
