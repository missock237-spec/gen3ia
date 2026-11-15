import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { persistMarkdownDeliverable } from "./artifact-deliverable";
import { generateStructuredForUser } from "./llm-json";

/**
 * OUTIL AGENT « terminal.guide » — Interactive Terminal Simulation Recorder (Task 140).
 *
 * Transforme une SESSION TERMINALE brute (commandes + sorties collées, n'importe
 * quel format) en GUIDE INTERACTIF PAS-À-PAS : chaque étape porte sa commande,
 * son explication pédagogique (le POURQUOI, pas seulement le quoi), sa sortie
 * attendue et ses avertissements. Le niveau d'explication s'adapte au public
 * visé (débutant : jargon défini — expert : concis).
 *
 * Chaîne d'exécution (100 % production, aucune simulation) :
 *  1. appel LLM FACTURÉ au nom de l'utilisateur via generateStructuredForUser
 *     (wallet, relance corrective en cas d'écart de schéma — voir
 *     ./llm-json.ts), tâche « document » ;
 *  2. rendu markdown français déterministe (sections imposées, commandes en
 *     blocs de code encadrés) ;
 *  3. PERSISTANCE du livrable réel via persistMarkdownDeliverable
 *     (generateArtifact → storeArtifactBuffer, stockage privé de
 *     l'utilisateur) — le guide n'est jamais un retour volatil.
 */

type TerminalAudience = "beginner" | "intermediate" | "expert";

const TerminalGuideInput = z.object({
  sessionTranscript: z.string().min(30).max(100_000),
  title: z.string().max(200).optional(),
  audience: z.enum(["beginner", "intermediate", "expert"]).default("beginner"),
});

/** Schéma STRICT du guide produit par le LLM (contenu pédagogique en français). */
export const TerminalGuideSchema = z.object({
  title: z.string().max(200),
  prerequisites: z.array(z.string().max(300)).max(10),
  steps: z
    .array(
      z.object({
        order: z.number().int().min(1).max(50),
        command: z.string().max(2_000),
        explanation: z.string().max(1_500),
        expectedOutput: z.string().max(800).optional(),
        warnings: z.array(z.string().max(300)).max(3).optional(),
      }),
    )
    .min(1)
    .max(50),
  nextSteps: z.array(z.string().max(300)).max(8),
});

export type TerminalGuide = z.infer<typeof TerminalGuideSchema>;
export type TerminalGuideStep = TerminalGuide["steps"][number];

const AUDIENCE_RULES: Record<TerminalAudience, string> = {
  beginner:
    "- Public DÉBUTANT : définis chaque terme technique et chaque jargon à sa première apparition, procède pas à pas, ne présuppose aucune connaissance.",
  intermediate:
    "- Public INTERMÉDIAIRE : apporte le contexte et les subtilités utiles sans redéfinir les notions de base.",
  expert:
    "- Public EXPERT : sois concis et dense, va droit au but, mets en avant les points non triviaux, les raccourcis et les pièges avancés.",
};

function buildSystemPrompt(audience: TerminalAudience): string {
  return [
    "Tu es le moteur « Interactive Terminal Simulation Recorder » de Gen3ia : ingénieur logiciel senior ET formateur pédagogue réputé pour ses guides techniques d'une clarté exemplaire.",
    "",
    "Ta mission : transformer une session de terminal brute (commandes + sorties, format libre, éventuellement sale) en un GUIDE INTERACTIF PAS-À-PAS immédiatement utilisable.",
    "",
    "Règles impératives :",
    "- Reconstitue le déroulé pédagogique complet de la session, dans l'ordre chronologique logique.",
    "- Pour CHAQUE commande, explique le POURQUOI : intention, mécanisme, options utilisées — pas seulement le quoi.",
    "- Renseigne « expectedOutput » quand la sortie est prévisible (extrait fidèle de la session quand il existe).",
    "- Signale dans « warnings » les dangers réels : données perdues, effets irréversibles, commandes destructrices, coûts.",
    "- Liste les prérequis (outils, accès, versions) et propose des suites pertinentes dans « nextSteps ».",
    AUDIENCE_RULES[audience],
    "- Tout le contenu (titre, prérequis, explications, avertissements, suites) est rédigé en FRANÇAIS.",
    "- Réponds UNIQUEMENT avec un objet JSON valide conforme au schéma fourni, sans texte autour.",
    "",
    "Schéma JSON strict attendu :",
    '{"title": string, "prerequisites": string[] (max 10), "steps": [{"order": number, "command": string, "explanation": string, "expectedOutput": string (optionnel), "warnings": string[] (max 3, optionnel)}] (1 à 50), "nextSteps": string[] (max 8)}',
  ].join("\n");
}

function buildUserPrompt(input: { sessionTranscript: string; title?: string }): string {
  const lines = ["Session de terminal à transformer en guide interactif :", ""];
  if (input.title && input.title.trim().length > 0) {
    lines.push(`Titre souhaité par l'utilisateur : ${input.title.trim()}`, "");
  }
  lines.push("```text", input.sessionTranscript, "```");
  return lines.join("\n");
}

/** Courte action dérivée de la commande (en-tête d'étape, ≤ 60 caractères). */
function shortAction(command: string): string {
  const firstLine = command.trim().split("\n")[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/** Rendu markdown français déterministe du guide pas-à-pas. */
export function renderTerminalGuideMarkdown(guide: TerminalGuide, title: string): string {
  const lines: string[] = [];
  const bulletSection = (items: string[], emptyLabel: string) =>
    items.length === 0 ? [emptyLabel] : items.map((item) => `- ${item}`);

  lines.push(`# ${title}`);
  lines.push("");
  lines.push("## Prérequis");
  lines.push("");
  lines.push(...bulletSection(guide.prerequisites, "- Aucun prérequis particulier."));
  lines.push("");

  const steps = [...guide.steps].sort((a, b) => a.order - b.order);
  for (const step of steps) {
    lines.push(`## Étape ${step.order} — ${shortAction(step.command)}`);
    lines.push("");
    lines.push("```");
    lines.push(step.command);
    lines.push("```");
    lines.push("");
    lines.push(`**Pourquoi** : ${step.explanation}`);
    if (step.expectedOutput !== undefined && step.expectedOutput.trim().length > 0) {
      lines.push("");
      lines.push("**Sortie attendue** :");
      lines.push("");
      lines.push("```");
      lines.push(step.expectedOutput);
      lines.push("```");
    }
    for (const warning of step.warnings ?? []) {
      lines.push("");
      lines.push(`⚠️ ${warning}`);
    }
    lines.push("");
  }

  lines.push("## Pour aller plus loin");
  lines.push("");
  lines.push(...bulletSection(guide.nextSteps, "- Reproduisez la session dans un environnement de test pour la maîtriser."));
  lines.push("");
  return lines.join("\n");
}

export interface TerminalGuideResult {
  guide: TerminalGuide;
  artifactId: string;
  filename: string;
  storageKey: string;
}

export const terminalGuideTool: ToolDefinition<z.infer<typeof TerminalGuideInput>, TerminalGuideResult> = {
  id: "terminal.guide",
  name: "Interactive Terminal Simulation Recorder",
  description:
    "Turn a raw terminal session (pasted commands and outputs, any format) into a step-by-step interactive guide: each step carries its command in a code block, a pedagogical explanation of WHY, the expected output and safety warnings — adapted to the audience level, persisted as a real markdown deliverable.",
  category: "code",
  risk: "medium",
  inputSchema: TerminalGuideInput,
  async execute(input, context) {
    const parsed = TerminalGuideInput.parse(input);

    const guide = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "document",
      system: buildSystemPrompt(parsed.audience),
      user: buildUserPrompt(parsed),
      schema: TerminalGuideSchema,
      maxTokens: 3_500,
    });

    // Déterminisme : étapes renumérotées par ordre croissant côté rendu ET retour.
    const steps = [...guide.steps].sort((a, b) => a.order - b.order);
    const normalized: TerminalGuide = { ...guide, steps };
    const title =
      (parsed.title ?? "").trim() ||
      guide.title.trim() ||
      "Guide de session terminal";

    const markdown = renderTerminalGuideMarkdown(normalized, title);

    const deliverable = await persistMarkdownDeliverable({
      userId: context.userId,
      executionId: context.executionId,
      title,
      markdown,
    });

    return {
      guide: normalized,
      artifactId: deliverable.artifactId,
      filename: deliverable.filename,
      storageKey: deliverable.storageKey,
    };
  },
};
