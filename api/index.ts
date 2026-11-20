// Vercel Function: every path is rewritten here (vercel.json) and handled by the same Express app as the local server.
// Built on the first request, so a missing setting shows in the Function log instead of failing the deployment.
import type { IncomingMessage, ServerResponse } from "node:http";
import { appFromConfig } from "../server.js";
import { loadConfig } from "../src/config.js";

let app: ReturnType<typeof appFromConfig>["app"] | undefined;

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    app ??= appFromConfig(loadConfig(), { trustProxy: true }).app;
  } catch (err) {
    console.error("la-mcp is not configured:", (err as Error).message);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Server is not configured. See the function log." }));
    return;
  }
  return app(req as never, res as never);
}
