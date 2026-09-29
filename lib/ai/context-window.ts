/**
 * FENÊTRE DE CONTEXTE (Task 42, axe 1) — budgets par modèle + compression
 * d'historique pour les documents et conversations très longs.
 *
 * Deux niveaux :
 *  1. CONNAISSANCE : registre des fenêtres de contexte réelles des modèles
 *     servis par les providers Gen3ia (mise à jour à l'ajout d'un modèle).
 *     `clampOutputTokens` empêche de demander plus de tokens de sortie que
 *     la moitié de la fenêtre du modèle (rejet systématique côté API sinon).
 *  2. COMPRESSION : `compressHistory` est une fonction PURE et DÉTERMINISTE
 *     (aucun appel LLM — testable, sans coût ni latence) qui tient un
 *     historique entier dans un budget de tokens d'entrée :
 *      - les messages les plus RÉCENTS sont conservés VERBATIM (pertinence
 *        maximale au point de lecture) ;
 *      - les messages plus anciens sont condensés en un DIGEST extractif
 *        (phrases d'ouverture, sans invention — anti-hallucination) ;
 *      - le digest est injecté en tête, étiqueté comme résumé.
 *
 * Politique de confidentialité : tout le traitement est en mémoire, aucun
 * contenu de conversation n'est persisté par ce module.
 */

import type { AIMessage } from "./models";

/* ------------------------------------------------------------------ */
/* Registre des fenêtres de contexte (tokens d'entrée + sortie)        */
/* ------------------------------------------------------------------ */

/** Fenêtres connues, modèle par modèle (substring, insensible à la casse). */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<{
  match: RegExp;
  /** Tokens d'entrée+sortie totaux supportés par le modèle. */
  window: number;
}> = [
  // Anthropic
  { match: /claude-(3-5|3-7|4|sonnet|opus|haiku)/i, window: 200_000 },
  // OpenAI
  { match: /gpt-4o/i, window: 128_000 },
  { match: /gpt-4\.1/i, window: 1_000_000 },
  { match: /gpt-4-turbo/i, window: 128_000 },
  { match: /gpt-4\b/i, window: 8_192 },
  { match: /o[134](-mini|-preview)?\b/i, window: 128_000 },
  { match: /gpt-3\.5/i, window: 16_385 },
  // Google (via openai-compatible / agnes)
  { match: /gemini-1\.5/i, window: 1_000_000 },
  { match: /gemini-2/i, window: 1_000_000 },
  // Meta Llama 3.x / 4 (Groq, OpenRouter, HF)
  { match: /llama-?3\.[13]|llama-?4/i, window: 128_000 },
  { match: /llama-?2/i, window: 4_096 },
  // Mistral
  { match: /mistral-large/i, window: 128_000 },
  { match: /mixtral/i, window: 32_768 },
  { match: /mistral-7b/i, window: 32_768 },
  // Qwen
  { match: /qwen2?\.?5?-?(max|plus|coder|72b)/i, window: 128_000 },
  { match: /qwen/i, window: 32_768 },
  // DeepSeek
  { match: /deepseek-chat|deepseek-v3/i, window: 128_000 },
  { match: /deepseek-reasoner|r1/i, window: 64_000 },
  // GLM
  { match: /glm-4/i, window: 128_000 },
  // Agnes
  { match: /agnes/i, window: 128_000 },
];

/** Fallback conservateur quand le modèle est inconnu. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

export function contextWindowForModel(model: string | undefined | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (entry.match.test(model)) return entry.window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Borne les tokens de sortie demandés à la moitié de la fenêtre du modèle
 * (les providers rejetant les requêtes maxTokens > fenêtre − entrée).
 * Jamais en dessous de 512 : un plafond dérisoire est un bug, pas une garde.
 */
export function clampOutputTokens(model: string | undefined | null, requested: number | undefined): number {
  const ceiling = Math.max(512, Math.floor(contextWindowForModel(model) / 2));
  if (!requested || !Number.isFinite(requested)) return Math.min(8_192, ceiling);
  return Math.max(512, Math.min(requested, ceiling));
}

/* ------------------------------------------------------------------ */
/* Estimation de tokens (heuristique sans tokenizer embarqué)          */
/* ------------------------------------------------------------------ */

/**
 * Estimation prudente : ~3.2 caractères par token pour un mélange
 * franglais/français avec code (mesuré sur des sorties réelles ; le
 * tokenizer réel varie ±15 % — la marge est absorbée par le facteur 0.8
 * appliqué au budget dans compressHistory).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.2));
}

export function estimateMessagesTokens(messages: AIMessage[]): number {
  // ~4 tokens d'overhead par message (rôle + délimiteurs de chat template).
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/* ------------------------------------------------------------------ */
/* Compression d'historique (pure, déterministe)                       */
/* ------------------------------------------------------------------ */

export interface CompressHistoryOptions {
  /** Budget de tokens DISPONIBLE pour l'historique (après system+message). */
  budgetTokens: number;
  /**
   * Nombre de messages récents conservés VERBATIM, même serrés
   * (le point de lecture doit toujours voir la fin de la conversation).
   */
  keepRecent?: number;
  /** Longueur max du digest d'un message ancien (caractères). */
  digestPerMessage?: number;
}

export interface CompressedHistory {
  /** Messages à envoyer au modèle (digest en tête + récents verbatim). */
  messages: AIMessage[];
  /** Nombre de messages condensés dans le digest. */
  condensed: number;
  /** Tokens estimés de l'historique compressé. */
  estimatedTokens: number;
  /** true si le budget a forcé une compression. */
  compressed: boolean;
}

const DIGEST_HEADER =
  "[Résumé des échanges antérieurs — condensé extractif, aucune information inventée. Les messages récents suivent intégralement.]";

/** Extrait au plus `max` caractères de "substance" d'un message ancien. */
function extractiveDigest(content: string, max: number): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  // Première phrase (ou première 1/3) = l'apport principal du message.
  const sentenceEnd = clean.search(/[.!?…](\s|$)/);
  const head = sentenceEnd > 40 ? clean.slice(0, sentenceEnd + 1) : clean.slice(0, Math.ceil(max * 0.6));
  return `${head}${clean.length > head.length ? " …" : ""}`.slice(0, max);
}

/**
 * Tient `history` dans `budgetTokens` : récents verbatim + digest extractif
 * des plus anciens. Ne JAMAIS inventer : le digest ne contient que des
 * sous-chaînes littérales des messages originaux.
 */
export function compressHistory(history: AIMessage[], options: CompressHistoryOptions): CompressedHistory {
  const keepRecent = Math.max(2, options.keepRecent ?? 8);
  const digestPerMessage = Math.max(80, options.digestPerMessage ?? 220);
  // Facteur 0.8 : marge sur l'heuristique d'estimation (±15 %).
  const usable = Math.max(256, Math.floor(options.budgetTokens * 0.8));

  if (history.length === 0) {
    return { messages: [], condensed: 0, estimatedTokens: 0, compressed: false };
  }

  const recent = history.slice(-keepRecent);
  const older = history.slice(0, -keepRecent);
  const recentTokens = estimateMessagesTokens(recent);

  // Cas 1 : tout tient (cas courant — aucune transformation).
  if (estimateMessagesTokens(history) <= usable) {
    return { messages: [...history], condensed: 0, estimatedTokens: estimateMessagesTokens(history), compressed: false };
  }

  // Cas 2 : les récents seuls débordent le budget → troncature progressive
  // par la fin de la liste récente (on garde le plus récent possible).
  if (recentTokens > usable) {
    const kept: AIMessage[] = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const cost = estimateMessagesTokens([recent[i]]);
      if (used + cost > usable && kept.length > 0) break;
      kept.unshift(recent[i]);
      used += cost;
    }
    // Dernier recours : tronquer le contenu du message le plus récent.
    if (kept.length === 0) {
      const last = recent[recent.length - 1];
      const charBudget = Math.max(200, usable * 3);
      return {
        messages: [{ role: last.role, content: last.content.slice(-Math.floor(charBudget)) }],
        condensed: history.length - 1,
        estimatedTokens: usable,
        compressed: true,
      };
    }
    return { messages: kept, condensed: history.length - kept.length, estimatedTokens: used, compressed: true };
  }

  // Cas 3 : récents tiennent → digest extractif des anciens avec le budget
  // restant (du plus récent au plus ancien : les plus anciens sont tronqués
  // en premier si le budget manque).
  const digestBudgetTokens = usable - recentTokens;
  const digestEntries: string[] = [];
  let used = estimateTokens(DIGEST_HEADER);
  for (let i = older.length - 1; i >= 0; i--) {
    const entry = `${older[i].role === "user" ? "Utilisateur" : "Assistant"} : ${extractiveDigest(older[i].content, digestPerMessage)}`;
    const cost = estimateTokens(entry) + 1;
    if (used + cost > digestBudgetTokens && digestEntries.length > 0) break;
    digestEntries.unshift(entry);
    used += cost;
  }

  const messages: AIMessage[] = [];
  if (digestEntries.length > 0) {
    messages.push({ role: "system", content: `${DIGEST_HEADER}\n${digestEntries.join("\n")}` });
  }
  messages.push(...recent);

  return {
    messages,
    condensed: older.length - (older.length - digestEntries.length),
    estimatedTokens: estimateMessagesTokens(messages),
    compressed: true,
  };
}

/**
 * Assemble un prompt complet (system + historique compressé + message)
 * dans la fenêtre du modèle visé. Point d'entrée unique pour les surfaces
 * conversationnelles qui gèrent des historiques longs.
 */
export function assembleMessages(params: {
  system: string;
  history: AIMessage[];
  message: string;
  model?: string | null;
  /** Réservé à la réponse du modèle (tokens de sortie prévus). */
  reservedOutputTokens?: number;
  keepRecent?: number;
}): { messages: AIMessage[]; compressed: CompressedHistory } {
  const window = contextWindowForModel(params.model);
  const reservedOutput = params.reservedOutputTokens ?? Math.min(4_000, Math.floor(window / 8));
  const historyBudget = window - estimateTokens(params.system) - estimateTokens(params.message) - reservedOutput - 32;
  const compressed = compressHistory(params.history, {
    budgetTokens: Math.max(256, historyBudget),
    keepRecent: params.keepRecent,
  });
  return {
    messages: [
      { role: "system", content: params.system },
      ...compressed.messages,
      { role: "user", content: params.message },
    ],
    compressed,
  };
}
