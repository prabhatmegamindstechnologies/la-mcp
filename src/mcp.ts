import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequest, getRequest, searchRequests } from "./data.js";
import type { CmsClient } from "./cms-client.js";
import { registerCmsTools } from "./cms-tools.js";

const SAMPLE_NOTE = "NOTE: this is SAMPLE data from the LiveAccess MCP proof of concept, not real plant data.";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: `${SAMPLE_NOTE}\n${JSON.stringify(data, null, 2)}` }] };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** No CMS client means sample mode (in-memory data). */
export function buildServer(opts: { cms?: CmsClient } = {}): McpServer {
  const server = new McpServer({ name: "liveaccess", version: "0.2.0" });
  if (opts.cms) registerCmsTools(server, opts.cms);
  else registerSampleTools(server);
  return server;
}

function registerSampleTools(server: McpServer) {
  server.registerTool(
    "search_service_requests",
    {
      title: "Search service requests",
      description:
        "Find LiveAccess service requests, optionally filtered by plant and status. " +
        "Use when the user asks which requests are open/closed, or what is happening at a plant. " +
        "Returns a short list; call get_service_request for full details of one request.",
      inputSchema: {
        plant: z.string().max(100).optional().describe("Plant name or part of it, e.g. 'Dahej'. Omit for all plants."),
        status: z.enum(["open", "closed", "all"]).default("open").describe("Request status filter."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ plant, status, limit }) => {
      const results = searchRequests({ plant, status, limit });
      return json({
        count: results.length,
        results: results.map(({ id, title, plant, status, priority, createdAt }) => ({ id, title, plant, status, priority, createdAt })),
      });
    }
  );

  server.registerTool(
    "get_service_request",
    {
      title: "Get service request details",
      description: "Get the full details of one LiveAccess service request by its ID (for example 'SR-1001').",
      inputSchema: {
        id: z.string().min(1).max(20).describe("Service request ID, e.g. 'SR-1001'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const found = getRequest(id);
      if (!found) return toolError(`No service request found with ID '${id}'. Use search_service_requests to find valid IDs.`);
      return json(found);
    }
  );

  server.registerTool(
    "create_service_request",
    {
      title: "Create service request",
      description:
        "Create a new LiveAccess service request for a plant. " +
        "Before calling, confirm the plant, title, description and priority with the user. Returns the created request with its new ID.",
      inputSchema: {
        plant: z.string().min(2).max(100).describe("Plant name, e.g. 'Plant B - Dahej'."),
        title: z.string().min(3).max(120).describe("Short summary of the problem."),
        description: z.string().max(2000).default("").describe("Details: symptoms, equipment tag, when it started."),
        priority: z.enum(["low", "medium", "high"]).describe("How urgent the request is."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => json({ created: createRequest(input) })
  );
}
