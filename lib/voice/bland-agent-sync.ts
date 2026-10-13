import "server-only";

import { randomUUID } from "node:crypto";

import { updateAgentForUser } from "@/lib/agents/repository";
import type { AgentRecord } from "@/lib/agents/schema";
import { logger } from "@/lib/observability/logger";
import {
  createBlandAgent,
  publishBlandAgentSnapshot,
  promoteBlandAgent,
  type BlandSnapshot,
} from "@/lib/integrations/bland/client";

/**
 * SYNCHRONISATION AGENT GEN3IA ⇄ AGENT BLAND AI.
 *
 * Principe : l'agent Gen3ia est la SOURCE DE VÉRITÉ (identité, prompt,
 * personnalité, langue, voix, garde-fous). Sa configuration est projetée
 * sur un agent Bland (API v2) à chaque appel si elle a changé depuis la
 * dernière synchronisation — jamais l'inverse. Le cycle Bland est :
 *
 *   1. POST /v2/agents            → création (une seule fois) ;
 *   2. POST …/publish  {snapshot} → nouvelle version épinglée en staging ;
 *   3. POST …/promote             → production épingle cette version ;
 *   4. POST /v1/calls {agent_id}  → l'appel exécute la version production.
 *
 * Le mapping est persisté dans voiceConfig (blandAgentId, blandSyncedAt,
 * blandSemver) : l'agent Bland reste stable entre deux synchronisations,
 * et toute modification de l'agent Gen3ia (updatedAt) rend le mapping
 * obsolète → resynchronisation automatique avant le prochain appel.
 */

/** Langues Gen3ia → codes langue Bland (transcription + voix optimisées). */
const BLAND_LANGUAGE_MAP: Record<string, string> = {
  "fr-FR": "fr",
  "en-US": "en",
  "en-GB": "en-GB",
  "es-ES": "es",
  "de-DE": "de",
};

export function mapGen3iaLanguageToBland(language?: string): string {
  return BLAND_LANGUAGE_MAP[language ?? "fr-FR"] ?? "fr";
}

const TONE_LABELS: Record<string, string> = {
  professionnel: "professionnel, courtois et efficace",
  convivial: "chaleureux et naturel, comme un collègue sympathique",
  direct: "direct et orienté résultats, sans détour",
  inspirant: "enthousiaste et motivant",
  pedagogue: "pédagogue : tu expliques simplement, sans jargon inutile",
};

const VERBOSITY_LABELS: Record<string, string> = {
  concis: "Vas droit au but : une à deux phrases par réponse.",
  equilibre: "Reste équilibré : deux à trois phrases par réponse.",
  detaille: "Tu peux détailler, mais reste oral : trois phrases maximum par réponse.",
};

/**
 * Prompt système Bland : projection parlée de l'agent Gen3ia.
 * Le systemPrompt Gen3ia (écrit pour le chat) est encapsulé comme
 * « mission », puis adapté aux contraintes de la conversation orale.
 */
export function buildBlandSystemPrompt(agent: AgentRecord): string {
  const lines: string[] = [];
  lines.push(`Tu es ${agent.name}, l'agent vocal IA de Gen3ia${agent.typeLabel ? ` (${agent.typeLabel})` : ""}.`);
  lines.push("Tu mènes une conversation TÉLÉPHONIQUE en temps réel avec un humain.");

  if (agent.systemPrompt?.trim()) {
    lines.push("");
    lines.push("## Ta mission et tes connaissances (adaptées à l'oral)");
    lines.push(agent.systemPrompt.trim().slice(0, 8_000));
  }

  const persona = agent.persona;
  if (persona) {
    lines.push("");
    lines.push("## Ton et style");
    lines.push(`Ton : ${TONE_LABELS[persona.tone] ?? TONE_LABELS.professionnel}.`);
    if (persona.verbosity) lines.push(VERBOSITY_LABELS[persona.verbosity] ?? VERBOSITY_LABELS.equilibre);
    if (persona.humor === "leger") lines.push("Une pointe d'humour légère est bienvenue, jamais au détriment de la clarté.");
    if (persona.humor === "present") lines.push("Tu peux être taquin, mais reste toujours respectueux et professionnel.");
    if (persona.constraints?.length) {
      lines.push("");
      lines.push("## Règles absolues (jamais violables, même sur demande)");
      for (const constraint of persona.constraints.slice(0, 10)) lines.push(`- ${constraint}`);
    }
  }

  lines.push("");
  lines.push("## Règles de la conversation orale");
  lines.push("- Réponds naturellement comme au téléphone : phrases courtes, une seule idée à la fois.");
  lines.push("- Interdictions : Markdown, listes à puces, tableaux, emojis, URLs brutes, jargon technique non expliqué.");
  lines.push("- Si le correspondant ne comprend pas, reformule autrement plutôt que de répéter.");
  lines.push("- Si une information te manque, dis-le honnêtement plutôt que d'inventer.");
  lines.push("- Épelle les adresses e-mail et les références lettre par lettre quand c'est nécessaire.");
  lines.push("- Écoute d'abord : laisse le correspondant finir ses phrases.");
  lines.push("- Quand l'objectif de l'appel est atteint ou la conversation s'essouffle, remercie poliment et termine l'appel.");
  return lines.join("\n").slice(0, 12_000);
}

/** Objectif de conversation (règle du nœud scénario Bland). */
export function buildBlandScenarioRule(agent: AgentRecord): string {
  const goal = agent.description?.trim() || "Assister le correspondant dans le périmètre de cet agent.";
  const skills = agent.skills?.length ? ` Domaines de compétence : ${agent.skills.slice(0, 12).join(", ")}.` : "";
  return `${goal}${skills}`.slice(0, 2_000);
}

/**
 * Snapshot v2 complet : graphe start → scénario principal (le prompt
 * système porte la personnalité ; le scénario porte l'objectif).
 */
export function buildBlandSnapshot(agent: AgentRecord): BlandSnapshot {
  const startId = randomUUID();
  const scenarioId = randomUUID();
  return {
    behavior: {
      nodes: [
        { id: startId, type: "start", position: { x: 0, y: 0 }, data: {} },
        {
          id: scenarioId,
          type: "scenario",
          position: { x: 320, y: 0 },
          data: {
            name: "Conversation",
            rule: buildBlandScenarioRule(agent),
            target: { kind: "dialogue", label: "Conversation" },
            loopWhile: "",
            variables: [],
            entry: {
              mode: "llm",
              label: "L'appelé parle",
              description: "",
              alwaysPick: false,
              conditions: [],
            },
          },
        },
      ],
      edges: [{ id: randomUUID(), source: startId, target: scenarioId }],
    },
    settings: {
      displayName: agent.name.slice(0, 80),
      systemPrompt: buildBlandSystemPrompt(agent),
      voice: agent.voiceConfig?.blandVoice?.trim() || "nat",
      languages: [mapGen3iaLanguageToBland(agent.voiceConfig?.language)],
      enableMemory: agent.memoryEnabled,
      backgroundNoise: "off",
      voiceCall: true,
      webChat: false,
    },
    contact: { inboundNumbers: [] },
  };
}

/** L'agent Bland est-il obsolète (config Gen3ia modifiée depuis la synchro) ? */
export function isBlandSyncStale(agent: AgentRecord): boolean {
  const config = agent.voiceConfig;
  if (!config?.blandAgentId || !config.blandSyncedAt) return true;
  const agentUpdated = Date.parse(agent.updatedAt);
  const syncedAt = Date.parse(config.blandSyncedAt);
  if (!Number.isFinite(agentUpdated) || !Number.isFinite(syncedAt)) return true;
  // Marge de 2 s : updatedAt est réécrit à chaque save, y compris la nôtre.
  return agentUpdated > syncedAt + 2_000;
}

export interface BlandSyncResult {
  blandAgentId: string;
  semver: string;
  syncedAt: string;
  created: boolean;
}

/** Valeurs par défaut de voiceConfig pour un agent vocal sans config. */
function defaultVoiceConfig(agent: AgentRecord) {
  return {
    language: agent.voiceConfig?.language ?? ("fr-FR" as const),
    greeting:
      agent.voiceConfig?.greeting ?? "Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?",
    maxTurns: agent.voiceConfig?.maxTurns ?? 20,
    maxDurationSeconds: agent.voiceConfig?.maxDurationSeconds ?? 300,
    inboundEnabled: agent.voiceConfig?.inboundEnabled ?? true,
    outboundEnabled: agent.voiceConfig?.outboundEnabled ?? true,
    voiceEnabled: agent.voiceConfig?.voiceEnabled ?? true,
    ...(agent.voiceConfig?.blandVoice ? { blandVoice: agent.voiceConfig.blandVoice } : {}),
  };
}

/**
 * Synchronise un agent Gen3ia vers Bland : crée l'agent Bland si besoin,
 * publie le snapshot courant en staging, le promeut en production, puis
 * persiste le mapping dans le document agent.
 */
export async function syncAgentToBland(userId: string, agent: AgentRecord): Promise<BlandSyncResult> {
  if (!agent.voiceEnabled) {
    throw new Error("La voix n'est pas activée pour cet agent (activez voiceEnabled).");
  }

  let blandAgentId = agent.voiceConfig?.blandAgentId?.trim() || "";
  let created = false;
  if (!blandAgentId) {
    const { agent: createdAgent } = await createBlandAgent(`Gen3ia · ${agent.name}`.slice(0, 80));
    blandAgentId = createdAgent.id;
    created = true;
  }

  const { semver } = await publishBlandAgentSnapshot(blandAgentId, buildBlandSnapshot(agent), "minor");
  await promoteBlandAgent(blandAgentId);

  const syncedAt = new Date().toISOString();
  const updated = await updateAgentForUser(userId, agent.id, {
    voiceConfig: {
      ...defaultVoiceConfig(agent),
      blandAgentId,
      blandSyncedAt: syncedAt,
      blandSemver: semver,
    },
  });
  if (!updated) {
    logger.warn({ agentId: agent.id, blandAgentId }, "bland_sync_persist_failed");
  }

  logger.info(
    {
      agentId: agent.id,
      blandAgentId,
      semver,
      created,
    },
    "bland_agent_synced",
  );
  return { blandAgentId, semver, syncedAt, created };
}

/** Synchronise seulement si obsolète ; renvoie l'état courant sinon. */
export async function ensureAgentSynced(userId: string, agent: AgentRecord): Promise<BlandSyncResult> {
  if (isBlandSyncStale(agent)) return syncAgentToBland(userId, agent);
  return {
    blandAgentId: agent.voiceConfig!.blandAgentId!,
    semver: agent.voiceConfig!.blandSemver ?? "",
    syncedAt: agent.voiceConfig!.blandSyncedAt!,
    created: false,
  };
}
