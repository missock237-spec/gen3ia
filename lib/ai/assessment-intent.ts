/**
 * DÉTECTION DE DEMANDE D'ÉVALUATION — routage déterministe (zéro variance
 * LLM) vers l'Assessment Engine (système n°15 de la feuille de route
 * propriétaire : « Générer des tests, évaluations et questionnaires »).
 *
 * Miroir de `lib/ai/video-intent.ts` (looksLikeVideoRequest) et
 * `lib/ai/image-intent.ts` : verbe de création + nom d'évaluation.
 * Garde-fous :
 *  - les questions méta (« c'est quoi un bon quiz ? », « comment créer un
 *    questionnaire ? ») ne déclenchent PAS de génération ;
 *  - les demandes de PAGES/SITES web restent routées vers l'artefact
 *    application (un « quiz en ligne » est une page, pas un document) —
 *    détectées par le même contexte web que video-intent ;
 *  - les évaluations D'AUTRES CHOSES (performance, risque…) sans nom
 *    d'évaluation ne déclenchent PAS ;
 *  - FR + EN, frontières \p{L}/\p{N} (les accents français ne sont PAS
 *    des caractères de mot ASCII — même piège que video-intent).
 */

/** Garde-fou gauche : le caractère précédent n'est PAS une lettre/chiffre. */
const U_START = "(?<![\\p{L}\\p{N}_])";
/** Garde-fou droit : le caractère suivant n'est PAS une lettre/chiffre. */
const U_END = "(?![\\p{L}\\p{N}_])";

const ASSESSMENT_NOUN_RE = new RegExp(
  `${U_START}(?:quiz|quizzes|questionnaire[s]?|[ée]valuations?|examen[s]?|interro(?:gation)?s?|interro[ée]critoires?|test[s]? de connaissances|QCM|multiple[- ]choice|assessment[s]?|exercise[s]?|exercices?)[s]?${U_END}`,
  "iu",
);

const ASSESSMENT_CREATION_VERB_RE = new RegExp(
  `${U_START}(?:cr[ée]\\p{L}*|g[éèe]n[éèe]r\\p{L}*|fais\\p{L}*|fait\\p{L}*|fabriqu\\p{L}*|produi\\p{L}*|concev\\p{L}*|pr[ée]par\\p{L}*|r[ée]dige\\p{L}*|compos\\p{L}*|lanc[ée]\\p{L}*|lance[rz]?|veux|voudrais|aimerais|make|create|generate|produce|design|write|build|want)${U_END}`,
  "iu",
);

/** Amorce interrogative : une pure question méta ne produit rien. */
const QUESTION_PREFIX_RE = new RegExp(
  `^(?:c[''’]est quoi|qu[''’]est[- ]ce|pourquoi|comment|qui (?:est|a)|o[ùu]|quand|quel(?:le)?s?(?:\\s+\\p{L}+){0,4}|est[- ]ce que|what|why|how|who|where|which)${U_END}`,
  "iu",
);

/** Demandes de pages/web/app : routage artefact application, PAS document. */
const WEB_APP_CONTEXT_RE = new RegExp(
  `${U_START}(?:page web|site (?:web|internet|vitrine)|landing page|application web|app web|web app|dashboard|en ligne|interactif|interactive|html)${U_END}`,
  "iu",
);

/** Sujets NON pédagogiques : « test de performance », « évaluation des risques »… */
const NON_ACADEMIC_RE = new RegExp(
  `${U_START}(?:performance|risques?|p[ée]n[ée]tration|charge|s[ée]curit[ée]|unitaire|unitaires|d'intrusion|de vuln[ée]rabilit[ée]|technique|techniques|psychotechnique|de recrutement)${U_END}`,
  "iu",
);

export interface AssessmentIntent {
  /** Demande brute (pour l'extraction du sujet/corpus). */
  demande: string;
}

/** La demande est-elle une génération d'évaluation documentaire ? */
export function looksLikeAssessmentRequest(message: string): boolean {
  const t = message.trim();
  if (t.length < 6) return false;
  if (QUESTION_PREFIX_RE.test(t)) return false;
  if (WEB_APP_CONTEXT_RE.test(t)) return false;
  if (NON_ACADEMIC_RE.test(t)) return false;
  return ASSESSMENT_NOUN_RE.test(t) && ASSESSMENT_CREATION_VERB_RE.test(t);
}

/** Nombre de questions demandé (déterministe, défaut 5, borné 1-30). */
export function extractAssessmentCount(message: string): number {
  const t = message.toLowerCase();
  const NB = "0123456789";
  const chiffres = (mot: string): number | null => {
    const n = Number.parseInt(mot.replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const mExplicit = t.match(/(\d+)\s*(?:questions?|items?|q\.)/);
  if (mExplicit) {
    const n = chiffres(mExplicit[1]);
    if (n) return Math.max(1, Math.min(30, n));
  }
  // Nombres en toutes lettres (un…vingt) — les plus utiles seulement.
  const LETTRES: Record<string, number> = {
    un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7,
    huit: 8, neuf: 9, dix: 10, quinze: 15, vingt: 20,
  };
  const mLettres = t.match(new RegExp(`${U_START}(\\p{L}+)${U_END}\\s*(?:questions?|items?)`, "iu"));
  if (mLettres) {
    const n = LETTRES[mLettres[1].toLowerCase()];
    if (n) return Math.max(1, Math.min(30, n));
  }
  void NB;
  return 5;
}

/** Format demandé : « qcm » (défaut), « réponse courte », « mixte ». */
export type AssessmentFormat = "qcm" | "court" | "mixte";

export function extractAssessmentFormat(message: string): AssessmentFormat {
  const t = message.toLowerCase();
  if (/r[ée]ponse[s]?\s+courte|open[- ]ended|questions? ouvertes?/.test(t)) return "court";
  if (/mixte|mixte qcm|qcm et (?:r[ée]ponses? courtes|ouvertes?)/.test(t)) return "mixte";
  return "qcm";
}

/** Le message fournit-il un CONTENU à évaluer (cours, notes, texte) ? */
export function aUnCorpusFourni(message: string): boolean {
  return message.trim().length >= 400;
}
