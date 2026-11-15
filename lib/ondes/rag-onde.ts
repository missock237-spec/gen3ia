/**
 * RAG LOCAL À RÉSONANCE D'ONDES (Wave-Grounded Knowledge).
 *
 * Les IA hallucinent quand elles essaient d'inventer des faits qu'elles
 * ne possèdent pas dans leur mémoire. Ici, la résonance physique sert de
 * GARDE-FOU ONTOLOGIQUE :
 *
 *  · chaque fragment de document est converti en une empreinte d'ondes
 *    (Wave Index : vecteur signé → impulsions → champ) ;
 *  · quand l'utilisateur pose une question, l'onde du prompt PERCUTE
 *    l'onde de chaque fragment dans l'arène d'interférence ;
 *  · résonance constructive (les ondes s'amplifient) → la réponse est
 *    construite à partir de la PHRASE EXACTE du document — jamais
 *    reformulée par l'IA ;
 *  · absence de résonance (pas de signal) → la réponse est FORCÉE à
 *    « Information non présente dans les données ». L'API ne renvoie
 *    RIEN d'autre : inventer une histoire est structurellement
 *    impossible — il n'existe aucun chemin de code qui produise du
 *    texte non ancré.
 *
 * L'index vit chez l'utilisateur (navigateur / parc local) : le Wave
 * Index est une projection à sens unique, jamais un export du document.
 * Confidentialité absolue : les ondes de la question ne quittent jamais
 * la machine — l'arène est locale.
 */

import { AreneInterference, type MesuresInterference } from "./arene";
import { texteVersVecteur, cosinus } from "./codec";

/** Réponse forcée en l'absence de résonance — LA phrase honnête. */
export const REPONSE_ABSENCE = "Information non présente dans les données.";

/** Composantes du vecteur d'empreinte (même dimension que l'arène). */
const COMPOSANTES = 1024;

/** Entrée du Wave Index : un fragment de document et son onde. */
export interface EntreeIndexOndes {
  /** Fragment de texte EXACT (la citation possible). */
  texte: string;
  /** Document source (nom affichable). */
  source: string;
  /** Position du fragment dans le document. */
  index: number;
  /** Vecteur d'empreinte (sac de mots dense signé). */
  vecteur: Float64Array;
  /** Empreinte courte (traçabilité, non réversible). */
  empreinteOnde: string;
}

/** Wave Index complet d'un corpus local. */
export interface IndexOndes {
  nom: string;
  entrees: EntreeIndexOndes[];
  creeLe: number;
}

/* ------------------------------------------------------------------ */
/* Indexation                                                          */
/* ------------------------------------------------------------------ */

/** Découpe un texte en fragments par phrases (bornes min/max). */
export function extrairePhrases(texte: string, minCar = 40, maxCar = 400): string[] {
  const brut = texte
    .replace(/\r/g, "")
    .split(/(?<=[.!?;:])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const fragments: string[] = [];
  let courant = "";
  for (const phrase of brut) {
    if ((courant + " " + phrase).trim().length > maxCar) {
      if (courant.trim().length >= minCar) fragments.push(courant.trim());
      courant = phrase;
      // Phrase géante isolée : tranchée durement (le fragment reste une
      // citation exacte — on garde le début de phrase, jamais inventé).
      if (courant.length > maxCar) {
        fragments.push(courant.slice(0, maxCar).trim());
        courant = "";
      }
    } else {
      courant = (courant + " " + phrase).trim();
    }
  }
  if (courant.trim().length >= minCar || fragments.length === 0) {
    fragments.push(courant.trim());
  }
  return fragments.filter((f) => f.length > 0);
}

/** Empreinte courte d'un vecteur d'onde (traçabilité, non réversible). */
function empreinteOnde(v: Float64Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    const bits = Math.round(v[i] * 1e3) | 0;
    h ^= bits & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (bits >>> 8) & 0x0f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Indexe UN document en fragments-onde. */
export function indexerDocument(nom: string, texte: string): EntreeIndexOndes[] {
  return extrairePhrases(texte).map((fragment, index) => {
    const vecteur = texteVersVecteur(fragment, COMPOSANTES);
    return { texte: fragment, source: nom, index, vecteur, empreinteOnde: empreinteOnde(vecteur) };
  });
}

/** Construit le Wave Index complet d'un corpus local. */
export function construireIndexOndes(nom: string, documents: Array<{ nom: string; texte: string }>): IndexOndes {
  return {
    nom,
    entrees: documents.flatMap((d) => indexerDocument(d.nom, d.texte)),
    creeLe: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Recherche par résonance                                             */
/* ------------------------------------------------------------------ */

export interface OptionsRechercheResonance {
  /** Reward physique minimal (résonance constructive) — défaut arène. */
  seuilResonance?: number;
  /** Corrélation brute minimale (anti-bruit) — défaut arène. */
  seuilCorrelation?: number;
  /** Nombre de candidats retenus par le préfiltre vectoriel. */
  candidats?: number;
  /** Arène injectable (tests). */
  arene?: AreneInterference;
}

export interface ResultatRechercheResonance {
  /** TRUE si une résonance constructive a été trouvée dans les documents. */
  resonance: boolean;
  /** Citation EXACTE du document (null si pas de résonance). */
  phraseExacte: string | null;
  /** Document source de la citation. */
  source: string | null;
  /** Mesures physiques du duel gagnant (traçabilité). */
  mesures: MesuresInterference | null;
  /** Corrélation du meilleur candidat (même sans résonance — diagnostic). */
  meilleureCorrelation: number;
}

/**
 * Préfiltre vectoriel (cosinus, rapide) puis VALIDATION PHYSIQUE dans
 * l'arène : seul un candidat dont l'onde construit une interférence
 * constructive réelle avec l'onde de la question ouvre le document.
 */
export function rechercherParResonance(
  question: string,
  index: IndexOndes,
  options?: OptionsRechercheResonance,
): ResultatRechercheResonance {
  const arene = options?.arene ?? new AreneInterference();
  const seuilResonance = options?.seuilResonance ?? 0.2;
  const seuilCorrelation = options?.seuilCorrelation ?? 0.35;
  const k = Math.max(1, options?.candidats ?? 6);

  const ondeQuestion = texteVersVecteur(question, COMPOSANTES);
  let normeQuestion = 0;
  for (let i = 0; i < ondeQuestion.length; i++) normeQuestion += ondeQuestion[i] * ondeQuestion[i];

  if (index.entrees.length === 0 || normeQuestion === 0) {
    return { resonance: false, phraseExacte: null, source: null, mesures: null, meilleureCorrelation: 0 };
  }

  // 1) Préfiltre vectoriel : cosinus entre l'onde-question et les ondes-index.
  const scores = index.entrees.map((entree, i) => ({
    i,
    score: Math.abs(cosinus(ondeQuestion, entree.vecteur)),
  }));
  scores.sort((a, b) => b.score - a.score);
  const meilleureCorrelation = scores[0]?.score ?? 0;

  // 2) Validation physique des k meilleurs candidats (l'onde JUGE).
  let gagnant: { entree: EntreeIndexOndes; mesures: MesuresInterference } | null = null;
  for (const { i } of scores.slice(0, k)) {
    const entree = index.entrees[i];
    const mesures = arene.duelTextes(question, entree.texte);
    if (mesures.reward >= seuilResonance && mesures.correlation >= seuilCorrelation) {
      if (!gagnant || mesures.correlation > gagnant.mesures.correlation) {
        gagnant = { entree, mesures };
      }
    }
  }

  if (!gagnant) {
    // PAS DE SIGNAL : l'absence de résonance est un RÉSULTAT. L'IA n'a
    // pas le droit d'inventer — la réponse sera la phrase honnête.
    return { resonance: false, phraseExacte: null, source: null, mesures: null, meilleureCorrelation };
  }

  return {
    resonance: true,
    phraseExacte: gagnant.entree.texte,
    source: gagnant.entree.source,
    mesures: gagnant.mesures,
    meilleureCorrelation,
  };
}

export interface ReponseAncree {
  /** La réponse FINALE — citation exacte ou refus honnête, rien d'autre. */
  reponse: string;
  ancre: ResultatRechercheResonance;
  /** La garde a-t-elle forcé le refus ? */
  absenceForcee: boolean;
}

/**
 * RÉPOND AVEC ANCRAGE : le seul point d'entrée factuel. Le texte renvoyé
 * est soit la citation exacte (résonance), soit le refus honnête — aucune
 * génération libre ne traverse cette fonction.
 */
export function repondreAvecAncrage(question: string, index: IndexOndes, options?: OptionsRechercheResonance): ReponseAncree {
  const ancre = rechercherParResonance(question, index, options);
  if (ancre.resonance && ancre.phraseExacte) {
    const citation = ancre.source ? `[${ancre.source}] ${ancre.phraseExacte}` : ancre.phraseExacte;
    return { reponse: citation, ancre, absenceForcee: false };
  }
  return { reponse: REPONSE_ABSENCE, ancre, absenceForcee: true };
}
