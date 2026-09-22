/**
 * Pont « services du projet » pour les agents.
 *
 * Les agents IA doivent pouvoir exécuter les tâches des utilisateurs avec
 * TOUS les services de la plateforme, pas seulement répondre : documents
 * (PDF/DOCX/XLSX/PPTX), fichiers et archives, code (exécution + simulation),
 * terminal isolé, recherche web, mémoire, base de connaissances, connecteurs
 * externes (Composio), serveurs MCP, messagerie et email.
 *
 * Deux fonctions :
 *  1. PROJECT_SERVICE_TOOLS — la liste canonique des outils-services sûrs,
 *     ajoutée aux politiques des agents (niveau standard et +) : un agent
 *     « universel » obtient par défaut l'accès aux services de production
 *     sans que le propriétaire doive déclarer chaque outil.
 *  2. describeProjectServicesForPrompt — le catalogue injecté dans le
 *     contexte du planificateur : il SAIT quels services existent, à quoi
 *     ils servent, et comment les nommer dans un plan.
 */

/** Outils-services sûrs (aucun effet externe irréversible) offerts à tout agent standard. */
export const PROJECT_SERVICE_TOOLS: string[] = [
  "web.search",
  "web.open",
  "file.read",
  "file.create",
  "file.modify",
  "artifact.create",
  "artifact.download",
  "zip.analyze",
  "zip.create",
  "zip.extract",
  "memory.read",
  "memory.write",
  "code.simulate",
  "knowledge.search",
];

export interface ProjectServiceDescriptor {
  /** Nom d'outil(s) à utiliser dans un plan. */
  tools: string[];

  service: string;

  usage: string;
}

/** Catalogue des services du projet, tel que vu par les agents. */
export const PROJECT_SERVICES: ProjectServiceDescriptor[] = [
  {
    tools: ["web.search", "web.open"],
    service: "Recherche et lecture web",
    usage: "Trouver des informations à jour, ouvrir une page et en extraire le contenu.",
  },
  {
    tools: ["file.read", "file.create", "file.modify"],
    service: "Fichiers du workspace",
    usage: "Lire, créer et modifier les fichiers du workspace autorisé de l'utilisateur.",
  },
  {
    tools: ["artifact.create", "artifact.download"],
    service: "Documents entreprise",
    usage: "Générer des documents finaux (PDF, DOCX, XLSX, PPTX, texte) et fournir un lien de téléchargement.",
  },
  {
    tools: ["zip.analyze", "zip.create", "zip.extract"],
    service: "Archives ZIP",
    usage: "Analyser, créer ou extraire des archives ZIP dans le workspace.",
  },
  {
    tools: ["code.simulate"],
    service: "Simulation de code",
    usage: "Valider du code sans effet externe : Node (VM restreinte), Python/Shell (analyse statique).",
  },
  {
    tools: ["code.execute", "terminal.execute"],
    service: "Exécution de code et terminal",
    usage: "Exécuter du code dans le sandbox isolé ou des commandes dans le terminal agent (agents de code, ou si la politique le permet).",
  },
  {
    tools: ["memory.read", "memory.write"],
    service: "Mémoire",
    usage: "Consulter et persister les informations durables de l'utilisateur (préférences, décisions, faits).",
  },
  {
    tools: ["knowledge.search"],
    service: "Base de connaissances",
    usage: "Chercher dans les documents indexés du projet (recherche vectorielle Qdrant, repli Firestore).",
  },
  {
    tools: ["composio.execute"],
    service: "Connecteurs externes",
    usage: "Agir sur les apps connectées de l'utilisateur (Gmail, Google Drive, GitHub, Notion, CRM, réseaux sociaux…).",
  },
  {
    tools: ["mcp.call"],
    service: "Serveurs MCP",
    usage: "Appeler les outils exposés par les serveurs MCP déclarés par l'utilisateur.",
  },
  {
    tools: ["messaging.send"],
    service: "Messagerie",
    usage: "Envoyer un message WhatsApp, Telegram ou Slack au nom de l'agent.",
  },
  {
    tools: ["email.send"],
    service: "Email",
    usage: "Envoyer un email transactionnel au nom de la plateforme.",
  },
];

/**
 * Note de contexte pour le planificateur : catalogue complet des services,
 * borné et sans coût LLM (texte statique généré localement).
 */
export function describeProjectServicesForPrompt(options?: { includeExternal?: boolean }): string {
  const includeExternal = options?.includeExternal ?? true;
  const lines: string[] = [
    "SERVICES DE LA PLATEFORME GEN3IA DISPONIBLES POUR CETTE MISSION —",
    "Tu peux et DOIS utiliser ces services en créant des étapes de plan nommées exactement avec ces outils :",
  ];
  for (const descriptor of PROJECT_SERVICES) {
    if (!includeExternal && ["composio.execute", "mcp.call", "messaging.send", "email.send"].includes(descriptor.tools[0])) continue;
    lines.push(`- ${descriptor.service} (${descriptor.tools.join(", ")}) : ${descriptor.usage}`);
  }
  lines.push("N'invente JAMAIS un nom d'outil hors de cette liste et de la liste des connecteurs actifs.");
  return lines.join("\n");
}
