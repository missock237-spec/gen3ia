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
  { name: "file.read", description: "Read a REAL file: an attachment from the owner's permanent storage (users/<uid>/permanent/...) or an authorized workspace file (input { path, workspaceId? }). Returns converted text plus metadata.", risk: "read", permission: "file.read", sideEffect: false },
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
  { name: "voice.list", description: "List available voice profiles.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "phone.call", description: "Place a bounded outbound AI phone call.", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "code.execute", description: "Execute code in the isolated sandbox.", risk: "external", permission: "code.execute", sideEffect: true },
  { name: "code.simulate", description: "Simulate code execution without side effects (VM restreinte Node, analyse statique Python/shell) et retourne le mode réel utilisé.", risk: "read", permission: "code.execute", sideEffect: false },
  { name: "knowledge.search", description: "Search the project knowledge base (indexed documents, tenant-scoped vector search).", risk: "read", permission: "file.read", sideEffect: false },
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
  { name: "custom_api.call", description: "Appelle RÉELLEMENT (GET) une API personnelle fournie par l'utilisateur et retourne la réponse réelle.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "custom_api.write", description: "Modifie RÉELLEMENT des données via une API personnelle de l'utilisateur (POST/PUT/PATCH/DELETE).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "web.api", description: "Appelle RÉELLEMENT (GET) une API publique désignée par URL et retourne la réponse réelle.", risk: "read", permission: "network.read", sideEffect: false },
  { name: "web.api.write", description: "Modifie RÉELLEMENT des données via une API publique désignée par URL (POST/PUT/PATCH/DELETE).", risk: "external", permission: "tool.external", sideEffect: true },
  { name: "network.list", description: "Liste les équipes (réseaux) d'agents du propriétaire : membres, rôles, topologie.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "network.send_message", description: "Envoie un message à un agent coéquipier du MÊME réseau (collaboration agent-à-agent).", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "network.read_inbox", description: "Lit la boîte de réception d'un agent (messages de ses coéquipiers).", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "network.mark_read", description: "Marque un message d'équipe comme lu.", risk: "read", permission: "tool.read", sideEffect: false },
  // MÉDIAS & VOIX — OUTILS INTERNES (directive 10-10 : « aucune approbation
  // pour une utilisation d'un outil interne ») : génération d'image Agnes,
  // production vidéo (file interne payante), suivi/révision, synthèse vocale
  // et analyse média opèrent UNIQUEMENT sur l'infrastructure Gen3ia — ils ne
  // touchent NI app externe NI secret utilisateur → jamais de carte de
  // validation. L'ancienne classification « external » forçait
  // requiresApproval sur CHAQUE génération (captures 07:24 : image.generate
  // et video.create bloqués par « Confirmation requise »).
  { name: "image.generate", description: "Générer une image à partir d'une description texte, avec ratio et images de référence optionnels.", risk: "write", permission: "tool.write", sideEffect: false },
  { name: "video.create", description: "Lancer une production vidéo complète autonome (script, images, voix, montage) avec paramètres de production (durée, format, résolution, langue, style, audience, plateforme, musique, formats dérivés) et suivre sa progression.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "video.status", description: "Suivre une production vidéo : étape en cours, progression réelle, avertissements, URL de lecture du master terminé.", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "video.revise", description: "Réviser ou piloter une vidéo existante : rythme, musique, voix, sous-titres, suppression de scène, pause/reprise/annulation du rendu, formats dérivés.", risk: "write", permission: "tool.write", sideEffect: true },
  { name: "media.analyze", description: "Analyser une image, un audio ou une vidéo fournie (description, transcription, extraction d'informations).", risk: "read", permission: "tool.read", sideEffect: false },
  { name: "voice.speak", description: "Generate natural voice audio from text (plateforme ElevenLabs — outil interne).", risk: "write", permission: "tool.write", sideEffect: false },
];
