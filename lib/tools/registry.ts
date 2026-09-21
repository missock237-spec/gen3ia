import type { ToolDefinition } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    const id = tool.id ?? tool.name;
    if (this.tools.has(id)) throw new Error(`Tool already registered: ${id}`);
    this.tools.set(id, { ...tool, id });
    if (tool.name !== id && !this.tools.has(tool.name)) this.tools.set(tool.name, { ...tool, id });
  }

  get(toolId: string): ToolDefinition | undefined {
    return this.tools.get(toolId);
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  list(): ToolDefinition[] {
    return [...new Map([...this.tools.values()].map((tool) => [tool.id ?? tool.name, tool])).values()];
  }
}

export interface Gen3iaToolDefinition {
  name: string;
  description: string;
  risk: "read" | "write" | "external" | "destructive";
  permission: string;
  sideEffect: boolean;
}

export const GEN3IA_TOOLS: Gen3iaToolDefinition[] = [
  { name: "web.search", description: "Search the public web.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "web.open", description: "Open and extract text from a public web page.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "file.read", description: "Read a workspace file.", risk: "read", permission: "file.read", sideEffect: false },
  { name: "file.create", description: "Create a workspace file.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "file.modify", description: "Modify a workspace file.", risk: "write", permission: "file.write", sideEffect: true },
  { name: "zip.analyze", description: "Analyze a ZIP archive safely.", risk: "read", permission: "file.read", sideEffect: false },
  { name: "zip.create", description: "Create and persist a ZIP artifact.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "artifact.create", description: "Create a persistent document artifact.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "artifact.download", description: "Download an authorized artifact.", risk: "read", permission: "file.read", sideEffect: false },
  { name: "zip.extract", description: "Extract a ZIP archive into the authorized workspace.", risk: "write", permission: "file.create", sideEffect: true },
  { name: "file.delete", description: "Delete an authorized workspace file.", risk: "destructive", permission: "file.delete", sideEffect: true },
  { name: "memory.read", description: "Read the user memory available to the agent.", risk: "read", permission: "memory.read", sideEffect: false },
  { name: "memory.write", description: "Persist a non-secret memory for the user.", risk: "write", permission: "memory.write", sideEffect: true },
  { name: "terminal.execute", description: "Run an authorized command in the isolated agent terminal.", risk: "destructive", permission: "terminal.execute", sideEffect: true },
  { name: "camera.capture", description: "Request an authorized camera capture.", risk: "external", permission: "camera.capture", sideEffect: true },
  { name: "ads.read", description: "Read data from an authorized advertising account.", risk: "read", permission: "ads.read", sideEffect: false },
  { name: "ads.publish", description: "Publish an advertising action to an authorized account.", risk: "external", permission: "ads.write", sideEffect: true },
  { name: "github.create_repository", description: "Create a GitHub repository for a generated project.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "voice.speak", description: "Generate natural voice audio from text.", risk: "external", permission: "tool.external", sideEffect: false },
  { name: "voice.list", description: "List available voice profiles.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "phone.call", description: "Place a bounded outbound AI phone call.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "code.execute", description: "Execute code in the isolated sandbox.", risk: "external", permission: "code.execute", sideEffect: true },
  { name: "composio.execute", description: "Execute an authorized external action.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "mcp.call", description: "Execute a tool exposed by one of the user's connected MCP servers (Google Drive, GitHub, databases, etc.) using { serverId, tool, args }.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "messaging.send", description: "Send a WhatsApp, Telegram or Slack message from the agent.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "email.send", description: "Send an email from the agent on behalf of the platform.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "social.publish", description: "Publish content on a connected social platform via Composio.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "webhook.emit", description: "Emit a signed Gen3ia event to the user's declared outgoing webhook endpoints.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "ui.components", description: "Search and retrieve professional UI components from the 21st.dev catalog (code agents only).", risk: "read", permission: "tool.external", sideEffect: false },
  { name: "notion.search", description: "Search pages and databases in the authorized Notion workspace.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "notion.create_page", description: "Create a page in the authorized Notion workspace.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "jules.create_task", description: "Start an asynchronous coding task with the Jules agent on a GitHub repository.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "jules.get_task", description: "Read the state of a Jules coding session.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "cloudflare.zones.list", description: "List Cloudflare zones accessible to the integration.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "cloudflare.dns.list", description: "List DNS records of a Cloudflare zone.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "cloudflare.dns.create", description: "Create a DNS record in an authorized Cloudflare zone.", risk: "external", permission: "tool.external", sideEffect: true },
];
