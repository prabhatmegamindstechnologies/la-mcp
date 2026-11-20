# AI tool connector support for the LiveAccess MCP server

Checked 2026-11-20 against official docs (sources at the end). Our server:

- **MCP URL:** `https://la-mcp-three.vercel.app/mcp`
- **Transport:** Streamable HTTP
- **Sign-in:** OAuth 2.1 with discovery (`/.well-known/...`), dynamic client registration and PKCE. Each person signs in with their own CMS account.
- **Read-only tools** are marked with `readOnlyHint`, so the AI tools can tell them apart from tools that change data.

## Summary

| | ChatGPT | Copilot Studio | Claude |
|---|---|---|---|
| Custom MCP servers | Yes, called **plugins** | Yes, called **MCP tools** | Yes, called **custom connectors** |
| Plans | Business, Enterprise and Edu (see below) | Copilot Studio licence, trial, or Microsoft 365 Copilot | All plans; Free allows 1 custom connector |
| Read and write | Both. Writes need the user's confirmation by default. | Tools can run actions; the docs say nothing specific about writes | Both, with per-tool permissions |
| Sign-in our server needs | OAuth with DCR. Supported. | OAuth 2.0 with **Dynamic discovery** (DCR plus discovery). Supported. | OAuth with DCR. Supported. |
| Transport | Streamable HTTP or SSE | Streamable HTTP only (SSE dropped after Aug 2025) | Streamable HTTP |
| Admin needed | Business: only admins and owners can create and publish custom MCP plugins | Licence or Author role; generative orchestration on; Power Platform data policy must allow it | Team and Enterprise: an Owner adds it. Individual plans: the user adds it. |
| Tested with our server | Not yet; no account | Not yet; no account | **Yes**: signed in, dashboard read from the live CMS |

## ChatGPT

- **Plans:** OpenAI's help page lists custom MCP servers for **ChatGPT Business, Enterprise and Edu** on the web.
  - On **Business**, only admins and owners can create and publish them.
  - On Enterprise and Edu, admins can grant that right to selected members.
  - Older community posts mention Plus and Pro through "Developer mode". That isn't confirmed in the current official docs.
  - Free and Go (what we have now) show no option at all. We checked this in the account.
- **Setup:**
  1. Go to **chatgpt.com/plugins** and click **+**, then **Add custom MCP server**.
  2. Enter a name and the Server URL.
  3. Set authentication to **OAuth**.
  4. Accept the risk warning and click **Create as a plugin**.
  5. Install the plugin.
  6. In a chat, type `@` and pick the plugin.
- **Writes:** "ChatGPT supports both read and write tools." Write actions ask the user to confirm by default. Tools without `readOnlyHint` count as writes.
- **Sign-in:** OAuth, using static credentials, Client ID Metadata Documents (CIMD) or DCR. Ours uses DCR. If ChatGPT insists on CIMD, adding CIMD support is a small server change.

## Copilot Studio

- **Setup:**
  1. Open the agent's **Tools** page and go to **Add a tool → New tool → Model Context Protocol**.
  2. Fill in the name, a description (the agent uses it to decide when to call the server) and the Server URL.
  3. Choose **OAuth 2.0 → Dynamic discovery**.
  4. Click **Create**, then **Create a new connection** and sign in.
  5. Click **Add to agent**.
- **Requirements:**
  - **Generative orchestration** must be on.
  - Power Platform **data policies** apply to MCP tools.
  - Only **tools and resources** are supported; MCP prompts aren't.
- **Licensing:** a Copilot Studio user licence, a Microsoft 365 Copilot licence, pay-as-you-go (an Azure subscription billed in Copilot Credits), or the **free trial**.
  - The trial lets you build and test in the test chat, but **not publish**. That's enough to prove our server works.
- **Risk to test:** Dynamic discovery depends on the server's DCR and discovery endpoints. Ours has both and they pass our checks, but they haven't been tried with Copilot Studio yet.

## Claude

- **Plans:** custom connectors work on Free (1 connector), Pro, Max, Team and Enterprise.
- **Setup:**
  1. Go to **Settings → Connectors → Add custom connector**.
  2. Enter the URL.
  3. Sign in.
  4. Set tool permissions (for example, writes on "Needs approval").
- **Requirement:** the server must be reachable from the public internet on the standard port. Ours is.
- **Tested 2026-11-20:** connected, signed in with a CMS account, and Claude read the live CMS dashboard.

## What the company needs, cheapest first

1. **Copilot Studio free trial** with a Microsoft work account. It's enough to add our MCP tool and test it in the test chat.
2. **ChatGPT Business** workspace with at least one admin seat. Only admins and owners can create custom MCP plugins there.
3. Optional: **Claude Team**, if the company wants an Owner to add the connector for everyone. It already works on individual plans.

## Sources

- OpenAI: [Add custom MCP server (developer guide)](https://developers.openai.com/api/docs/guides/developer-mode)
- OpenAI: [Connecting custom MCP servers in ChatGPT (help center)](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Blocked to automated reads; the plan details come from its search summary.
- OpenAI community: [Write actions on a Business workspace](https://community.openai.com/t/write-actions-blocked-on-custom-mcp-server-business-plan-workspace-developer-mode-unavailable-at-workspace-level/1384381)
- Microsoft Learn: [Add an existing MCP server to an agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent) (updated 2026-11-18)
- Microsoft Learn: [Extend your agent with MCP](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp) (updated 2026-11-19)
- Microsoft Learn: [Get access to Copilot Studio (licensing, trial)](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-licensing-subscriptions)
- Anthropic: [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
