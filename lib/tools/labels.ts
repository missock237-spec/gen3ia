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
  // it.58 : file.modify retiré (fantôme — jamais d'exécuteur).
  "file.delete": "Suppression de fichier",
  "zip.analyze": "Analyse d'archive",
  "zip.create": "Création d'archive",
  "zip.extract": "Extraction d'archive",
  "artifact.create": "Création de document",
  "artifact.get": "Consultation de document",
  "memory.read": "Consultation de la mémoire",
  "memory.write": "Enregistrement en mémoire",
  "terminal.execute": "Commande en environnement isolé",
  "terminal.run": "Exécution de commande terminal",
  "camera.capture": "Prise de vue",
  "ads.read": "Consultation publicitaire",
  "ads.publish": "Publication publicitaire",
  "github.create_repository": "Création de dépôt GitHub",
  "voice.speak": "Synthèse audio (locale)",
  // it.58 : voice.list / phone.call retirés (fantômes — exécuteurs externes
  // retirés de la plateforme).
  "code.execute": "Exécution de code",
  "code.simulate": "Simulation de code",
  "knowledge.search": "Recherche dans les documents",
  "agent.delegate": "Délégation à un sous-agent",
  "schedule.create": "Planification d'une tâche",
  "network.list": "Consultation des équipes d'agents",
  "network.send_message": "Message à un agent coéquipier",
  "network.read_inbox": "Lecture de la boîte d'équipe",
  "network.mark_read": "Marquage d'un message d'équipe lu",
  "image.generate": "Génération d'image",
  "video.create": "Production vidéo",
  "video.status": "Suivi vidéo",
  "video.revise": "Révision vidéo",
  // Task 133 — connecteurs entreprise Zendesk & ServiceNow.
  "zendesk_ticket_create": "Création de ticket Zendesk",
  "zendesk_ticket_update": "Mise à jour de ticket Zendesk",
  "zendesk_ticket_list": "Consultation des tickets Zendesk",
  "zendesk_ticket_search": "Recherche de tickets Zendesk",
  "servicenow_incident_create": "Création d'incident ServiceNow",
  "servicenow_incident_update": "Mise à jour d'incident ServiceNow",
  "servicenow_incident_query": "Consultation des incidents ServiceNow",
  // Task 140 — suite « outils pilotés par les agents IA » (16 libellés FR).
  "handover.compose": "Brief de relais IA vers humain",
  "terminal.shield": "Terminal protégé avec auto-réparation",
  "registry.find": "Recherche de packages en direct",
  "build.autofix": "Pipeline d'auto-correction de build",
  "simulation.run": "Studio de simulation utilisateur",
  "browser.navigate": "Navigation web adaptative",
  "schema.extract": "Extraction de données structurées",
  "voicemail.respond": "Répondeur vocal asynchrone",
  "transcript.redact": "Masquage de données sensibles",
  "ivr.navigate": "Navigation de serveur vocal (IVR)",
  "webhook.heal": "Passerelle webhooks auto-réparatrice",
  "watchdog.track": "Veille des changements web",
  "terminal.guide": "Guide interactif depuis le terminal",
  "content.package": "Pipeline de contenu automatisé",
  "knowledge.graph": "Graphe de connaissances",
  "decision.analyze": "Moteur de décision probabiliste",
};

/** Libellés des familles d'outils identifiés par préfixe. */
const TOOL_PREFIX_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "composio.", label: "Application connectée" },
  { prefix: "mcp.", label: "Outil externe connecté" },
  { prefix: "web.", label: "Accès web" },
  { prefix: "image.", label: "Génération d'image" },
  { prefix: "video.", label: "Production vidéo" },
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
