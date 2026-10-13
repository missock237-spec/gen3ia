import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { generateStructuredForUser } from "./llm-json";
import { persistMarkdownDeliverable } from "./artifact-deliverable";

/**
 * OUTIL AGENT « handover.compose » — OmniContext Live Handover (Task 140).
 *
 * Quand un HUMAIN reprend la main depuis un agent IA, il ne doit JAMAIS
 * repartir de zéro : cet outil génère un BRIEF DE RELAIS D'URGENCE structuré
 * à partir de la transcription de la conversation — intention du client,
 * état émotionnel, blocages techniques, données collectées, questions
 * ouvertes, actions suivantes recommandées et risques pour la reprise.
 *
 * Chaîne d'exécution (100 % production, aucune simulation) :
 *  1. appel LLM FACTURÉ au nom de l'utilisateur via generateStructuredForUser
 *     (wallet, relance corrective en cas d'écart de schéma — voir
 *     ./llm-json.ts) — jamais d'appel direct à un fournisseur ;
 *  2. rendu markdown français déterministe (sections imposées) ;
 *  3. PERSISTANCE du livrable réel via persistMarkdownDeliverable
 *     (generateArtifact → storeArtifactBuffer, stockage privé de
 *     l'utilisateur) — le brief n'est jamais un retour volatil.
 */

type HandoverChannel = "chat" | "phone" | "email";
type HandoverUrgency = "low" | "normal" | "high" | "critical";

const CHANNEL_LABELS: Record<HandoverChannel, string> = {
  chat: "chat",
  phone: "téléphone",
  email: "e-mail",
};

const URGENCY_LABELS: Record<HandoverUrgency, string> = {
  low: "faible",
  normal: "normale",
  high: "haute",
  critical: "critique",
};

const HandoverComposeInput = z.object({
  transcript: z.string().min(30).max(60_000),
  channel: z.enum(["chat", "phone", "email"]).default("chat"),
  urgency: z.enum(["low", "normal", "high", "critical"]).default("normal"),
});

/** Schéma STRICT du brief de relais produit par le LLM (contenu en français). */
export const HandoverBriefSchema = z.object({
  summaryOneLiner: z.string(),
  customerIntent: z.string(),
  emotionalState: z.object({
    mood: z.string(),
    intensity: z.number().int().min(1).max(5),
    signals: z.array(z.string()).max(8),
  }),
  technicalBlockers: z.array(z.string()).max(10),
  collectedData: z.array(z.object({ label: z.string(), value: z.string() })).max(30),
  openQuestions: z.array(z.string()).max(10),
  suggestedNextActions: z.array(z.string()).max(8),
  risksForHandover: z.array(z.string()).max(6),
});

export type HandoverBrief = z.infer<typeof HandoverBriefSchema>;

const HANDOVER_SYSTEM_PROMPT = [
  "Tu es le moteur « OmniContext Live Handover » de Gen3ia. Un agent IA vient de gérer un client et un HUMAIN reprend la conversation : tu produis le BRIEF DE RELAIS D'URGENCE qui permet à ce humain de reprendre le fil sans perte de contexte.",
  "",
  "Règles impératives :",
  "- Réponds UNIQUEMENT avec un objet JSON valide, sans texte d'introduction ni de conclusion, sans fences markdown.",
  "- Tout le contenu (mood, signaux, blocages, questions, actions, risques) est rédigé en FRANÇAIS.",
  "- Sois FACTUEL : n'invente rien qui ne figure pas dans la transcription. Si une information est absente, utilise une chaîne vide ou une liste vide plutôt qu'une supposition.",
  "- emotionalState.intensity est un entier de 1 (parfaitement calme) à 5 (état critique).",
  "- suggestedNextActions : actions concrètes et immédiatement exploitables par le humain qui reprend.",
  "- risksForHandover : ce qui pourrait mal tourner lors de la reprise (engagement pris par l'IA, promesse, délai, malentendu…).",
  "",
  "Schéma JSON strict attendu :",
  '{"summaryOneLiner": string, "customerIntent": string, "emotionalState": {"mood": string, "intensity": number (1-5), "signals": string[] (max 8)}, "technicalBlockers": string[] (max 10), "collectedData": [{"label": string, "value": string}] (max 30), "openQuestions": string[] (max 10), "suggestedNextActions": string[] (max 8), "risksForHandover": string[] (max 6)}',
].join("\n");

/** Échappe une cellule de tableau markdown (| et sauts de ligne). */
function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Rendu markdown français déterministe du brief de relais. */
export function renderHandoverMarkdown(
  brief: HandoverBrief,
  channel: HandoverChannel,
  urgency: HandoverUrgency,
): string {
  const lines: string[] = [];
  const bulletSection = (items: string[], emptyLabel: string) => {
    if (items.length === 0) return [emptyLabel];
    return items.map((item) => `- ${item}`);
  };

  lines.push("# Brief de relais IA → humain");
  lines.push("");
  lines.push(`Canal : ${CHANNEL_LABELS[channel]} · Urgence : ${URGENCY_LABELS[urgency]}`);
  lines.push("");
  lines.push("## Résumé en une phrase");
  lines.push("");
  lines.push(brief.summaryOneLiner.trim() || "—");
  lines.push("");
  lines.push("## Intention du client");
  lines.push("");
  lines.push(brief.customerIntent.trim() || "—");
  lines.push("");
  lines.push("## État émotionnel");
  lines.push("");
  lines.push(
    `Humeur : ${brief.emotionalState.mood.trim() || "non précisée"} — Intensité : ${brief.emotionalState.intensity}/5`,
  );
  lines.push("");
  lines.push("Signaux :");
  lines.push(...bulletSection(brief.emotionalState.signals, "- aucun signal explicite détecté"));
  lines.push("");
  lines.push("## Blocages techniques");
  lines.push("");
  lines.push(...bulletSection(brief.technicalBlockers, "Aucun blocage technique identifié."));
  lines.push("");
  lines.push("## Données collectées");
  lines.push("");
  if (brief.collectedData.length === 0) {
    lines.push("Aucune donnée structurée collectée.");
  } else {
    lines.push("| Donnée | Valeur |");
    lines.push("| --- | --- |");
    for (const entry of brief.collectedData) {
      lines.push(`| ${tableCell(entry.label)} | ${tableCell(entry.value)} |`);
    }
  }
  lines.push("");
  lines.push("## Questions ouvertes");
  lines.push("");
  lines.push(...bulletSection(brief.openQuestions, "Aucune question ouverte."));
  lines.push("");
  lines.push("## Actions suivantes recommandées");
  lines.push("");
  lines.push(...bulletSection(brief.suggestedNextActions, "Aucune action recommandée."));
  lines.push("");
  lines.push("## Risques pour la reprise");
  lines.push("");
  lines.push(...bulletSection(brief.risksForHandover, "Aucun risque particulier identifié."));
  lines.push("");
  return lines.join("\n");
}

export interface HandoverComposeResult {
  brief: HandoverBrief;
  artifactId: string;
  filename: string;
  storageKey: string;
}

export const handoverComposeTool: ToolDefinition<
  z.infer<typeof HandoverComposeInput>,
  HandoverComposeResult
> = {
  id: "handover.compose",
  name: "OmniContext Live Handover",
  description:
    "Compose an emergency handover brief when a human takes over from an AI agent: customer intent, emotional state, technical blockers, collected data, open questions, recommended next actions and takeover risks — persisted as a real markdown deliverable in the user's private storage.",
  category: "system",
  risk: "medium",
  inputSchema: HandoverComposeInput,
  async execute(input, context) {
    const parsed = HandoverComposeInput.parse(input);

    const brief = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "agent",
      maxTokens: 2_500,
      system: HANDOVER_SYSTEM_PROMPT,
      user: [
        `Canal : ${CHANNEL_LABELS[parsed.channel]} · Urgence : ${URGENCY_LABELS[parsed.urgency]}`,
        "",
        "Transcription de la conversation à transmettre :",
        "",
        parsed.transcript,
      ].join("\n"),
      schema: HandoverBriefSchema,
    });

    const markdown = renderHandoverMarkdown(brief, parsed.channel, parsed.urgency);

    const deliverable = await persistMarkdownDeliverable({
      userId: context.userId,
      executionId: context.executionId,
      title: "Brief de relais",
      markdown,
    });

    return {
      brief,
      artifactId: deliverable.artifactId,
      filename: deliverable.filename,
      storageKey: deliverable.storageKey,
    };
  },
};
