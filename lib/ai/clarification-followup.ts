/**
 * GEN3IA — Task 135 : suivi contextuel GÉNÉRIQUE des clarifications.
 *
 * Amélioration #1 (« le projet doit savoir avec précision la demande de
 * l'utilisateur ; en cas de confusion ou d'incompréhension, il doit
 * demander à l'utilisateur pour se rassurer ») : quand l'agent pose une
 * question de clarification, la réponse de l'utilisateur doit être
 * RATTACHÉE à la demande d'origine — pas traitée comme un nouveau sujet.
 *
 * Généralisation du pattern dédié existant (resolveVoiceRequestFromContext
 * dans video-intent.ts, resolveCodeRequestFromContext dans code-intent.ts)
 * en une primitive unique :
 *  - `markClarification(content)` : signale qu'un message assistant EST une
 *    clarification en attente (marqueur structurel "🔄 Précision" — aucune
 *    dépendance à un champ de persistance, fonctionne avec l'historique
 *    déjà stocké par les moteurs historiques) ;
 *  - `isClarificationPending(content)` : le dernier message assistant
 *    est-il une clarification en attente de réponse ?
 *  - `resolveClarifiedObjective(message, priorHistory)` : recompose
 *    l'objectif complet = demande d'origine + réponse de l'utilisateur.
 *
 * PUR (aucune dépendance serveur) : testable et réutilisable par les deux
 * moteurs de chat (agent studio + conversations workspace).
 */

/** Marqueur structurel des questions de clarification (stable, FR). */
export const CLARIFICATION_MARKER = "🔄 Précision";

/**
 * Habille une question de clarification : le marqueur permet à la fois la
 * détection contextuelle au tour suivant ET un rendu UI différencié
 * (encart « précision demandée » au lieu d'une réponse plate).
 */
export function markClarification(question: string): string {
  const trimmed = question.trim();
  if (!trimmed || trimmed.startsWith(CLARIFICATION_MARKER)) return trimmed;
  return `${CLARIFICATION_MARKER} — ${trimmed}`;
}

/**
 * Retire le marqueur pour l'affichage ou la relecture naturelle.
 */
export function stripClarificationMark(content: string): string {
  return content.trim().replace(new RegExp(`^${CLARIFICATION_MARKER}\\s*[—–-]?\\s*`, "u"), "");
}

/** Le message assistant est-il une clarification en attente de réponse ? */
export function isClarificationPending(content: string): boolean {
  return content.trim().startsWith(CLARIFICATION_MARKER);
}

/** Réponse qui annule le suivi contextuel (« non », « annule », « laisse »…). */
const REFUSAL_RE = /^(?:non|nan|annul\p{L}*|stop|laisse\p{L}*|oubli\p{L}*|finalement|en fait|peu importe|n'importe)\b/iu;

export interface HistoryTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ClarifiedObjective {
  /** Objectif recomposé : demande d'origine + réponse de clarification. */
  objective: string;
  /** Question qui était posée (sans marqueur). */
  question: string;
  /** Demande utilisateur d'origine (celle qui a déclenché la question). */
  originalRequest: string;
  /** true si la réponse de l'utilisateur est un refus (aucun objectif). */
  refused: boolean;
}

/**
 * Résout le tour courant comme réponse à une clarification en attente :
 * remonte l'historique depuis la fin — le dernier message assistant doit
 * être une clarification, et le dernier message utilisateur AVANT elle est
 * la demande d'origine. Retourne null si ce motif ne s'applique pas.
 *
 * L'objectif recomposé préfixe la demande d'origine : la réponse
 * (l'information manquante) est la PLUS importante, mais la demande
 * d'origine donne le contexte complet nécessaire à l'exécution.
 */
export function resolveClarifiedObjective(message: string, priorHistory: HistoryTurn[] = []): ClarifiedObjective | null {
  const answer = message.trim();
  if (!answer || REFUSAL_RE.test(answer)) return null;

  // Dernier message assistant = clarification en attente ?
  let lastAssistant: string | null = null;
  let originalRequest: string | null = null;
  let searchOriginal = false;
  for (let index = priorHistory.length - 1; index >= 0; index -= 1) {
    const turn = priorHistory[index];
    if (!turn || turn.role === "system" || !turn.content?.trim()) continue;
    if (!searchOriginal) {
      if (turn.role !== "assistant") return null; // l'utilisateur a parlé après la question → pas notre motif
      if (!isClarificationPending(turn.content)) return null; // réponse livrée, pas une clarification
      lastAssistant = turn.content;
      searchOriginal = true;
      continue;
    }
    // Recherche de la demande d'origine : premier message utilisateur avant la question.
    if (turn.role === "user") {
      originalRequest = turn.content.trim();
      break;
    }
    // Des messages assistant intermédiaires (hors clarification) cassent le motif.
    if (turn.role === "assistant" && !isClarificationPending(turn.content)) return null;
  }
  if (!lastAssistant || !originalRequest) return null;

  const question = stripClarificationMark(lastAssistant);
  return {
    objective: `${originalRequest.slice(0, 1500)}\n\n[Précision apportée par l'utilisateur : ${answer.slice(0, 800)}]`,
    question,
    originalRequest,
    refused: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * GARDE D'AMBIGUÏTÉ DÉTERMINISTE (repli sans LLM et pré-détection).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Signaux d'ambiguïté DÉTERMINISTES sur le message brut (aucun LLM) :
 * demande d'action avec référent implicite non résolvable (« fais-le »,
 * « la même chose », « continue ») ou trop courte pour être exécutable.
 */
const IMPLICIT_REFERENT_RE =
  /\b(?:fais[- ]le|fais[- ]la|fais[- ]les|refais[- ]le|refais[- ]la|continue\p{L}*|la m[êe]me chose|la m[êe]me|comme avant|pareil qu[''’]hier|encore une fois|refais[- ]moi [çc]a|reprends? [çc]a)\b/iu;

/** Verbes d'action explicites (miroir EXPLICIT_ACTION_VERB_RE du chat-engine). */
const ACTION_VERB_RE =
  /\b(cr[ée]e(?:r|z)?|g[éeè]n[éèe]r\p{L}*|r[ée]dige(?:r|z)?|envoi(?:e|er|ez)|exp[ée]di\p{L}*|pr[ée]par\p{L}*|construis\p{L}*|montre[- ]moi|analyse(?:r|z)?|cr[ée]\p{L}*|produis\p{L}*|planifi\p{L}*|publi\p{L}*|d[ée]ploy\p{L}*|supprim\p{L}*|modifi\p{L}*)\b/iu;

export interface AmbiguitySignals {
  /** true si la demande porte des signes d'incompréhension possibles. */
  ambiguous: boolean;
  /** Détection de la cause (journalisable, jamais exposée telle quelle). */
  reason: "implicit-referent" | "too-short" | "";
}

/**
 * Détecte les signaux d'ambiguïté déterministes AVANT tout appel LLM :
 * utilisé par les deux moteurs pour forcer une question de clarification
 * même si le classifieur n'en a pas proposé (repli et garde-fou).
 */
export function detectAmbiguitySignals(message: string): AmbiguitySignals {
  const trimmed = message.trim();
  if (trimmed.length >= 3 && trimmed.length <= 14 && ACTION_VERB_RE.test(trimmed)) {
    return { ambiguous: true, reason: "too-short" };
  }
  if (IMPLICIT_REFERENT_RE.test(trimmed)) {
    return { ambiguous: true, reason: "implicit-referent" };
  }
  return { ambiguous: false, reason: "" };
}

/**
 * Question de clarification déterministe (aucun LLM) pour les signaux
 * détectés ci-dessus — toujours en français, toujours actionnable.
 */
export function deterministicClarifyingQuestion(signals: AmbiguitySignals, message: string): string | null {
  if (!signals.ambiguous) return null;
  const excerpt = message.trim().slice(0, 80);
  if (signals.reason === "implicit-referent") {
    return `Je veux être sûr de bien vous comprendre : à quoi faites-vous référence exactement par « ${excerpt} » ? Précisez l'élément ou la tâche concernée et je m'y mets immédiatement.`;
  }
  return `Votre demande (« ${excerpt} ») est un peu courte pour être exécutée correctement : que souhaitez-vous précisément que je crée, génère ou prépare ?`;
}
