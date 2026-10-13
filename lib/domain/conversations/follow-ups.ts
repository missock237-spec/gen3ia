/**
 * Task 141 — suggestions de suivi cliquables après une réponse.
 *
 * Fonction PURE et DÉTERMINISTE (zéro appel LLM, zéro latence, zéro coût) :
 * analyse la teneur du message utilisateur et de la réponse de l'assistant
 * pour proposer 3 suites d'action pertinentes, affichées en chips sous la
 * dernière réponse du fil. Un clic insère la suggestion dans le composer —
 * l'utilisateur garde la main, la suggestion n'est JAMAIS envoyée seule.
 *
 * Choix de conception : heuristique locale plutôt que LLM —
 *  - la réponse est déjà produite : rajouter un appel modèle doublerait le
 *    coût et la latence de chaque tour pour un confort discutable ;
 *  - le déterminisme rend le comportement testable unitairement (verrous
 *    structurels du projet) et prévisible pour l'utilisateur.
 */

/** Nombre maximal de suggestions affichées sous une réponse. */
export const MAX_FOLLOW_UPS = 3;

/** Longueur maximale d'une suggestion (lisibilité des chips). */
const MAX_SUGGESTION_LENGTH = 120;

/**
 * Détecte la famille de contenu dominante de la réponse afin de choisir
 * des suites cohérentes (tableau → graphique, code → explication…).
 */
function detectResponseShape(content: string): {
  hasTable: boolean;
  hasCode: boolean;
  hasSteps: boolean;
  hasSources: boolean;
} {
  return {
    hasTable: /\n\s*\|.*\|\s*\n\s*\|[\s:|-]+\|\s*\n/.test(content) || content.includes("|---"),
    hasCode: /```/.test(content) || /(?<!\w)\b(const|let|function|def|class|import)\b\s+\w/.test(content),
    hasSteps: /(^|\n)\s*(\d+[.)]|[-*•])\s+/.test(content),
    hasSources: /\b(sources?|références?|source)\b\s*:/i.test(content),
  };
}

/** Courtes suites génériques contextuelles au message d'origine. */
function messageTailored(message: string): string[] {
  const lower = message.toLowerCase();
  const out: string[] = [];
  if (/\b(rapport|compte rendu|synthèse|synthese|bilan)\b/.test(lower)) {
    out.push("Transforme-le en document PDF prêt à partager");
  }
  if (/\b(mail|e-mail|email|lettre|message)\b/.test(lower)) {
    out.push("Rédige le mail de suivi prêt à envoyer");
  }
  if (/\b(vente|chiffre|réseau|reseaux?|croissance|kpi|indicateur)\b/.test(lower)) {
    out.push("Compare avec la période précédente");
  }
  if (/\b(résume|resume|synthétise|synthetise)\b/.test(lower)) {
    out.push("Développe le point le plus important");
  }
  if (/\b(traduis|traduction)\b/.test(lower)) {
    out.push("Traduis-le aussi en anglais");
  }
  if (/\b(idée|idee|brainstorm|propose|suggère|suggere)\b/.test(lower)) {
    out.push("Classe ces idées par impact et facilité");
  }
  return out;
}

/** Suites cohérentes avec la FORME de la réponse produite. */
function shapeTailored(shape: ReturnType<typeof detectResponseShape>): string[] {
  const out: string[] = [];
  if (shape.hasTable) out.push("Convertis ce tableau en graphique");
  if (shape.hasCode) out.push("Explique ce code pas à pas");
  if (shape.hasSteps) out.push("Détaille la première étape avec un exemple");
  if (shape.hasSources) out.push("Croise avec une recherche web plus récente");
  return out;
}

/** Suites par défaut — toujours utiles, jamais redondantes entre elles. */
const GENERIC_FOLLOW_UPS = [
  "Résume en 3 points essentiels",
  "Approfondis le point le plus important",
  "Transforme cette réponse en document",
  "Pose-moi la question qui te manque pour aller plus loin",
  "Propose une version plus courte",
];

/**
 * Construit jusqu'à {@link MAX_FOLLOW_UPS} suggestions de suivi à partir du
 * message utilisateur et de la réponse de l'assistant. Ordre de priorité :
 * suites taillées au message d'origine → suites cohérentes avec la forme de
 * la réponse → suites génériques. Aucun doublon, aucune suggestion vide.
 */
export function buildFollowUpSuggestions(message: string, responseContent: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const clean = raw.trim().slice(0, MAX_SUGGESTION_LENGTH).trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < MAX_FOLLOW_UPS) out.push(clean);
  };

  const shape = detectResponseShape(responseContent ?? "");
  for (const suggestion of shapeTailored(shape)) push(suggestion);
  for (const suggestion of messageTailored(message ?? "")) push(suggestion);
  for (const suggestion of GENERIC_FOLLOW_UPS) {
    if (out.length >= MAX_FOLLOW_UPS) break;
    push(suggestion);
  }
  return out;
}
