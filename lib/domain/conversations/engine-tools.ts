import "server-only";

/**
 * Catalogue d'outils conversationnel + politique d'exécution + métadonnées de validation (risque, coût estimé, périmètre de données, condensation). Extrait de engine.ts — code déplacé tel quel.
 */

import { isEmailProviderConfigured } from "@/lib/integrations/email/send";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import { createDefaultToolRegistry } from "@/lib/tools/default-registry";
import type { ToolRisk } from "@/lib/tools/types";

/* ------------------------------------------------------------------ */
/* Catalogue d'outils disponible dans les conversations                */
/* ------------------------------------------------------------------ */

/** Outils exclus du catalogue conversationnel (surfaces spécialisées). */
const EXCLUDED_TOOLS = new Set(["camera.capture", "code.execute", "ui.components"]);

const registry = createDefaultToolRegistry();

export interface ToolCatalogEntry {
  name: string;
  description: string;
  risk: ToolRisk;
  requiresApproval: boolean;
}

export function conversationToolCatalog(): ToolCatalogEntry[] {
  return registry
    .list()
    .filter((tool) => !EXCLUDED_TOOLS.has(tool.id ?? tool.name))
    // email.send n'est proposé QUE si le fournisseur d'emails est configuré
    // (vérifié dynamiquement : l'environnement peut changer entre le chargement
    // du module et l'exécution d'un tour).
    .filter((tool) => (tool.id ?? tool.name) !== "email.send" || isEmailProviderConfigured())
    .map((tool) => ({
      name: tool.id ?? tool.name,
      description: tool.description,
      risk: tool.risk,
      requiresApproval: stepRequiresApproval(tool.risk),
    }));
}

/* ------------------------------------------------------------------ */
/* Politique d'exécution des étapes de conversation                    */
/* ------------------------------------------------------------------ */

/**
 * Politique dédiée aux conversations : réseaux et applications externes
 * autorisés (l'utilisateur les déclenche explicitement), mais ni code
 * arbitraire, ni terminal, ni caméra dans ce contexte.
 */
export const CONVERSATION_EXECUTION_POLICY: ExecutionPolicy = {
  // "*" : le filtrage réel est fait en amont (catalogue conversationnel sans
  // code.execute/camera.capture, plan validé par l'IA d'intention, et
  // validations humaines pour les risques high/critical). Les permissions
  // ci-dessous restent la barrière fine de chaque outil.
  allowedTools: ["*"],
  permissions: [
    "tool.read", "tool.write", "tool.external",
    "file.read", "file.write", "file.create",
    "network.read", "network.write",
    "memory.read", "memory.write",
    "ads.read",
  ],
  maxSteps: 10,
  maxExecutionMs: 4 * 60 * 1000,
  maxToolExecutionMs: 90 * 1000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxInputBytes: 256 * 1024,
  allowNetwork: true,
  allowExternalApps: true,
  allowFileWrite: true,
  allowFileDelete: false,
  allowCodeExecution: false,
  allowAgentTerminal: false,
  allowCamera: false,
};

/** Risques exigeant une validation humaine avant exécution. */
const APPROVAL_RISKS: ReadonlySet<ToolRisk> = new Set(["high", "critical"]);

export function stepRequiresApproval(risk: string): boolean {
  return APPROVAL_RISKS.has(risk as ToolRisk);
}

/** Coût estimé affiché sur la carte de validation. */
export function estimatedCostForTool(toolName: string): string {
  if (toolName.startsWith("web.") || toolName.startsWith("knowledge.")) return "gratuit";
  if (toolName.startsWith("composio.") || toolName.startsWith("mcp.")) return "inclus (application connectée)";
  if (toolName.startsWith("custom_api.")) return "gratuit (votre API — quota du fournisseur)";
  if (toolName === "workflow.run" || (toolName === "workflow.create")) return "gratuit à la création ; exécution facturée selon les modèles";
  if (toolName.startsWith("schedule.") || toolName.startsWith("workflow.")) return "gratuit";
  if (toolName === "image.generate") return "gratuit (moteur neuronal local)";
  if (toolName === "video.create") return "production locale (visuels neuraux, rendu interne)";
  if (toolName === "video.revise") return "gratuit";
  // Task 140 — suite « outils pilotés par les agents IA ».
  if (toolName === "build.autofix") return "appels LLM facturés à l'usage (analyse du log + correctif)";
  if (toolName === "voicemail.respond") return "appels LLM facturés à l'usage + envoi email/SMS selon canal";
  if (toolName === "webhook.heal") return "appels LLM facturés à l'usage (adaptation du payload)";
  if (toolName === "handover.compose" || toolName === "terminal.guide" || toolName === "content.package" || toolName === "knowledge.graph" || toolName === "simulation.run" || toolName === "schema.extract" || toolName === "ivr.navigate" || toolName === "watchdog.track") return "appels LLM facturés à l'usage";
  return "gratuit";
}

/** Périmètre de données lisible affiché sur la carte de validation. */
export function dataScopeForTool(toolName: string, input: unknown): string {
  const target =
    input && typeof input === "object" && "toolkit" in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).toolkit)
      : undefined;
  const apiName =
    input && typeof input === "object" && "apiName" in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).apiName)
      : undefined;
  if (toolName === "custom_api.call") return `Appel en lecture vers votre API${apiName ? ` « ${apiName} »` : " personnelle"}`;
  if (toolName === "custom_api.write") return `Modification de données dans votre API${apiName ? ` « ${apiName} »` : " personnelle"}`;
  if (toolName === "web.api") {
    const url = input && typeof input === "object" && "url" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).url) : undefined;
    return `Appel en lecture vers l'API${url ? ` ${url}` : " désignée par URL"}`;
  }
  if (toolName === "web.api.write") {
    const url = input && typeof input === "object" && "url" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).url) : undefined;
    return `Modification de données via l'API${url ? ` ${url}` : " désignée par URL"}`;
  }
  if (toolName === "schedule.create" || toolName === "schedule.update") return "Vos tâches planifiées (automatisations d'agents)";
  if (toolName === "schedule.delete") return "Suppression définitive d'une automatisation récurrente";
  if (toolName === "workflow.create") return "Vos workflows (automatisations multi-étapes)";
  if (toolName === "workflow.run") return "Exécution complète du workflow (modèles facturés)";
  if (toolName === "workflow.delete") return "Suppression définitive d'un workflow";
  if (toolName === "composio.execute") return `Application connectée${target ? ` « ${target} »` : ""} — action externe`;
  if (toolName === "mcp.call") return "Serveurs MCP connectés (Drive, GitHub, bases de données…)";
  if (toolName === "email.send") return "Destinataire du message + signature plateforme";
  if (toolName === "messaging.send") return "Canal de messagerie connecté (WhatsApp, Telegram, Slack)";
  if (toolName === "social.publish") return "Compte social connecté — publication publique";
  if (toolName === "webhook.emit") return "Endpoints webhook déclarés par votre compte";
  if (toolName === "github.create_repository") return "Votre compte GitHub — nouveau dépôt";
  if (toolName === "file.create" || toolName === "artifact.create") return "Votre stockage permanent Gen3ia";
  if (toolName === "memory.write") return "Mémoire permanente de vos agents";
  if (toolName === "image.generate") return "Génération d'une image à partir de votre description (stockée dans votre espace)";
  if (toolName === "video.create") return "Production vidéo complète : scénario, visuels, voix, montage et rendu (votre espace vidéo)";
  if (toolName === "video.status") return "Suivi de votre production vidéo (étape, progression, URL du master)";
  if (toolName === "video.revise") return "Révision/pilotage de votre vidéo (musique, rythme, voix, pause, exports)";
  if (toolName.startsWith("cloudflare.")) return "Zones DNS Cloudflare autorisées";
  if (toolName.startsWith("notion.")) return "Espace Notion autorisé";
  // Task 140 — suite « outils pilotés par les agents IA ».
  if (toolName === "build.autofix") return "Log de build fourni + contenu du dépôt GitHub ciblé (lecture, puis pull request corrective)";
  if (toolName === "voicemail.respond") {
    const target = input && typeof input === "object" && "destinationEmail" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).destinationEmail) : undefined;
    return `Transcription du message vocal + destinataire${target ? ` (${target})` : " de la réponse"}`;
  }
  if (toolName === "webhook.heal") {
    const url = input && typeof input === "object" && "endpointUrl" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).endpointUrl) : undefined;
    return `Re-soumission du payload vers votre endpoint${url ? ` ${url}` : ""}`;
  }
  if (toolName === "handover.compose") return "Transcription de la conversation (brief de relais stocké dans votre espace)";
  if (toolName === "terminal.shield") return "Commande exécutée dans le terminal agent isolé (workspace /tmp éphémère)";
  if (toolName === "simulation.run") {
    const url = input && typeof input === "object" && "targetUrl" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).targetUrl) : undefined;
    return `Simulation multi-personas de la cible décrite${url ? ` (${url} lu en direct)` : ""} — rapport stocké dans votre espace`;
  }
  if (toolName === "watchdog.track") {
    const url = input && typeof input === "object" && "url" in (input as Record<string, unknown>) ? String((input as Record<string, unknown>).url) : undefined;
    return `Page surveillée${url ? ` (${url})` : ""} — référence et historique stockés dans votre compte`;
  }
  if (toolName === "transcript.redact") return "Transcription transformée en mémoire (aucune donnée stockée)";
  return "Données transmises dans la demande";
}

/* ------------------------------------------------------------------ */
/* Condensation des sorties d'outils                                   */
/* ------------------------------------------------------------------ */

/** Sortie condensée, lisible, stockée dans la timeline (≈ 1 200 car.). */
export function condenseToolOutput(output: unknown): string {
  let text: string;
  if (output === undefined || output === null) text = "";
  else if (typeof output === "string") text = output;
  else {
    try {
      text = JSON.stringify(output, null, 2);
    } catch {
      text = String(output);
    }
  }
  text = text.replace(/\s+\n/g, "\n").trim();
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1170)}\n… (sortie tronquée, ${text.length - 1170} caractères restants)`;
}
