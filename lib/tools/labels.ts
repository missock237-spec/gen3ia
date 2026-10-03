/**
 * Libellés utilisateur des outils — barrière entre les identifiants
 * techniques internes (composio.execute, mcp.call, GMAIL_SEND_EMAIL…) et
 * l'interface. Aucun nom d'outil interne ne doit être visible par
 * l'utilisateur : cette couche est LA source des libellés affichés.
 *
 * Module pur (aucune dépendance) : importable côté client comme serveur.
 */

/** Libellés FR des outils internes connus (lib/tools/registry.ts). */
const TOOL_LABELS: Record<string, string> = {
  "web.search": "Recherche web",
  "web.open": "Consultation d'une page web",
  "web.api": "Service web",
  "file.read": "Lecture de fichier",
  "file.create": "Création de fichier",
  "file.modify": "Modification de fichier",
  "file.delete": "Suppression de fichier",
  "zip.analyze": "Analyse d'archive",
  "zip.create": "Création d'archive",
  "zip.extract": "Extraction d'archive",
  "artifact.create": "Création de document",
  "artifact.download": "Téléchargement de document",
  "memory.read": "Consultation de la mémoire",
  "memory.write": "Enregistrement en mémoire",
  "terminal.execute": "Commande en environnement isolé",
  "camera.capture": "Prise de vue",
  "ads.read": "Consultation publicitaire",
  "ads.publish": "Publication publicitaire",
  "github.create_repository": "Création de dépôt GitHub",
  "voice.speak": "Génération de voix",
  "voice.list": "Consultation des voix",
  "phone.call": "Appel téléphonique IA",
  "code.execute": "Exécution de code",
  "code.simulate": "Simulation de code",
  "knowledge.search": "Recherche dans les documents",
  "agent.delegate": "Délégation à un sous-agent",
  "schedule.create": "Planification d'une tâche",
  "network.list": "Consultation des équipes d'agents",
  "network.send_message": "Message à un agent coéquipier",
  "network.read_inbox": "Lecture de la boîte d'équipe",
  "network.mark_read": "Marquage d'un message d'équipe lu",
};

/** Libellés des familles d'outils identifiés par préfixe. */
const TOOL_PREFIX_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "composio.", label: "Application connectée" },
  { prefix: "mcp.", label: "Outil externe connecté" },
  { prefix: "web.", label: "Accès web" },
  { prefix: "image.", label: "Génération d'image" },
];

/**
 * Libellé lisible d'un nom d'outil interne.
 * « composio.execute » → « Application connectée » ·
 * « web.search » → « Recherche web » · inconnu → formatage générique
 * (jamais le slug brut : séparateurs remplacés, première lettre capitale).
 */
export function toolLabel(toolName?: string | null): string {
  if (!toolName?.trim()) return "Outil interne";
  const key = toolName.trim();
  const exact = TOOL_LABELS[key];
  if (exact) return exact;
  for (const { prefix, label } of TOOL_PREFIX_LABELS) {
    if (key.startsWith(prefix)) return label;
  }
  return humanizeTechnicalName(key);
}

/**
 * Libellé d'une approbation : combine l'outil et, si présent, l'action
 * métier du connecteur (ex. « GMAIL_SEND_EMAIL » → « Gmail — send email »).
 * Le nom interne de l'outil n'est jamais affiché.
 */
export function approvalToolLabel(toolName?: string | null, toolSlug?: string | null): string {
  const base = toolLabel(toolName);
  if (!toolSlug?.trim()) return base;
  const human = humanizeConnectorAction(toolSlug);
  if (!human) return base;
  // Si le libellé de base est déjà générique (« Application connectée »),
  // l'action humanisée est plus informative : on la préfère.
  if (base === "Application connectée" || base === "Outil externe connecté") return human;
  return `${base} — ${human}`;
}

/**
 * Humanise un identifiant technique : « CODE_RUN_STEP » → « Code Run Step ».
 * Les séparateurs techniques (underscore, point, tiret) deviennent des espaces.
 */
export function humanizeTechnicalName(raw: string): string {
  const cleaned = raw.replace(/[._\-]+/g, " ").trim();
  if (!cleaned) return "Outil interne";
  return cleaned
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Humanise une action de connecteur : « GMAIL_SEND_EMAIL » →
 * « Gmail — send email » (l'app est mise en valeur, l'action reste lisible
 * dans sa langue d'origine — les catalogues de connecteurs ne sont pas
 * traduits, mais aucun identifiant interne ne fuite).
 */
export function humanizeConnectorAction(slug: string): string {
  const parts = slug.trim().split(/[_\-.]+/).filter(Boolean);
  if (parts.length === 0) return "";
  const [toolkit, ...action] = parts;
  const toolkitLabel = toolkit.charAt(0).toUpperCase() + toolkit.slice(1).toLowerCase();
  if (action.length === 0) return toolkitLabel;
  return `${toolkitLabel} — ${action.map((word) => word.toLowerCase()).join(" ")}`;
}
