/**
 * ANCRAGE (GROUNDING) — RÉDUCTION DES HALLUCINATIONS (Task 42, axe 7).
 *
 * Trois briques complémentaires, toutes non bloquantes (le rapport
 * n'empêche jamais l'affichage — il éclaire l'utilisateur et les surfaces
 * qui veulent afficher un avertissement) :
 *
 *   1. `buildGroundedContext` : met les sources de la base de connaissances
 *      en forme NUMÉROTÉE avec consigne de citation stricte — injecté dans
 *      le prompt avant génération.
 *   2. `extractCitations` : extrait les références [n] réellement citées
 *      dans la réponse.
 *   3. `groundingReport` : compare les phrases de la réponse aux citations
 *      présentes ; les phrases à teneur factuelle SANS aucune référence
 *      sont listées (heuristique déterministe : chiffres, dates, marqueurs
 *      d'autorité). Aucun LLM, aucun coût, aucun inventage.
 */

export interface GroundingSource {
  /** Titre ou identifiant lisible de la source (document, section…). */
  title: string;
  /** Contenu textuel de l'extrait pertinent. */
  content: string;
  /** Métadonnée libre (chemin, URL interne, page…). */
  location?: string;
}

const CONTEXT_HEADER = [
  "SOURCES FOURNIES (base de connaissances) — RÈGLES D'ANCRAGE OBLIGATOIRES :",
  "- Appuie CHAQUE fait spécifique sur une source et cite-la avec son numéro entre crochets, ex. [2].",
  "- Si les sources ne suffisent pas à répondre : dis-le explicitement et n'invente RIEN.",
  "- Ne cite jamais une source que tu n'as pas réellement utilisée.",
].join("\n");

/** Contexte numéroté prêt à injecter (undefined si aucune source). */
export function buildGroundedContext(sources: GroundingSource[]): string | undefined {
  const usable = sources.filter((source) => source.content.trim());
  if (usable.length === 0) return undefined;
  const blocks = usable.slice(0, 8).map((source, index) => {
    const content = source.content.replace(/\s+/g, " ").trim().slice(0, 1_200);
    const location = source.location ? ` (${source.location.slice(0, 120)})` : "";
    return `[${index + 1}] ${source.title.slice(0, 160)}${location}\n${content}`;
  });
  return `${CONTEXT_HEADER}\n\n${blocks.join("\n\n")}`;
}

/** Numéros de sources réellement cités dans la réponse ([n] 1-based). */
export function extractCitations(answer: string): number[] {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= 99) cited.add(n);
  }
  return [...cited].sort((a, b) => a - b);
}

export interface GroundingReport {
  /** Numéros de sources citées. */
  cited: number[];
  /** Phrases factuelles sans aucune citation (à relativiser/warn). */
  unsupportedClaims: string[];
  /** Part des phrases factuelles qui portent une citation (0-1). */
  factCoverage: number;
  /** true si la réponse cite au moins une source hors plage fournie. */
  suspiciousCitations: boolean;
}

const FACTUAL_MARKERS: RegExp =
  /(\b\d{1,4}([.,]\d+)?\s?(%|€|\$|k|m|ans?|jours?|heures?|mois)?\b)|(\b(19|20)\d{2}\b)|(\b(selon|d'après|source|étude|rapport|enquête|statistique|données)\b)/i;

const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ0-9«"])/;

function splitSentences(answer: string): string[] {
  return answer
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Phrases contenant une citation [n] ? */
function hasCitation(sentence: string): boolean {
  return /\[\d{1,2}\]/.test(sentence);
}

/**
 * Rapport d'ancrage : les phrases factuelles (marqueurs déterministes)
 * sans citation sont signalées. Les phrases conversationnelles (« Bonjour,
 * voici votre réponse ») ne sont PAS considérées factuelles.
 */
export function groundingReport(answer: string, providedSources: number): GroundingReport {
  const cited = extractCitations(answer);
  const sentences = splitSentences(answer);

  const factual = sentences.filter((sentence) => FACTUAL_MARKERS.test(sentence));
  const unsupportedClaims = factual.filter((sentence) => !hasCitation(sentence)).slice(0, 5);
  const factCoverage = factual.length === 0 ? 1 : Math.round(((factual.length - unsupportedClaims.length) / factual.length) * 100) / 100;

  const suspiciousCitations = cited.some((n) => n > providedSources);

  return { cited, unsupportedClaims, factCoverage, suspiciousCitations };
}

/** Avertissement prêt à afficher (undefined si le rapport est sain). */
export function groundingWarning(report: GroundingReport): string | undefined {
  const warnings: string[] = [];
  if (report.suspiciousCitations) {
    warnings.push("certaines références citées n'existent pas dans les sources fournies");
  }
  if (report.unsupportedClaims.length > 0) {
    warnings.push(`${report.unsupportedClaims.length} affirmation(s) factuelle(s) sans source citée`);
  }
  if (warnings.length === 0) return undefined;
  return `Fiabilité : ${warnings.join(", ")}. Vérifiez les points concernés avant de vous en servir.`;
}
