// The sign-in page shown during OAuth. Self-contained (no scripts, fonts or images) so its CSP can block everything else.
import type { Response } from "express";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface LoginPageView {
  /** Sealed sign-in request, posted back unchanged. */
  request: string;
  /** The app's self-chosen name (untrusted). */
  clientName?: string;
  /** Where the browser goes after sign-in. Shown so a fake "ChatGPT" can't hide where it sends people. */
  redirectHost: string;
  email?: string;
  error?: string;
}

export function sendLoginPage(res: Response, view: LoginPageView, status = 200) {
  res.status(status);
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    // Not no-referrer: with it the browser sends `Origin: null` on the form POST and the sign-in is refused.
    // same-origin still sends nothing to other sites (such as the app the person is sent back to).
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  const app = view.clientName?.trim() ? esc(view.clientName.trim().slice(0, 80)) : "An AI app";
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · LiveAccess</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #5f6368; --line: #d0d4d9; --accent: #0b5cad; --err-bg: #fdecea; --err: #8a1c12; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121417; --card: #1c1f24; --text: #e8eaed; --muted: #a0a5ab; --line: #3a3f46; --accent: #6aa8f0; --err-bg: #3b1f1c; --err: #f6b3aa; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 1.3rem; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: var(--muted); }
  strong { color: var(--text); }
  label { display: block; font-weight: 600; margin: 14px 0 6px; }
  input { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text); }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 22px; font: inherit; font-weight: 600; padding: 11px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  .err { background: var(--err-bg); color: var(--err); padding: 10px 12px; border-radius: 8px; margin: 0 0 8px; }
  .small { font-size: .85rem; margin-top: 18px; margin-bottom: 0; }
</style>
</head>
<body>
<main>
  <h1>Sign in to LiveAccess CMS</h1>
  <p><strong>${app}</strong> wants to read and change LiveAccess CMS content as you. Use your CMS email and password.</p>
  ${view.error ? `<p class="err" role="alert">${esc(view.error)}</p>` : ""}
  <form method="post" action="/oauth/login">
    <input type="hidden" name="request" value="${esc(view.request)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required maxlength="254" value="${esc(view.email ?? "")}" ${view.email ? "" : "autofocus"}>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" ${view.email ? "autofocus" : ""}>
    <button type="submit">Sign in and allow</button>
  </form>
  <p class="small">After you sign in you'll be sent back to <strong>${esc(view.redirectHost)}</strong>. Changes it makes are recorded under your name. You can end access any time by signing out of the CMS.</p>
</main>
</body>
</html>`);
}

export function sendMessagePage(res: Response, status: number, title: string, text: string) {
  res.status(status);
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:420px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`);
}
