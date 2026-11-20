// Smoke test against a running MCP server.
//   npx tsx scripts/live-check.ts http://localhost:3000/mcp           read-only checks
//   npx tsx scripts/live-check.ts http://localhost:3000/mcp --write   also creates data (sample request, or a CMS guide draft)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
const write = process.argv.includes("--write");
const client = new Client({ name: "live-check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(url));

async function call(name: string, args: Record<string, unknown> = {}, lines = 15) {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as { text: string }[])[0].text;
  console.log(`\n--- ${name}${r.isError ? " (ERROR)" : ""}\n${t.split("\n").slice(0, lines).join("\n")}`);
  return r.isError ? null : t;
}

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

if (tools.some((t) => t.name === "get_cms_dashboard")) {
  await call("get_cms_dashboard");
  await call("search_contact_messages", { status: "all" }, 12);
  await call("list_process_areas", {}, 12);
  const guides = await call("list_guides", {}, 12);
  if (write) {
    const created = await call("create_guide_draft", { title: `MCP live check ${new Date().toISOString().slice(0, 16)}` }, 8);
    if (created) {
      const { id } = JSON.parse(created) as { id: number };
      await call("update_guide_draft", { id, summary: "Created by the MCP live check. Safe to delete." }, 8);
      console.log(`\nCreated draft guide ${id}: delete it in the CMS admin (Guides) when done.`);
    }
  } else if (guides) {
    console.log("\n(read-only run; add --write to also create and update a draft guide)");
  }
} else {
  await call("search_service_requests", { plant: "Dahej" });
  if (write) await call("create_service_request", { plant: "Plant C - Hazira", title: "Live check request", priority: "low" }, 6);
}

await client.close();
