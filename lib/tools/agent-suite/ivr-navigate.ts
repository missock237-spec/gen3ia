import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { generateStructuredForUser } from "./llm-json";

/**
 * Task 140 — Tool « ivr.navigate » (Interactive IVR Navigation Agent).
 *
 * Analyse un arbre de menus vocaux (SVI/IVR) — depuis une transcription des
 * annonces entendues OU un arbre structuré fourni — et calcule le CHEMIN
 * OPTIMAL de touches DTMF pour atteindre un objectif (« parler à un
 * conseiller », « annuler ma commande »…).
 *
 * Stratégie :
 *  1. arbre source : menuTree (déterministe, prioritaire) ou reconstruction
 *     LLM de la transcription (generateStructuredForUser, tâche « agent ») ;
 *  2. garde de profondeur (> 6 niveaux → erreur française explicite) ;
 *  3. recherche DÉTERMINISTE en largeur (BFS) avec score lexical : +2 par
 *     mot-clé de l'objectif trouvé dans le libellé d'une option, +1 par
 *     mot-clé trouvé dans l'annonce du sous-menu correspondant, +5 pour les
 *     options « human » quand l'objectif évoque un conseiller ;
 *  4. si la confiance déterministe est insuffisante (< 0,34) : un repli LLM
 *     ONE-SHOT propose une séquence de touches, VALIDÉE en remarchant
 *     l'arbre (jamais exécutée aveuglément — chemin tronqué + avertissement
 *     si une touche n'existe pas au niveau atteint).
 *
 * Toutes les comparaisons lexicales sont insensibles à la casse ET aux
 * accents (réclamation ≡ reclamation).
 */

/* ────────────────────────────────────────────────────────────────────────
 * Touches DTMF + arbre de menus
 * ──────────────────────────────────────────────────────────────────────── */

export const DTMF_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"] as const;
export type IvrDtmfKey = (typeof DTMF_KEYS)[number];
export type IvrOptionAction = "submenu" | "human" | "end" | "info";

export interface IvrOption {
  key: IvrDtmfKey;
  label: string;
  action: IvrOptionAction;
  submenu?: IvrMenuNode;
}

export interface IvrMenuNode {
  label?: string;
  prompt?: string;
  options: IvrOption[];
}

export const IvrMenuNodeSchema: z.ZodType<IvrMenuNode> = z.lazy(() =>
  z.object({
    label: z.string().max(200).optional(),
    prompt: z.string().max(500).optional(),
    options: z
      .array(
        z.object({
          key: z.enum(DTMF_KEYS),
          label: z.string().max(200),
          action: z.enum(["submenu", "human", "end", "info"]),
          submenu: IvrMenuNodeSchema.optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
);

const IvrMenuTreeSchema = z.object({ root: IvrMenuNodeSchema });

const FallbackKeysSchema = z.object({
  keys: z.array(z.enum(DTMF_KEYS)).min(1).max(10),
});

/* ────────────────────────────────────────────────────────────────────────
 * Entrée / sortie
 * ──────────────────────────────────────────────────────────────────────── */

const IvrNavigateInput = z
  .object({
    goal: z.string().min(3).max(500),
    menuTranscript: z.string().min(20).max(20_000).optional(),
    menuTree: IvrMenuNodeSchema.optional(),
  })
  .refine((data) => Boolean(data.menuTranscript ?? data.menuTree), {
    message: "Fournissez menuTranscript (annonces entendues) ou menuTree (arbre structuré) — l'un des deux au moins.",
  });

export interface IvrNavigatePathStep {
  /** Numéro d'étape (1-based). */
  step: number;
  key: IvrDtmfKey;
  label: string;
  action: IvrOptionAction;
}

export interface IvrNavigateResult {
  path: IvrNavigatePathStep[];
  /** Touches à composer, séparées par des virgules (ex. "1,4,2"). */
  dtmfSequence: string;
  estimatedDurationSeconds: number;
  /** Confiance 0-1 (score lexical normalisé, ou 0,3 en repli LLM validé). */
  confidence: number;
  /** Vrai quand la correspondance déterministe est assez confiante (≥ 0,34). */
  matchedGoal: boolean;
  warnings: string[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Constantes de score
 * ──────────────────────────────────────────────────────────────────────── */

/** Profondeur maximale de l'arbre (racine = 0). */
const MAX_IVR_DEPTH = 6;
/** Seuil de confiance en dessous duquel le repli LLM est déclenché. */
const CONFIDENCE_THRESHOLD = 0.34;
/** Confiance accordée à un chemin issu du repli LLM entièrement remarché. */
const FALLBACK_CONFIDENCE = 0.3;
/** Récompense des options « human » quand l'objectif évoque un humain. */
const HUMAN_BONUS = 5;

/** Mots-clés (normalisés, sans accents) qui évoquent un interlocuteur humain. */
const HUMAN_WORDS = new Set(["conseiller", "humain", "agent", "operateur", "teleconseiller", "commercial"]);

const TRANSCRIPT_SYSTEM_PROMPT = [
  "Tu es un analyseur de serveurs vocaux interactifs (SVI).",
  "On te donne la transcription des annonces entendues pendant un appel : reconstruis l'arbre des menus.",
  "Règles :",
  "- infère les touches « 1 », « 2 » … « 0 » d'après l'ORDRE des annonces quand le chiffre n'est pas énoncé ;",
  "- marque « human » toute option qui mène à un conseiller, un opérateur ou un téléconseiller ;",
  "- « submenu » quand l'option ouvre un sous-menu (fournis alors « submenu »), « end » quand elle termine l'appel, « info » sinon ;",
  "- libellés courts et fidèles aux annonces entendues.",
  'Réponds UNIQUEMENT avec le JSON { "root": { "options": [ … ] } } conforme au schéma.',
].join("\n");

const FALLBACK_SYSTEM_PROMPT = [
  "Tu es un navigateur de serveurs vocaux interactifs (SVI).",
  "On te donne l'arbre des menus (JSON) et un objectif d'appel : donne la séquence de touches DTMF la plus directe pour atteindre cet objectif.",
  'Réponds UNIQUEMENT avec le JSON { "keys": ["1", … ] } — 1 à 10 touches, chacune parmi "0" à "9", "*" et "#".',
].join("\n");

/* ────────────────────────────────────────────────────────────────────────
 * Helpers déterministes
 * ──────────────────────────────────────────────────────────────────────── */

/** Normalisation : minuscules + suppression des accents (NFD + retrait des diacritiques). */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Mots signifiants de l'objectif (≥ 3 caractères), normalisés. */
function extractGoalTokens(goal: string): string[] {
  return normalizeForMatch(goal)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/** Garde de profondeur : parcourt l'arbre et refuse les arborescences trop profondes. */
function assertDepthWithinLimit(root: IvrMenuNode): void {
  const walk = (node: IvrMenuNode, depth: number): void => {
    if (depth > MAX_IVR_DEPTH) {
      throw new Error(
        `Arbre SVI trop profond (plus de ${MAX_IVR_DEPTH} niveaux sous la racine) — la navigation automatique est refusée.`,
      );
    }
    for (const option of node.options) {
      if (option.submenu) walk(option.submenu, depth + 1);
    }
  };
  walk(root, 0);
}

interface InternalStep {
  nodeLabel?: string;
  key: IvrDtmfKey;
  optionLabel: string;
  action: IvrOptionAction;
}

interface ScoredPath {
  score: number;
  matchedTokens: Set<string>;
  steps: InternalStep[];
}

/** Départage déterministe : score → action « human » → chemin le plus court → ordre du document (BFS). */
function isBetterPath(candidate: ScoredPath, incumbent: ScoredPath): boolean {
  if (candidate.score !== incumbent.score) return candidate.score > incumbent.score;
  const candidateHuman = candidate.steps[candidate.steps.length - 1]?.action === "human";
  const incumbentHuman = incumbent.steps[incumbent.steps.length - 1]?.action === "human";
  if (candidateHuman !== incumbentHuman) return candidateHuman;
  if (candidate.steps.length !== incumbent.steps.length) return candidate.steps.length < incumbent.steps.length;
  return false;
}

/**
 * Recherche en largeur du meilleur chemin : chaque option de l'arbre est
 * notée contre l'objectif (+2 libellé, +1 annonce du sous-menu, +5 humain).
 */
function findBestPath(root: IvrMenuNode, goal: string): ScoredPath | null {
  const tokens = extractGoalTokens(goal);
  const wantsHuman = tokens.some((token) => HUMAN_WORDS.has(token));
  let best: ScoredPath | null = null;

  const queue: Array<{ node: IvrMenuNode; steps: InternalStep[]; matchedTokens: Set<string> }> = [
    { node: root, steps: [], matchedTokens: new Set() },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    for (const option of current.node.options) {
      const step: InternalStep = {
        nodeLabel: current.node.label,
        key: option.key,
        optionLabel: option.label,
        action: option.action,
      };
      const steps = [...current.steps, step];

      let score = 0;
      const matchedTokens = new Set(current.matchedTokens);
      const optionText = normalizeForMatch(option.label);
      const submenuPrompt = option.submenu?.prompt ? normalizeForMatch(option.submenu.prompt) : "";
      for (const token of tokens) {
        if (optionText.includes(token)) {
          score += 2;
          matchedTokens.add(token);
        } else if (submenuPrompt.includes(token)) {
          score += 1;
          matchedTokens.add(token);
        }
      }
      if (wantsHuman && option.action === "human") score += HUMAN_BONUS;

      const candidate: ScoredPath = { score, matchedTokens, steps };
      if (best === null || isBetterPath(candidate, best)) {
        best = candidate;
      }

      if (option.submenu) {
        queue.push({ node: option.submenu, steps, matchedTokens });
      }
    }
  }

  return best;
}

/** Confiance normalisée : mots-clés de l'objectif couverts par le chemin (0-1). */
function pathConfidence(path: ScoredPath, goal: string): number {
  const tokens = extractGoalTokens(goal);
  if (tokens.length === 0) return 0;
  return Math.min(1, path.matchedTokens.size / tokens.length);
}

interface WalkOutcome {
  steps: Array<{ key: IvrDtmfKey; label: string; action: IvrOptionAction }>;
  warnings: string[];
  consumed: number;
  total: number;
}

/**
 * Remarche une séquence de touches DTMF depuis la racine : chaque touche
 * doit exister au niveau courant. Le chemin est tronqué au premier écart,
 * avec un avertissement honnête — jamais d'invention.
 */
function walkDtmfSequence(root: IvrMenuNode, keys: IvrDtmfKey[]): WalkOutcome {
  const steps: WalkOutcome["steps"] = [];
  const warnings: string[] = [];
  let node: IvrMenuNode = root;
  let consumed = 0;

  for (let i = 0; i < keys.length; i += 1) {
    const option = node.options.find((candidate) => candidate.key === keys[i]);
    if (!option) {
      warnings.push(
        `La touche « ${keys[i]} » proposée par le modèle est absente du niveau atteint — chemin tronqué.`,
      );
      break;
    }
    steps.push({ key: option.key, label: option.label, action: option.action });
    consumed += 1;
    if (i < keys.length - 1) {
      if (option.submenu) {
        node = option.submenu;
      } else {
        warnings.push(
          `La touche « ${keys[i + 1]} » ne peut pas être composée : « ${option.label} » n'ouvre aucun sous-menu.`,
        );
        break;
      }
    }
  }

  return { steps, warnings, consumed, total: keys.length };
}

function buildPathSteps(steps: WalkOutcome["steps"]): IvrNavigatePathStep[] {
  return steps.map((step, index) => ({ step: index + 1, ...step }));
}

/* ────────────────────────────────────────────────────────────────────────
 * Tool
 * ──────────────────────────────────────────────────────────────────────── */

export const ivrNavigateTool: ToolDefinition<z.infer<typeof IvrNavigateInput>, IvrNavigateResult> = {
  id: "ivr.navigate",
  name: "Interactive IVR Navigation Agent",
  description:
    "Analyze a phone IVR menu tree (from a heard-announcement transcript or a structured tree) and compute the optimal DTMF key path toward a goal such as reaching a human advisor or cancelling an order.",
  category: "system",
  risk: "low",
  inputSchema: IvrNavigateInput,
  async execute(input, context) {
    // 1. Arbre source : menuTree prioritaire (déterministe), sinon LLM.
    let root: IvrMenuNode;
    if (input.menuTree) {
      root = input.menuTree;
    } else {
      const transcript = input.menuTranscript ?? "";
      const parsed = await generateStructuredForUser({
        userId: context.userId,
        executionId: context.executionId,
        task: "agent",
        system: TRANSCRIPT_SYSTEM_PROMPT,
        user: `Transcription des annonces entendues :\n\n${transcript}`,
        schema: IvrMenuTreeSchema,
        maxTokens: 2_500,
      });
      root = parsed.root;
    }

    // 2. Garde de profondeur (s'applique aux deux sources d'arbre).
    assertDepthWithinLimit(root);

    // 3. Recherche déterministe du meilleur chemin.
    const best = findBestPath(root, input.goal);
    const warnings: string[] = [];

    if (best) {
      const confidence = pathConfidence(best, input.goal);
      if (confidence >= CONFIDENCE_THRESHOLD) {
        const lastAction = best.steps[best.steps.length - 1]?.action;
        if (lastAction === "submenu") {
          warnings.push(
            "Le chemin s'arrête à l'entrée d'un sous-menu — la suite des touches dépend des annonces qui seront lues ensuite.",
          );
        }
        const path = buildPathSteps(
          best.steps.map((step) => ({ key: step.key, label: step.optionLabel, action: step.action })),
        );
        return {
          path,
          dtmfSequence: path.map((step) => step.key).join(","),
          estimatedDurationSeconds: path.length * 3 + 2,
          confidence: Math.round(confidence * 100) / 100,
          matchedGoal: true,
          warnings,
        };
      }
    }

    // 4. Repli LLM one-shot (confiance déterministe insuffisante).
    const treeJson = JSON.stringify(root);
    const cappedTree = treeJson.length > 8_192 ? `${treeJson.slice(0, 8_192)}…` : treeJson;
    let fallbackKeys: IvrDtmfKey[] | null = null;
    try {
      const fallback = await generateStructuredForUser({
        userId: context.userId,
        executionId: context.executionId,
        task: "automation",
        system: FALLBACK_SYSTEM_PROMPT,
        user: `Objectif de l'appel : ${input.goal}\n\nArbre des menus (JSON) :\n${cappedTree}`,
        schema: FallbackKeysSchema,
        maxTokens: 600,
      });
      fallbackKeys = fallback.keys;
    } catch (error) {
      warnings.push(
        `Le repli IA n'a pas abouti (${error instanceof Error ? error.message.slice(0, 160) : "erreur inconnue"}) — chemin déterministe le mieux disant retourné.`,
      );
    }

    if (fallbackKeys) {
      const walk = walkDtmfSequence(root, fallbackKeys);
      warnings.push(...walk.warnings);
      const path = buildPathSteps(walk.steps);
      const fraction = walk.total === 0 ? 0 : walk.consumed / walk.total;
      return {
        path,
        dtmfSequence: path.map((step) => step.key).join(","),
        estimatedDurationSeconds: path.length * 3 + 2,
        confidence: Math.round(FALLBACK_CONFIDENCE * fraction * 100) / 100,
        matchedGoal: false,
        warnings,
      };
    }

    // 5. Repli du repli : chemin déterministe (faible confiance) honnête.
    if (best) {
      const path = buildPathSteps(
        best.steps.map((step) => ({ key: step.key, label: step.optionLabel, action: step.action })),
      );
      return {
        path,
        dtmfSequence: path.map((step) => step.key).join(","),
        estimatedDurationSeconds: path.length * 3 + 2,
        confidence: 0,
        matchedGoal: false,
        warnings,
      };
    }

    return {
      path: [],
      dtmfSequence: "",
      estimatedDurationSeconds: 2,
      confidence: 0,
      matchedGoal: false,
      warnings: [...warnings, "Aucune option exploitable dans l'arbre fourni."],
    };
  },
};
