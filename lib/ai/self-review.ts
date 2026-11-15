import "server-only";

import { generate } from "./router";
import { stripThinkTags } from "./think-filter";

/**
 * SELF-REFLECTION SUR LES RÉPONSES VISIBLES (Task 138 — optimisation de la
 * qualité des réponses IA).
 *
 * Exigence utilisateur : « Programmez des étapes où l'agent critique sa
 * propre production ou valide son code avant de le soumettre. »
 *
 * Le moteur de mission disposait déjà d'un critic (post-exécution) et la
 * planification d'une boucle plan → critique → révision — mais les RÉPONSES
 * DE CHAT visibles étaient livrées BRUTES, sans aucune relecture. Ce module
 * comble ce manque : une passe de révision indépendante (rôle critique) qui
 * évalue la proposition AVANT livraison sur quatre axes — exactitude,
 * complétude, fiabilité (hallucination), structure — et rend soit la version
 * conforme, soit une version corrigée.
 *
 * Garde-fous de coût et de latence :
 *  - ne s'applique qu'aux réponses SUBSTANTIELLES (≥ SELF_REVIEW_MIN_LENGTH
 *    caractères) : une salutation ou une réponse courte n'a rien à réviser ;
 *  - UNE SEULE passe par réponse (jamais de boucle de révision imbriquée) ;
 *  - désactivable sans redéploiement via GEN3IA_SELF_REVIEW=off ;
 *  - fail-soft TOTAL : une panne du réviseur rend la proposition d'origine —
 *    la relecture ne peut jamais casser une réponse qui existait.
 */

/** Longueur minimale d'une réponse pour mériter une passe de révision. */
export const SELF_REVIEW_MIN_LENGTH = 600;

/** Les réponses démesurées ne sont pas révisées (coût/latence, troncature du juge). */
export const SELF_REVIEW_MAX_LENGTH = 24_000;

export interface SelfReviewResult {
  /** "conforme" : proposition livrée telle quelle ; "ameliore" : version corrigée. */
  verdict: "conforme" | "ameliore";
  /** Texte FINAL à livrer (corrigé si « ameliore », sinon la proposition). */
  text: string;
  /** Défauts détectés par le réviseur (observabilité — vide si conforme). */
  issues: string[];
  /** Raison pour laquelle la révision n'a pas eu lieu (observabilité). */
  skipped?: "disabled" | "too_short" | "too_long" | "error";
}

/**
 * Activation de la self-reflection : `GEN3IA_SELF_REVIEW` (env serveur).
 *  - absent ou toute autre valeur → ACTIVÉ (défaut sûr : l'exigence qualité prime) ;
 *  - « off » / « disabled » / « false » / « 0 » → désactivé.
 * Lecture À L'APPEL (pas au chargement du module) : un changement d'env sur
 * Vercel s'applique sans redéploiement.
 */
export function selfReviewEnabled(): boolean {
  const raw = process.env.GEN3IA_SELF_REVIEW?.trim().toLowerCase();
  return raw !== "off" && raw !== "disabled" && raw !== "false" && raw !== "0";
}

/** Une réponse mérite-t-elle une passe de révision ? (longueur utile) */
export function shouldSelfReview(answer: string): boolean {
  const length = answer.trim().length;
  return length >= SELF_REVIEW_MIN_LENGTH && length <= SELF_REVIEW_MAX_LENGTH;
}

const REVIEWER_SYSTEM = [
  "Tu es le réviseur qualité de Gen3ia (self-reflection) : tu critiques la production d'un agent AVANT sa livraison à l'utilisateur.",
  "On te donne la demande de l'utilisateur, un éventuel contexte, et la réponse PROPOSITIONNELLE de l'agent. Évalue-la sur quatre axes, dans cet ordre :",
  "1. EXACTITUDE — la réponse répond-elle PRÉCISÉMENT à la demande posée ? Traite-t-elle le point demandé (ni à côté, ni partiellement) ?",
  "2. COMPLÉTUDE — toutes les parties de la demande sont-elles couvertes ? Une sous-question ignorée est un défaut.",
  "3. FIABILITÉ — des faits, chiffres, sources ou affirmations semblent-ils inventés, invérifiables ou trop approximatifs ?",
  "4. STRUCTURE — réponse directe dès la première ligne, markdown propre, longueur adaptée (ni remplissage, ni squelette) ?",
  "Règles impératives :",
  "- Si la proposition est déjà de qualité sur les quatre axes → verdict « conforme », renvoie-la telle quelle.",
  "- Sinon → verdict « ameliore » et produis la version corrigée : réponds mieux à la question, corrige les défauts listés, structure plus clairement.",
  "- Ne PERDS JAMAIS d'information utile ; n'INVENTE JAMAIS de nouvelle information, de source ou de chiffre absent de la proposition.",
  "- Conserve EXACTEMENT la langue de la proposition.",
  "Réponds STRICTEMENT en JSON : {\"verdict\":\"conforme|ameliore\",\"issues\":[\"défaut détecté\", …],\"text\":\"texte final complet\"}",
].join(" ");

/** Extrait un objet JSON d'une réponse LLM (fences et texte périphérique tolérés). */
function parseReview(text: string): { verdict?: unknown; issues?: unknown; text?: unknown } | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as { verdict?: unknown; issues?: unknown; text?: unknown };
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(candidate.slice(start, end + 1));
          if (parsed && typeof parsed === "object") return parsed as { verdict?: unknown; issues?: unknown; text?: unknown };
        } catch {
          /* candidat suivant */
        }
      }
    }
  }
  return null;
}

/**
 * Passe de self-reflection sur une réponse visible.
 * Retourne TOUJOURS un texte livrable : en cas d'indisponibilité du réviseur,
 * de réponse illisible ou de verdict ambigu, la proposition d'origine est
 * rendue telle quelle (la révision ne dégrade jamais).
 */
export async function reviewVisibleAnswer(params: {
  /** Demande de l'utilisateur (telle que posée). */
  question: string;
  /** Proposition de réponse de l'agent (à critiquer). */
  answer: string;
  /** Contexte réel optionnel (note de contexte, extrait de conversation). */
  contextNote?: string;
}): Promise<SelfReviewResult> {
  const original = params.answer;

  // Garde-fous : désactivation explicite ou réponse trop courte pour être
  // révisée utilement (une réponse de deux lignes n'a pas de défaut de
  // structure à corriger — et la latence reste le prioritaire sur le chat).
  if (!selfReviewEnabled()) return { verdict: "conforme", text: original, issues: [], skipped: "disabled" };
  if (original.trim().length < SELF_REVIEW_MIN_LENGTH) return { verdict: "conforme", text: original, issues: [], skipped: "too_short" };
  if (original.trim().length > SELF_REVIEW_MAX_LENGTH) return { verdict: "conforme", text: original, issues: [], skipped: "too_long" };

  try {
    const response = await generate({
      task: "reasoning",
      messages: [
        { role: "system", content: REVIEWER_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            demande: params.question.slice(0, 4_000),
            ...(params.contextNote ? { contexte: params.contextNote.slice(0, 4_000) } : {}),
            proposition: original,
          }),
        },
      ],
      requiresStructuredOutput: true,
      maxTokens: 4_096,
      metadata: { purpose: "self-review-visible-answer" },
    });

    const parsed = parseReview(response.text);
    if (!parsed) {
      // Réviseur illisible : comportement conservateur = proposition d'origine.
      return { verdict: "conforme", text: original, issues: [], skipped: "error" };
    }

    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0).slice(0, 5)
      : [];

    if (parsed.verdict === "ameliore" && typeof parsed.text === "string") {
      const improved = stripThinkTags(parsed.text.trim());
      // La version « corrigée » doit être SUBSTANTIELLE : une réponse corrompue
      // (vide, tronquée à quelques caractères) ne remplace jamais une
      // proposition complète — garde anti-dégradation.
      if (improved.length >= Math.min(original.trim().length, SELF_REVIEW_MIN_LENGTH) && improved !== original) {
        return { verdict: "ameliore", text: improved, issues };
      }
    }
    return { verdict: "conforme", text: original, issues };
  } catch {
    // Fail-soft total : la relecture ne casse JAMAIS une réponse existante.
    return { verdict: "conforme", text: original, issues: [], skipped: "error" };
  }
}
