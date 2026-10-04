/**
 * QUALITÉ DES RÉPONSES IA (Task 52 — exigence utilisateur : « les réponses des
 * agents IA et de la conversation soient claires et précises selon le sujet
 * saisi, comparables aux résultats de ChatGPT à chaque requête »).
 *
 * Deux leviers, appliqués UNIQUEMENT aux chemins de réponse VISIBLES
 * (conversation universelle, chat d'agent, réponses de mission, synthèses) :
 *
 *  1. ROUTAGE QUALITÉ — `preferFreeForVisibleAnswers()` : en mode « premium »
 *     (défaut), les réponses visibles ne subissent PAS la préférence « modèles
 *     gratuits » : le routeur sélectionne le MEILLEUR fournisseur configuré
 *     (openai 100 > anthropic 98 > glm 95 > groq 90 > agnes 85 > openrouter 80),
 *     avec les mêmes replis automatiques qu'avant. En mode « free », le
 *     comportement historique est conservé (coût minimal). Les tâches
 *     INTERNES (classification, planification JSON, mémoire, résumés
 *     d'échanges) conservent `preferFree: true` quel que soit le mode.
 *
 *  2. CONTRAT DE PRÉSENTATION — `RESPONSE_FORMAT_RULES` : un ensemble de
 *     règles système injecté dans chaque réponse visible : langue de
 *     l'utilisateur, réponse directe dès la première ligne, structure
 *     markdown (alignée sur le renderer Gen3ia : titres, listes, gras,
 *     tableaux), précision selon le sujet saisi, honnêteté absolue
 *     (zéro invention), clarification unique si la demande est ambiguë.
 *
 * Le module est PUR et SANS DÉPENDANCE : testable, importable depuis le
 * client (constantes) comme depuis le serveur (décision de routage).
 */

export type ResponseQualityMode = "premium" | "free";

/**
 * Contrat de présentation injecté dans les réponses visibles. Rédigé pour le
 * renderer markdown Gen3ia (components/workspace/markdown.tsx) : titres #/##,
 * gras, listes, tableaux `| col | col |` — tout ce qui est demandé ici est
 * réellement rendu côté client, jamais de syntaxe décorative non supportée.
 */
export const RESPONSE_FORMAT_RULES = [
  "FORMAT DE RÉPONSE (obligatoire, appliqué à CHAQUE réponse) :",
  "- Réponds dans la LANGUE de l'utilisateur (message en français → réponse en français).",
  "- Commence DIRECTEMENT par la réponse ou la conclusion : jamais de préambule creux (« Bien sûr ! », « En tant qu'IA… »), jamais de reformulation inutile de la question.",
  "- Adapte la réponse au sujet DEMANDÉ : traite le point précis posé, sans digression, sans remplissage, sans répéter la question.",
  "- Structure en markdown dès que la réponse dépasse deux phrases : paragraphes courts, titres (##) pour les volets distincts, listes à puces ou numérotées pour les étapes, **gras** sur les points essentiels.",
  "- Utilise un tableau markdown (| colonne | colonne |) uniquement pour comparer des éléments ou présenter des données tabulaires — jamais pour du texte narratif.",
  "- Sois PRÉCIS et QUANTIFIÉ quand le sujet s'y prête : chiffres exacts, unités, dates, noms propres corrects ; pas de « environ » quand la valeur exacte est connue.",
  "- HONNÊTETÉ ABSOLUE : n'invente JAMAIS un fait, un chiffre, une statistique, une citation, une source ou une URL. Si tu ne sais pas ou si l'information peut avoir changé, dis-le clairement et propose de vérifier.",
  "- Si la demande reste réellement ambiguë après analyse du contexte de la conversation, pose UNE question de clarification ciblée au lieu de deviner.",
  "- Termine utilement : prochaine étape concrète, recommandation ou proposition d'approfondir — jamais une formule de politesse seule.",
].join("\n");

/**
 * System prompt de qualité COMPLET, utilisé par les surfaces conversationnelles
 * qui n'ont pas encore de system prompt (chat générique historique).
 */
export const RESPONSE_QUALITY_SYSTEM = [
  "Tu es l'assistant IA de Gen3ia. À CHAQUE requête, quelle que soit sa longueur, tu produis une réponse d'exigence professionnelle : claire, précise et adaptée au sujet saisi — la même qualité qu'un assistant de premier plan.",
  RESPONSE_FORMAT_RULES,
].join("\n\n");

/**
 * Compose un system prompt existant avec le contrat de présentation.
 *  - `existing` présent → règles ajoutées APRÈS (les instructions métier
 *    restent en tête, le format s'y ajoute sans les écraser) ;
 *  - `existing` absent/ blanc → system de qualité complet.
 */
export function withResponseStyle(existing?: string | null): string {
  const base = existing?.trim();
  return base ? `${base}\n\n${RESPONSE_FORMAT_RULES}` : RESPONSE_QUALITY_SYSTEM;
}

/**
 * Mode de qualité effectif : `GEN3IA_RESPONSE_QUALITY` (env serveur).
 *  - « premium » (défaut, y compris valeur absente ou INVALIDE — repli sûr) :
 *    les réponses visibles sont routées vers le meilleur fournisseur configuré ;
 *  - « free » : comportement historique préférence modèles gratuits.
 * Lecture À L'APPEL (pas au chargement du module) : un changement d'env sur
 * Vercel s'applique sans redéploiement du module.
 */
export function responseQualityMode(): ResponseQualityMode {
  const raw = process.env.GEN3IA_RESPONSE_QUALITY?.trim().toLowerCase();
  return raw === "free" ? "free" : "premium";
}

/**
 * Décision de routage pour une réponse VISIBLE : false en premium (le
 * routeur choisit le meilleur fournisseur configuré), true uniquement en
 * mode free. Les chemins internes continuent de passer `preferFree: true`
 * explicitement — ce module ne les touche pas.
 */
export function preferFreeForVisibleAnswers(): boolean {
  return responseQualityMode() === "free";
}

/**
 * Décision de routage pour une tâche de COMPRÉHENSION interne qui
 * conditionne directement la qualité de la réponse finale (classification
 * d'une requête utilisateur, planification d'un plan d'agent, décision
 * d'intention conversationnelle) : en mode « premium » (défaut), ces tâches
 * ne subissent PLUS la préférence « modèles gratuits » — le routeur
 * sélectionne le meilleur fournisseur configuré, car un classificateur ou un
 * planificateur médiocre dégrade mécaniquement la réponse visible. En mode
 * « free » explicite, le comportement gratuit historique est conservé.
 * (Miroir de `preferFreeForVisibleAnswers` : preferFree === true
 * uniquement lorsque le mode n'est PAS explicitement premium.)
 */
export function preferFreeForUnderstanding(): boolean {
  return responseQualityMode() !== "premium";
}
