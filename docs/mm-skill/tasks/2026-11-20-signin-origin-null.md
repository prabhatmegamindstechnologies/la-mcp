# Bug: "Sign-in refused" in a real browser

- Date: 2026-11-20
- Flow: BUG_FIX
- Status: DONE. `npm test` passes 37/37. The user signed in through MCP Inspector in a real browser on 2026-11-20: Inspector shows "Connected", and `initialize` and `tools/list` returned OK.
- Follow-up found along the way: Inspector v2 caches its OAuth registration in `%USERPROFILE%\.mcp-inspector\storage\oauth.json`. After a local server restart with a new `MCP_TOKEN_SECRET`, that entry gave `invalid_client` until it was removed. This is documented in the README.

## Symptom

MCP Inspector opens the sign-in page. Submitting it returns 403 "Sign-in refused: This sign-in form was sent from another site." (`POST /oauth/login`).

## Root cause

`src/login-page.ts` sends `Referrer-Policy: no-referrer`. Under the Fetch standard, a POST whose referrer policy is `no-referrer` is sent with `Origin: null`. `signInRoute` in `server.ts` only accepts an `Origin` equal to `MCP_PUBLIC_URL`'s origin, so it refuses `null`.

The tests missed it because they set `Origin` by hand instead of letting a browser choose it.

## Fix

1. `src/login-page.ts`: change `Referrer-Policy` to `same-origin`. The browser then sends the real `Origin` on our own form POST, and other sites still get no referrer, so the redirect back to the app leaks nothing. Keep the strict `Origin` check; don't start accepting `null`, because a sandboxed frame or a page on another site could also send `null`.
2. `test/oauth.test.ts`:
   - assert the sign-in page doesn't use `no-referrer`
   - assert a POST with `Origin: null` is still refused
3. Verify:
   - `npm test`
   - restart the local OAuth server
   - the user signs in through Inspector in the browser
