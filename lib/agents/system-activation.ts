import { logger } from "@/lib/observability/logger";
import type { AgentRecordInput, AgentRecord } from "./schema";
import { createAgentRecord, listAgentsForUser } from "./repository";
import { recordAuditEventSafe } from "@/lib/security/audit-events";
import { AGENT_SYSTEM_RESERVED_MESSAGE } from "@/lib/security/agent-system-access";

/**
 * ACTIVATION INTERNE DU SYSTÈME AGENT (demande utilisateur n°5).
 *
 * Flux cible : utilisateur demande dans le chat → l'IA décide → le moteur
 * appelle ce service (in-process) ou POST /api/agents/system/activate
 * (secret serveur AGENTS_SYSTEM_SECRET) → sous-agents RÉELS créés chez le
 * demandeur → ils assistent l'agent navigateur.
 *
 * « Agent navigateur » réel du code : l'outil `browser.navigate`
 * (Browser Anti-Bot Adaptive Navigator, lib/tools/agent-suite/browser-navigate.ts)
 * — navigation web adaptative anti-robots enregistrée au registre exécutable.
 * Les sous-agents créés ici déclarent donc exactement les outils réels
 * browser.navigate / web.search / web.open / memory.* / artifact.create :
 * AUCUN outil fantôme (même contrat que resolveAndHarden côté routes).
 *
 * HONNÊTÉ TECHNIQUE :
 *  - CE QUI EST BRANCHÉ : création persistante réelle (createAgentRecord →
 *    stockage R2 users/{uid}/agents/…), idempotence par marqueur, plafond,
 *    audit best-effort, endpoint interne authentifié par secret serveur.
 *  - CE QUI RESTE UNE INTERFACE : l'appel DEPUIS le moteur de conversation
 *    (lib/domain/conversations/engine.ts — hors périmètre de cette tâche)
 *    n'est pas encore câblé ; le service + l'endpoint interne sont prêts à
 *    recevoir cet appel in-process ou HTTP. Les sous-agents créés sont des
 *    agents Gen3ia standard exécutables par le runtime existant — il n'existe
 *    pas de « processus navigateur » dédié à instancier.
 */

/** Marqueur de compétence identifiant les sous-agents créés par le système. */
export const SYSTEM_AGENT_SKILL_MARKER = "assistance-agent-navigateur";

/** Plafond de sous-agents navigateur créés par le système par utilisateur. */
export const MAX_BROWSER_ASSIST_SUBAGENTS = 2;

/** Outils RÉELS du registre déclarés aux sous-agents navigateur. */
export const BROWSER_ASSIST_TOOLS = [
  "browser.navigate",
  "web.search",
  "web.open",
  "memory.read",
  "memory.write",
  "artifact.create",
] as const;

const CHARTER_NAVIGATEUR = `Tu es un sous-agent Gen3ia créé par le système IA pour ASSISTER l'agent navigateur de l'utilisateur. Périmètre : navigation web adaptative (browser.navigate), recherche et lecture de pages publiques (web.search, web.open), synthèse factuelle et livrables (artifact.create), mémoire de travail non secrète (memory.read/write). Règles : ne jamais inventer un contenu de page (les pages challenge/anti-bot sont signalées honnêtement), ne jamais accéder à des URLs privées/intranet, soumettre toute action sensible à validation humaine (mode always_ask), ne jamais exposer de secret. Tu rapportes tes résultats au système IA qui les relaie à l'utilisateur.`;

const CHARTER_VEILLEUR = `Tu es un sous-agent Gen3ia créé par le système IA pour SURVEILLER et ASSISTER les missions de navigation web (agent navigateur) de l'utilisateur : suivi des sources surveillées, détection de changements utiles, alertes de progression de mission, préparation de recherches de fond (web.search, browser.navigate). Règles honnêteté : signale les pages inaccessibles ou challenge anti-bot au lieu de deviner ; jamais d'URL privée ; actions sensibles soumises à validation humaine ; jamais de secret en clair.`;

/** Définitions déterministes des sous-agents navigateur (réellement créés). */
export function buildBrowserAssistSubAgents(demande?: string): AgentRecordInput[] {
  const motif = demande?.trim() ? ` Demande d'origine : « ${demande.trim().slice(0, 300)} ».` : "";
  return [
    {
      name: "Assistant Navigateur — Recherche Web",
      description: `Sous-agent système : navigation web adaptative et recherche factuelle au service de l'agent navigateur.${motif}`,
      type: "research",
      typeLabel: "Assistance navigateur",
      skills: ["Navigation web adaptative", "Recherche web", "Synthèse de sources", SYSTEM_AGENT_SKILL_MARKER],
      agentMode: "standard",
      tools: [...BROWSER_ASSIST_TOOLS],
      systemPrompt: CHARTER_NAVIGATEUR,
      status: "active",
      autonomous: true,
      maxIterations: 6,
      temperature: 0.3,
      authorizationMode: "always_ask",
      memoryEnabled: true,
      webResearchEnabled: true,
      documentGenerationEnabled: true,
      voiceEnabled: false,
    },
    {
      name: "Assistant Navigateur — Veille Missions",
      description: `Sous-agent système : surveillance des sources web et suivi des missions de navigation au service de l'agent navigateur.${motif}`,
      type: "automation",
      typeLabel: "Assistance navigateur",
      skills: ["Suivi de missions", "Surveillance de sources web", "Alertes de progression", SYSTEM_AGENT_SKILL_MARKER],
      agentMode: "standard",
      tools: [...BROWSER_ASSIST_TOOLS],
      systemPrompt: CHARTER_VEILLEUR,
      status: "active",
      autonomous: true,
      maxIterations: 6,
      temperature: 0.3,
      authorizationMode: "always_ask",
      memoryEnabled: true,
      webResearchEnabled: true,
      documentGenerationEnabled: true,
      voiceEnabled: false,
    },
  ];
}

export interface AgentSystemActivationRequest {
  /** Propriétaire des sous-agents : l'utilisateur qui a demandé dans le chat. */
  userId: string;
  /** Motif énoncé par l'utilisateur (contexte transmis par l'IA). Optionnel. */
  demande?: string;
  /** Origine de l'activation (traçabilité). */
  source?: "chat" | "api-interne";
}

export interface AgentSystemActivationResult {
  /** true = au moins un sous-agent créé ; false = déjà actifs (idempotent). */
  activated: boolean;
  /** Raison honnête quand activated=false. */
  reason?: "already_active" | "invalid_user";
  /** Sous-agents système (créés ou préexistants), résumés. */
  subAgents: Array<Pick<AgentRecord, "id" | "name" | "type" | "typeLabel" | "status" | "tools">>;
}

/** Sous-agents navigateur déjà présents chez l'utilisateur (par marqueur). */
async function existingSystemAgents(userId: string): Promise<AgentRecord[]> {
  const agents = await listAgentsForUser(userId);
  return agents.filter((agent) => agent.skills.includes(SYSTEM_AGENT_SKILL_MARKER));
}

/**
 * Active le système agent POUR un utilisateur (décision de l'IA, demande
 * exprimée dans le chat) : crée les sous-agents navigateur manquants
 * (persistance réelle) ou retourne ceux déjà actifs (idempotent — jamais de
 * doublon). Le plafond MAX_BROWSER_ASSIST_SUBAGENTS borne la croissance.
 * Journal + audit best-effort : jamais bloquants.
 */
export async function activateAgentSystemForUser(request: AgentSystemActivationRequest): Promise<AgentSystemActivationResult> {
  const userId = request.userId?.trim() ?? "";
  if (!userId) {
    return { activated: false, reason: "invalid_user", subAgents: [] };
  }

  const existants = await existingSystemAgents(userId);
  if (existants.length >= MAX_BROWSER_ASSIST_SUBAGENTS) {
    logger.info({ event: "agent_system.activation.already_active", userId, count: existants.length }, "Activation agent-système : sous-agents déjà actifs (idempotent)");
    return { activated: false, reason: "already_active", subAgents: existants.map(toSystemSummary) };
  }

  const definitions = buildBrowserAssistSubAgents(request.demande);
  const nomsExistants = new Set(existants.map((agent) => agent.name));
  const manquants = definitions.filter((definition) => !nomsExistants.has(definition.name));

  const created: AgentRecord[] = [];
  for (const definition of manquants) {
    const record = await createAgentRecord(userId, definition);
    created.push(record);
  }

  logger.info(
    { event: "agent_system.activation.created", userId, source: request.source ?? "api-interne", created: created.map((agent) => agent.id) },
    "Activation agent-système : sous-agents navigateur créés",
  );
  // Audit best-effort (jamais bloquant) : qui/quoi/résultat sans secret.
  recordAuditEventSafe({
    actorId: "system-ia",
    action: "agent_system.activation",
    outcome: created.length > 0 ? "granted" : "denied",
    targetType: "user",
    targetId: userId,
    metadata: { source: request.source ?? "api-interne", created: created.length, alreadyActive: existants.length },
  });

  const finaux = created.length > 0 ? created : existants;
  return { activated: created.length > 0, ...(created.length === 0 ? { reason: "already_active" as const } : {}), subAgents: finaux.map(toSystemSummary) };
}

/** Résumé minimal d'un sous-agent système (aucun prompt ni secret en sortie). */
function toSystemSummary(record: AgentRecord): AgentSystemActivationResult["subAgents"][number] {
  return { id: record.id, name: record.name, type: record.type, typeLabel: record.typeLabel, status: record.status, tools: record.tools };
}

/** Réexport pratique : le message 403 « réservé au système IA » (cohérence). */
export { AGENT_SYSTEM_RESERVED_MESSAGE };
