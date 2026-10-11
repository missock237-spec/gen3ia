import type { ConversationMessage as ChatMessage } from "./types";

/** Alias public : l'historique est fait de messages de conversation (« ChatMessage » côté repository). */
export type { ConversationMessage as ChatMessage } from "./types";

/**
 * FENÊTRE GLISSANTE DE CONTEXTE (Task 131 — axe « Gestion de contexte »).
 *
 * AVANT : le moteur de conversation envoyait au modèle un slice naïf des 16
 * derniers messages (`historyForModel`). Sur une conversation longue :
 *  - les 16 derniers messages pouvaient dépasser largement la fenêtre réelle
 *    du modèle (erreurs fournisseur, réponses tronquées) ;
 *  - le PREMIER message utilisateur — l'intention d'origine, le contrat de la
 *    conversation — disparaissait silencieusement : l'agent « oubliait » pour
 *    quoi il travaillait.
 *
 * APRÈS : `buildContextWindow` construit la fenêtre sous un BUDGET DE TOKENS :
 *  - le prompt système est TOUJOURS réservé en premier (jamais tronqué, jamais
 *    évacué — il porte les règles de conduite de l'agent) ;
 *  - les messages les plus RÉCENTS ont la priorité (ordre chronologique
 *    strict préservé dans le résultat) ;
 *  - le PREMIER message utilisateur est conservé si son coût rentre dans le
 *    budget restant (ancre d'intention) ;
 *  - les messages évacués sont remplacés par un RÉSUMÉ COMPACT DÉTERMINISTE
 *    (zéro LLM, zéro réseau, zéro latence) : rôle + premiers caractères +
 *    noms d'outils appelés + marqueur de résultat — les payloads volumineux
 *    (sorties d'outils de plusieurs milliers de caractères) sont tronqués en
 *    priorité, ce sont eux qui coûtent le plus cher pour le moins d'information.
 *
 * Le résumé est injecté par l'appelant comme message système additionnel
 * (`summaryPrefix`) AVANT les messages conservés : le modèle sait que du
 * contexte plus ancien existe, sans en subir le coût intégral.
 *
 * Module PUR (aucune E/S, aucune dépendance serveur) : testé isolément,
 * déterministe — deux exécutions sur la même entrée produisent exactement la
 * même sortie (aucune horloge, aucun aléatoire).
 */

/** Taille maximale du contenu gardé par message dans le résumé compact. */
export const COMPACT_CONTENT_CHARS = 240;

/**
 * Plafond de tokens du résumé déterministe. La réserve est déduite du budget
 * AVANT la sélection des messages récents : le résumé ne peut jamais agrandir
 * la fenêtre au-delà du budget demandé. 1 500 tokens ≈ 20 à 60 lignes
 * compressées — au-delà, les lignes les plus anciennes sont sacrifiées en
 * premier (elles sont déjà les moins pertinentes, la fenêtre conserve le
 * contexte récent verbatim).
 */
export const SUMMARY_MAX_TOKENS = 1_500;

/**
 * Heuristique DÉTERMINISTE du nombre de tokens d'un texte.
 *
 * Pourquoi une heuristique et pas un tokenizer réel : la sélection de la
 * fenêtre tourne dans le chemin critique du tour de conversation — tokenizer
 * chaque message avec le vocabulaire exact du modèle coûterait plus cher que
 * ce que la précision apporte. L'objectif est un ORDRE DE GRANDEUR fiable :
 *  - base : ≈ 4 caractères par token (moyenne constatée pour du texte
 *    européen, FR inclus) ;
 *  - majoration par ponctuation : chaque signe de ponctuation compte pour ½
 *    token (souvent token séparé côté BPE, parfois collé au mot adjacent).
 *
 * Majorer légèrement vaut mieux que sous-estimer : un contexte surestimé
 * évacue un message de plus (sans coût fonctionnel), un contexte sous-estimé
 * fait rejeter la requête par le fournisseur.
 */
const PONCTUATION_RE = /[.,;:!?()[\]{}«»"“”‘’'—–…/\-\n\r\t]/g;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const base = Math.ceil(text.length / 4);
  const ponctuation = (text.match(PONCTUATION_RE) ?? []).length;
  return base + Math.ceil(ponctuation / 2);
}

/**
 * Compresse UN message évacué en une ligne déterministe.
 *
 * Contrat (Task 131) :
 *  - rôle du message (utilisateur / assistant) ;
 *  - les 240 PREMIERS caractères du contenu — les payloads d'outils
 *    volumineux sont tronqués EN PRIORITÉ : ce sont les plus coûteux et les
 *    moins denses en information utile au modèle ;
 *  - noms des outils appelés : lus des CITATIONS du message (champ `source`
 *    = identifiant de l'outil, document ou connecteur — la seule trace
 *    déterministe inline d'un appel d'outil) ;
 *  - marqueur de résultat : `succès` / `échec` depuis le `generationStatus`
 *    (un assistant dont la génération a échoué ne doit pas être résumé comme
 *    une réponse valide).
 *
 * Exporté pour être testé unitairement sans la moindre E/S.
 */
export function compressMessage(message: ChatMessage): string {
  const role = message.role === "user" ? "utilisateur" : "assistant";
  const content = message.content.slice(0, COMPACT_CONTENT_CHARS);
  const tronque = message.content.length > COMPACT_CONTENT_CHARS ? "…" : "";
  const parts = [`[${role}] ${content}${tronque}`];
  if (message.role === "assistant") {
    const outils = [...new Set((message.citations ?? []).map((citation) => citation.source).filter(Boolean))];
    if (outils.length > 0) parts.push(`outils : ${outils.join(", ")}`);
    parts.push(`résultat : ${message.generationStatus === "failed" ? "échec" : "succès"}`);
  }
  return parts.join(" — ");
}

/**
 * Construit le résumé déterministe des messages évacués, borné à
 * `budgetTokens`. Si les lignes compressées dépassent le plafond, les lignes
 * les plus ANCIENNES sont sacrifiées en premier (la fenêtre conserve déjà le
 * contexte récent verbatim ; l'ancre d'intention, elle, est traitée par la
 * sélection de la fenêtre) et le décompte des lignes omises est annoncé.
 */
function buildSummaryPrefix(evacuated: ChatMessage[], budgetTokens: number): string | undefined {
  if (evacuated.length === 0 || budgetTokens <= 0) return undefined;
  const header = `Historique antérieur compacté (${evacuated.length} messages évacués de la fenêtre de contexte) :`;
  const lines = evacuated.map((message) => compressMessage(message));
  if (estimateTokens(`${header}\n${lines.join("\n")}`) <= budgetTokens) {
    return `${header}\n${lines.join("\n")}`;
  }
  // Troncature : remplir depuis la fin (lignes les plus récentes) puis
  // réordonner chronologiquement — jamais de ligne coupée en deux.
  const kept: string[] = [];
  let used = estimateTokens(header);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateTokens(lines[i]!);
    if (used + cost > budgetTokens) break;
    kept.unshift(lines[i]!);
    used += cost;
  }
  const omis = lines.length - kept.length;
  if (kept.length === 0) return undefined;
  return [
    header,
    `(${omis} messages antérieurs non résumés — payload trop volumineux pour le budget)`,
    ...kept,
  ].join("\n");
}

export interface ContextWindowOptions {
  /** Prompt système intégral — son coût est réservé en premier, jamais tronqué. */
  systemPrompt: string;
  /** Historique chronologique (le plus ancien en premier). */
  history: ChatMessage[];
  /** Budget total en tokens (prompt système + résumé + messages conservés). */
  budgetTokens: number;
}

export interface ContextWindowResult {
  /**
   * Messages conservés, ordre chronologique STRICT (sous-séquence de
   * l'historique d'entrée). Le prompt système n'y figure pas : il est géré
   * par l'appelant et son coût est compté dans `usedTokens`.
   */
  messages: ChatMessage[];
  /** Nombre de messages évacués de la fenêtre (résumés dans `summaryPrefix`). */
  droppedCount: number;
  /** Résumé déterministe des messages évacués (absent si rien n'est évacué). */
  summaryPrefix?: string;
  /** Estimation totale consommée : système + messages conservés + résumé. */
  usedTokens: number;
}

/**
 * Construit la fenêtre de contexte sous budget.
 *
 * Garanties contractuelles :
 *  1. le prompt système est TOUJOURS compté et n'est JAMAIS évacué ni tronqué
 *     (il ne fait pas partie de `messages` — l'appelant l'ajoute lui-même,
 *     intact) ;
 *  2. le DERNIER message est TOUJOURS conservé, même si le budget est trop
 *     petit (jamais de contexte vide : la conversation doit pouvoir se
 *     poursuivre ; dans ce cas `usedTokens` dépasse `budgetTokens`, c'est le
 *     seul cas de dépassement autorisé) ;
 *  3. l'ordre chronologique des messages conservés est strictement préservé ;
 *  4. le premier message utilisateur est conservé SI POSSIBLE (ancre de
 *     l'intention d'origine) ;
 *  5. déterminisme total : même entrée → même sortie, octet pour octet.
 */
export function buildContextWindow(options: ContextWindowOptions): ContextWindowResult {
  const { systemPrompt, history, budgetTokens } = options;
  const systemTokens = estimateTokens(systemPrompt);

  if (history.length === 0) {
    return { messages: [], droppedCount: 0, usedTokens: systemTokens };
  }

  // Budget réellement disponible pour le contenu conversationnel.
  const available = budgetTokens - systemTokens;
  const costs = history.map((message) => estimateTokens(message.content));
  const totalCost = costs.reduce((somme, cout) => somme + cout, 0);

  // Cas nominal : tout l'historique tient — aucune compression nécessaire.
  if (totalCost <= available) {
    return { messages: [...history], droppedCount: 0, usedTokens: systemTokens + totalCost };
  }

  // Suffixe la plus large qui tient dans `limite` : le DERNIER message est
  // TOUJOURS conservé (contrat 2 — jamais de contexte vide), puis on remonte
  // tant que le budget des messages tient.
  const suffixeDans = (limite: number): { start: number; used: number } => {
    let used = costs[costs.length - 1]!;
    let start = history.length - 1;
    while (start > 0 && used + costs[start - 1]! <= limite) {
      start -= 1;
      used += costs[start]!;
    }
    return { start, used };
  };

  // Coût ESTIMÉ du résumé des `start` premiers messages évacués (borné au
  // plafond) : la réserve suit le VOLUME RÉEL à résumer, pas un forfait —
  // une conversation dont seuls quelques messages dépassent garde ainsi plus
  // de contexte récent verbatim.
  const reserveResume = (start: number): number => {
    if (start <= 0) return 0;
    const lignes = history.slice(0, start).map((message) => compressMessage(message));
    return Math.min(SUMMARY_MAX_TOKENS, estimateTokens(lignes.join("\n")));
  };

  // Réserve et sélection se répondent (plus d'évacués → plus gros résumé →
  // moins de place) : itération courte, convergente (start croissant, réserve
  // croissante bornée par le plafond), 2-3 tours en pratique.
  let selection = suffixeDans(available);
  let reserve = reserveResume(selection.start);
  for (let garde = 0; garde < 8; garde++) {
    const relue = suffixeDans(available - reserve);
    const nouvelleReserve = reserveResume(relue.start);
    if (relue.start === selection.start && nouvelleReserve === reserve) break;
    selection = relue;
    reserve = nouvelleReserve;
  }

  // Ancre d'intention : le PREMIER message utilisateur est ajouté en tête de
  // la fenêtre si son coût rentre dans le budget des messages (contrat 4).
  const firstUserIndex = history.findIndex((message) => message.role === "user");
  let anchored = false;
  if (
    firstUserIndex !== -1 &&
    firstUserIndex < selection.start &&
    selection.used + costs[firstUserIndex]! <= available - reserve
  ) {
    selection = { ...selection, used: selection.used + costs[firstUserIndex]! };
    anchored = true;
  }

  const kept = anchored
    ? [history[firstUserIndex]!, ...history.slice(selection.start)]
    : history.slice(selection.start);

  // Messages évacués = tout ce qui précède la fenêtre, hors ancre conservée.
  const evacuated: ChatMessage[] = [];
  for (let i = 0; i < selection.start; i++) {
    if (anchored && i === firstUserIndex) continue;
    evacuated.push(history[i]!);
  }
  // Le résumé exploite la place restante SANS jamais dépasser le plafond :
  // usedTokens ≤ budgetTokens reste garanti (hors cas dégénéré du contrat 2).
  const summaryBudget = Math.min(SUMMARY_MAX_TOKENS, Math.max(0, available - selection.used));
  const summaryPrefix = buildSummaryPrefix(evacuated, summaryBudget);

  return {
    messages: kept,
    droppedCount: history.length - kept.length,
    ...(summaryPrefix ? { summaryPrefix } : {}),
    usedTokens: systemTokens + selection.used + estimateTokens(summaryPrefix ?? ""),
  };
}
