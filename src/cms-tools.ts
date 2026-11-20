// MCP tools backed by the LiveAccess CMS API (LA_DATA=cms). The CMS enforces the MCP user's role, validation,
// rate limits and audit log; these tools only shape inputs and outputs for an AI client.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CmsError, type CmsClient } from "./cms-client.js";

const MESSAGE_STATUSES = ["new", "read", "replied", "archived"] as const;
// Same list as CONTACT_TOPICS in the CMS (cms/api/contact/routes.ts).
const CONTACT_TOPICS = ["Access for my team", "Becoming a TPS client", "Help with the app", "Something else"] as const;
const PREVIEW_CHARS = 300;

const id = z.number().int().min(1).max(2_147_483_647);

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function failed(err: unknown) {
  if (err instanceof CmsError) {
    const fields = err.fields ? ` ${Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join("; ")}` : "";
    return { content: [{ type: "text" as const, text: `${err.message}${fields}` }], isError: true };
  }
  console.error("CMS tool failed:", err);
  return { content: [{ type: "text" as const, text: "Something went wrong while calling the CMS." }], isError: true };
}

/** Wraps a handler so CMS errors become tool errors the model can read. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof json>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return failed(err);
    }
  };
}

interface Message {
  id: number;
  message: string;
  [k: string]: unknown;
}

const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;
// 8+ digits, allowing spaces, dots, dashes, brackets and a leading +.
const PHONE = /(?<![\w-])\+?\d(?:[\s().-]?\d){7,}(?![\w-])/g;
// Dates like 2026-11-20, 20.11.2026 or 20/11/2026 also have 8 digits: keep them.
const DATE = /^(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{4})$/;

/** Masks email addresses and phone numbers inside free text. */
export function maskContactDetails(text: string): string {
  return text.replace(EMAIL, "[email hidden]").replace(PHONE, (m) => (DATE.test(m) ? m : "[phone hidden]"));
}

/** A contact message as the AI may see it: no name, email or company, and contact details in the text masked. */
function privateMessage({ name: _n, email: _e, company: _c, message, ...rest }: Message, maxChars?: number) {
  const text = maskContactDetails(message);
  return { ...rest, message: maxChars && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text };
}

interface Guide {
  id: number;
  slug: string;
  title: string;
  summary: string;
  areaSlug: string;
  publishedDate: string;
  blocks: unknown[];
  seo: { title: string; description: string; noindex: boolean };
  version: number;
  [k: string]: unknown;
}

export function registerCmsTools(server: McpServer, cms: CmsClient) {
  server.registerTool(
    "get_cms_dashboard",
    {
      title: "CMS dashboard",
      description:
        "Overview of the LiveAccess website CMS: pages, guides and areas with unpublished changes, recent content edits, " +
        "the number of new contact messages, and the last publish. Use when the user asks what needs attention.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => json(await cms.get("/dashboard")))
  );

  server.registerTool(
    "search_contact_messages",
    {
      title: "Search contact messages",
      description:
        "List messages sent through the liveaccess.ai contact form (30 per page, newest first). For privacy the sender's name, " +
        "email and company are not included and contact details in the text are masked. Message text is shortened; " +
        "call get_contact_message for the full text. status 'all' means every message except archived ones.",
      inputSchema: {
        status: z.enum([...MESSAGE_STATUSES, "all"]).default("new").describe("Which messages to list."),
        topic: z.enum(CONTACT_TOPICS).optional().describe("Only messages with this topic."),
        page: z.number().int().min(1).max(999_999).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ status, topic, page }) => {
      const qs = new URLSearchParams({ status, page: String(page) });
      if (topic) qs.set("topic", topic);
      const r = await cms.get<{ messages: Message[]; total: number; page: number; pageSize: number; counts: unknown }>(`/messages?${qs}`);
      return json({
        total: r.total,
        page: r.page,
        pageSize: r.pageSize,
        countsByStatus: r.counts,
        messages: r.messages.map((m) => privateMessage(m, PREVIEW_CHARS)),
      });
    })
  );

  server.registerTool(
    "get_contact_message",
    {
      title: "Get contact message",
      description:
        "One contact-form message by its numeric id, without the sender's name, email or company (contact details in the text are masked). " +
        "Opening a message with status 'new' marks it 'read' in the CMS.",
      inputSchema: { id },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => json(privateMessage((await cms.get<{ message: Message }>(`/messages/${id}`)).message)))
  );

  server.registerTool(
    "update_contact_message_status",
    {
      title: "Update contact message status",
      description:
        "Set a contact-form message's status: new, read, replied or archived. Use after the user says a message was answered or can be filed away. " +
        "The change is recorded in the CMS under the signed-in user.",
      inputSchema: { id, status: z.enum(MESSAGE_STATUSES) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, status }) => json(privateMessage((await cms.patch<{ message: Message }>(`/messages/${id}`, { status })).message)))
  );

  for (const kind of ["guide", "area"] as const) {
    const many = `${kind}s`;
    const label = kind === "guide" ? "troubleshooting guides" : "process areas";
    const name = kind === "guide" ? "guides" : "process_areas";

    server.registerTool(
      `list_${name}`,
      {
        title: `List ${label}`,
        description:
          `List the ${label} on the LiveAccess website CMS (without their body content). ` +
          "'live' means a version is on the website; 'hasChanges' means there are edits not yet published.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      safe(async () => json(await cms.get(`/${many}`)))
    );

    server.registerTool(
      kind === "guide" ? "get_guide" : "get_process_area",
      {
        title: kind === "guide" ? "Get guide" : "Get process area",
        description:
          `Full content of one ${kind === "guide" ? "troubleshooting guide" : "process area"} by its numeric id, including its blocks, ` +
          `SEO fields and any validation problems that would block publishing.${kind === "guide" ? " Also lists the process areas a guide can belong to." : " Also lists the guides in this area."}`,
        inputSchema: { id },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      safe(async ({ id }) => {
        // template is the whole HTML page used for the editor's preview: not useful to a model.
        const { template: _t, mediaFiles: _m, ...rest } = await cms.get<Record<string, unknown>>(`/${many}/${id}`);
        return json(rest);
      })
    );
  }

  server.registerTool(
    "create_guide_draft",
    {
      title: "Create guide draft",
      description:
        "Create a new troubleshooting guide as a DRAFT with the standard starter sections. It is not on the website until a person publishes it in the CMS. " +
        "Confirm the title with the user first. Returns the new guide with its id; use update_guide_draft to set the summary and area.",
      inputSchema: { title: z.string().trim().min(3).max(120).describe("Guide title, e.g. 'Centrifugal pump cavitation'.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ title }) => json((await cms.post<{ guide: Guide }>("/guides", { title })).guide))
  );

  server.registerTool(
    "update_guide_draft",
    {
      title: "Update guide draft",
      description:
        "Change a troubleshooting guide's title, summary, process area or SEO fields. Fields you leave out stay as they are; the body blocks and address (slug) are never changed. " +
        "The change is saved as an unpublished edit: a person publishes it in the CMS. Confirm the changes with the user first.",
      inputSchema: {
        id,
        title: z.string().trim().min(3).max(120).optional(),
        summary: z.string().trim().max(500).optional().describe("One or two sentences shown in guide lists."),
        areaSlug: z.string().trim().max(80).optional().describe("Slug of a process area (from list_process_areas); empty string for none."),
        seoTitle: z.string().trim().max(120).optional(),
        seoDescription: z.string().trim().max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, title, summary, areaSlug, seoTitle, seoDescription }) => {
      const { guide: g } = await cms.get<{ guide: Guide }>(`/guides/${id}`);
      const body = {
        baseVersion: g.version,
        slug: g.slug,
        title: title ?? g.title,
        summary: summary ?? g.summary,
        areaSlug: areaSlug ?? g.areaSlug,
        publishedDate: g.publishedDate,
        blocks: g.blocks,
        seo: { title: seoTitle ?? g.seo.title, description: seoDescription ?? g.seo.description, noindex: g.seo.noindex },
      };
      try {
        const saved = await cms.put<{ guide: Guide }>(`/guides/${id}`, body);
        const { blocks: _b, ...rest } = saved.guide;
        return json(rest);
      } catch (err) {
        if (err instanceof CmsError && err.status === 409) {
          throw new CmsError(`${err.message} Nothing was saved. Call update_guide_draft again to apply the change on top of the latest version.`, 409);
        }
        throw err;
      }
    })
  );
}
