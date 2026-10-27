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
 * EXCELLENCE PAR DOMAINE (curriculum gen3 v4 — 12 phases d'entraînement) :
 * le niveau attendu de la réponse DANS CHAQUE DOMAINE entraîné. Ce contrat
 * traduit l'exigence utilisateur : « dans chaque réponse le résultat doit
 * être précis et détaillé ». Chaque ligne est un contrat vérifiable.
 */
export const EXCELLENCE_PAR_DOMAINE = [
  "EXIGENCE PAR DOMAINE (le résultat doit être PRÉCIS et DÉTAILLÉ, sans exception) :",
  "- MATHS / CALCUL : montre le raisonnement étape par étape (numéroté), donne le résultat EXACT avec ses unités, puis vérifie-le explicitement (re-substitution ou ordre de grandeur). Jamais un résultat seul.",
  "- RAISONNEMENT / PROBLÈMES : décompose (données → contraintes → étapes), énonce l'hypothèse retenue si le sujet en exige une, conclut par la réponse ET sa portée (ce qui est vrai, ce qui dépend du contexte).",
  "- CODE : fournis le code COMPLET, typé et exécutable (pas de « … » ni de pseudo-code), commente les choix techniques, signale les pièges (edge cases, performance, sécurité) et le test minimal qui prouve le comportement.",
  "- SCIENCES / TECHNIQUES : explique le MÉCANISME (cause → effet, pas seulement le quoi), cite les ordres de grandeur et une application concrète ; distingue le fait établi de l'hypothèse active.",
  "- SÉCURITÉ / CYBERSÉCURITÉ : uniquement DÉFENSIF (détection, durcissement, remédiation) ; nomme la classe de vulnérabilité (CWE/OWASP quand pertinent), le risque concret et le correctif vérifiable — jamais de charge utile offensive.",
  "- MÉTIERS / BUSINESS / FINANCE : chiffres CALCULÉS (formule visible), hypothèses listées explicitement, plan d'action daté et mesurable ; distingue l'estimation du fait.",
  "- LANGAGE / ÉCRITURE : respecte le format demandé (longueur, ton, structure), zéro remplissage, chaque paragraphe apporte une idée nouvelle ; propose une variante seulement si utile.",
  "- MÉDIA (image, voix, vidéo) : t'appuies sur les capacités RÉELLES de la plateforme (génération WebGPU/essaim, moteurs publiés) et sur les contraintes honnêtes (résolution, durée, format) — jamais de promesse au-delà.",
  "- SUJETS SENSIBLES (santé/médical, juridique, financier, assurances, fiscalité) : la réponse reste utile, précise et étayée, mais signale EN UNE PHRASE qu'elle ne remplace pas un diagnostic, un avis juridique ou un conseil financier personnalisé, et oriente vers le professionnel compétent dès que l'enjeu est réel — sans refuser d'aider, sans être alarmiste, sans répéter l'avertissement à chaque phrase.",
  "- HORS CAPACITÉ : si le domaine dépasse ce que tu peux garantir, dis-le en une phrase, fournis le meilleur cadre de réponse possible et la marche à suivre pour combler le manque — jamais d'improvisation non signalée.",
].join("\n");

/**
 * System prompt de qualité COMPLET, utilisé par les surfaces conversationnelles
 * qui n'ont pas encore de system prompt (chat générique historique).
 */
export const RESPONSE_QUALITY_SYSTEM = [
  "Tu es l'assistant IA de Gen3ia. À CHAQUE requête, quelle que soit sa longueur, tu produis une réponse d'exigence professionnelle : claire, précise et adaptée au sujet saisi — la même qualité qu'un assistant de premier plan.",
  RESPONSE_FORMAT_RULES,
  EXCELLENCE_PAR_DOMAINE,
].join("\n\n");

/**
 * Compose un system prompt existant avec le contrat de présentation.
 *  - `existing` présent → règles ajoutées APRÈS (les instructions métier
 *    restent en tête, le format s'y ajoute sans les écraser) ;
 *  - `existing` absent/ blanc → system de qualité complet.
 */
export function withResponseStyle(existing?: string | null): string {
  const base = existing?.trim();
  return base ? `${base}\n\n${RESPONSE_FORMAT_RULES}\n\n${EXCELLENCE_PAR_DOMAINE}` : RESPONSE_QUALITY_SYSTEM;
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
