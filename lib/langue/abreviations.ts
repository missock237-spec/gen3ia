/**
 * ABRÉVIATIONS FR/EN — détection et développement pour gen3 (périmètre
 * « langue »). Complète le dictionnaire (abreviations-dictionnaire.ts) avec
 * le moteur : détection par jetons (bornes de mots, casse-insensible,
 * ponctuation collée, positions exactes), développement contextuel, et
 * garde-fous (URLs, e-mails, code inline, unités collées à un chiffre).
 *
 * Garanties :
 *   - O(1) par jeton (Map), passage unique sur le texte → 10 Ko traités
 *     en largement moins de 50 ms ;
 *   - une abréviation AMBIGUË n'est développée QUE si son contexte
 *     (fenêtre ±`fenetreContexte` mots, défaut 8) valide une lecture ;
 *     sinon elle reste INTACTE (aucune invention) ;
 *   - JAMAIS d'expansion dans les URLs, e-mails, domaines/fichiers
 *     (`projet.js`) ni le code inline (`…`) ;
 *   - JAMAIS d'expansion d'une unité (registre "unite") — ni de tout
 *     jeton très court (≤ 2 caractères) — collée à un chiffre
 *     (« 5 km », « 500 mg », « 20 °C » restent intacts).
 */

import {
  DICTIONNAIRE_ABREVIATIONS,
  type EntreeAbreviation,
  type RegistreAbreviation,
  type SensAbreviation,
} from "./abreviations-dictionnaire";

export { DICTIONNAIRE_ABREVIATIONS };
export type { EntreeAbreviation, RegistreAbreviation, SensAbreviation };

/** Occurrence d'une abréviation repérée dans un texte. */
export interface OccurrenceAbreviation {
  /** Clé du dictionnaire (minuscules). */
  abreviation: string;
  /** Jeton tel qu'écrit dans le texte (casse et ponctuation d'origine). */
  texteBrut: string;
  /** Position du début de l'occurrence dans le texte. */
  index: number;
  /** Position juste après l'occurrence. */
  fin: number;
  /** Expansion résolue ; null si ambiguë sans contexte ou zone protégée. */
  expansion: string | null;
  /** Lecture plurielle (développement exigeant du contexte). */
  ambigu: boolean;
  registre: RegistreAbreviation;
  /** Dans une URL/e-mail/code inline ou collée à un chiffre. */
  protege: boolean;
}

export interface OptionsDeveloppement {
  /** Garde l'abréviation d'origine entre parenthèses : « salut (slt) ». */
  conserverOriginale?: boolean;
  /** Demi-fenêtre de contexte pour désambiguïser (défaut 8 mots). */
  fenetreContexte?: number;
}

const CARTE_ABREVIATIONS = new Map<string, EntreeAbreviation>(
  Object.entries(DICTIONNAIRE_ABREVIATIONS),
);

/**
 * Jeton = mot (lettres accentuées, chiffres) pouvant contenir des
 * apostrophes/traits d'union internes (« aujourd'hui », « c'était ») et un
 * suffixe « + » (« c++ », « a+ »). La ponctuation collée (« slt, », « stp? »)
 * reste à l'extérieur du jeton.
 */
const MOTIF_JETON =
  /[a-zA-ZÀ-ÖØ-ÞŒÆà-öø-ÿœæ0-9]+(?:['’\-+][a-zA-ZÀ-ÖØ-ÞŒÆà-öø-ÿœæ0-9]+)*['’+]*/g;

const MOTIF_URL = /(?:https?:\/\/|www\.)\S+/gi;
const MOTIF_EMAIL = /[a-z0-9._%+'’-]+@[a-z0-9à-öø-ÿ.-]+\.[a-zà-öø-ÿ]{2,}/gi;
const MOTIF_DOMAINE =
  /[a-z0-9à-öø-ÿœæ][a-z0-9à-öø-ÿœæ.-]*\.(?:com|fr|net|org|io|dev|app|co|ai|eu|gov|edu|info|xyz|me|tv|gg|sh|ch|be|de|es|it|nl|pt|ca|uk|jp|go|ts|js|json|css|html|sql|xml|db|csv|png|pdf|svg|gif|mp3|mp4|zip)\b(?:\/\S*)?/gi;
const MOTIF_CODE_INLINE = /`[^`\n]*`/g;

/** Élision en tête de jeton (« l'ia », « d'acc »…) : conservée à l'affichage.
 * Limitée à l' / d' / qu' : les autres élisions (j', n', s', c', m', t')
 * produiraient des corps verbaux (« j'ai » → « ai ») source de faux positifs. */
const MOTIF_ELISION = /^(?:l|d|qu)['’]/;
/** Nombre autonome (voisin d'unité) : « 5 », « 3,5 », « 500 ». */
const MOTIF_NOMBRE = /^\d+(?:[.,]\d+)?$/;

const FENETRE_DEFAUT = 8;

interface Jeton {
  brut: string;
  /** Clé de recherche : minuscules, sans élision de tête. */
  cle: string;
  /** Élision de tête conservée telle qu'écrite ("" si aucune). */
  prefixe: string;
  index: number;
}

interface ZoneProtegee {
  debut: number;
  fin: number;
}

function decouperJetons(texte: string): Jeton[] {
  const jetons: Jeton[] = [];
  for (const match of texte.matchAll(MOTIF_JETON)) {
    const brut = match[0];
    if (brut === undefined || brut.length === 0) {
      continue;
    }
    const cle = brut.toLowerCase();
    const elision = MOTIF_ELISION.exec(cle);
    if (elision !== null && elision[0] !== undefined) {
      const corps = cle.slice(elision[0].length);
      if (corps.length > 0) {
        jetons.push({ brut, cle: corps, prefixe: brut.slice(0, elision[0].length), index: match.index ?? 0 });
        continue;
      }
    }
    jetons.push({ brut, cle, prefixe: "", index: match.index ?? 0 });
  }
  return jetons;
}

function zonesProtegees(texte: string): ZoneProtegee[] {
  const zones: ZoneProtegee[] = [];
  for (const motif of [MOTIF_URL, MOTIF_EMAIL, MOTIF_DOMAINE, MOTIF_CODE_INLINE]) {
    for (const match of texte.matchAll(motif)) {
      const debut = match.index ?? 0;
      zones.push({ debut, fin: debut + match[0].length });
    }
  }
  return zones;
}

function dansZoneProtegee(zones: ZoneProtegee[], jeton: Jeton): boolean {
  return zones.some((zone) => jeton.index >= zone.debut && jeton.index < zone.fin);
}

/** Unité (ou jeton très court) collée à un chiffre : « 5 km », « 20 °C ». */
function voisinNumerique(jetons: Jeton[], position: number, entree: EntreeAbreviation): boolean {
  const jeton = jetons[position];
  if (jeton === undefined) {
    return false;
  }
  if (entree.registre !== "unite" && jeton.cle.length > 2) {
    return false;
  }
  const precedent = position > 0 ? jetons[position - 1] : undefined;
  const suivant = jetons[position + 1];
  return (
    (precedent !== undefined && MOTIF_NOMBRE.test(precedent.cle)) ||
    (suivant !== undefined && MOTIF_NOMBRE.test(suivant.cle))
  );
}

/** Le mot-clé court (≤ 2) exige une égalité exacte, sinon une simple inclusion. */
function motCleCorrespond(cle: string, motCle: string): boolean {
  return motCle.length <= 2 ? cle === motCle : cle.includes(motCle);
}

function resoudreExpansion(
  entree: EntreeAbreviation,
  jetons: Jeton[],
  position: number,
  fenetre: number,
): string | null {
  if (entree.ambigu === true && entree.senses !== undefined && entree.senses.length > 0) {
    const debut = Math.max(0, position - fenetre);
    const contexte = [
      ...jetons.slice(debut, position),
      ...jetons.slice(position + 1, position + 1 + fenetre),
    ];
    for (const sens of entree.senses) {
      if (sens.contexteMotsCles.some((motCle) => contexte.some((jeton) => motCleCorrespond(jeton.cle, motCle.toLowerCase())))) {
        return sens.expansion;
      }
    }
    return null;
  }
  return entree.expansion;
}

function entrerDuDictionnaire(jeton: Jeton): EntreeAbreviation | undefined {
  return CARTE_ABREVIATIONS.get(jeton.cle);
}

/**
 * Repère toutes les abréviations du dictionnaire présentes dans `texte`
 * (casse-insensible, ponctuation collée tolérée, positions exactes).
 * L'`expansion` est null pour les lectures ambiguës sans contexte valide
 * et pour les zones protégées (URLs, e-mails, code inline, unités chiffrées).
 */
export function detecterAbreviations(texte: string): OccurrenceAbreviation[] {
  const jetons = decouperJetons(texte);
  const zones = zonesProtegees(texte);
  const occurrences: OccurrenceAbreviation[] = [];
  for (let position = 0; position < jetons.length; position += 1) {
    const jeton = jetons[position];
    if (jeton === undefined) {
      continue;
    }
    const entree = entrerDuDictionnaire(jeton);
    if (entree === undefined) {
      continue;
    }
    const protege = dansZoneProtegee(zones, jeton) || voisinNumerique(jetons, position, entree);
    const expansion = protege ? null : resoudreExpansion(entree, jetons, position, FENETRE_DEFAUT);
    occurrences.push({
      abreviation: jeton.cle,
      texteBrut: jeton.brut,
      index: jeton.index,
      fin: jeton.index + jeton.brut.length,
      expansion,
      ambigu: entree.ambigu === true,
      registre: entree.registre,
      protege,
    });
  }
  return occurrences;
}

/**
 * Développe les abréviations claires d'un texte ; les ambiguës ne sont
 * développées que si le contexte (fenêtre ±`fenetreContexte` mots) tranche,
 * sinon elles restent intactes. Ne touche jamais aux URLs, e-mails, domaines,
 * code inline ni aux unités collées à un chiffre.
 */
export function developperAbreviations(texte: string, options: OptionsDeveloppement = {}): string {
  const fenetre = options.fenetreContexte ?? FENETRE_DEFAUT;
  const jetons = decouperJetons(texte);
  const zones = zonesProtegees(texte);
  let resultat = "";
  let curseur = 0;
  for (let position = 0; position < jetons.length; position += 1) {
    const jeton = jetons[position];
    if (jeton === undefined) {
      continue;
    }
    const entree = entrerDuDictionnaire(jeton);
    if (entree === undefined) {
      continue;
    }
    if (dansZoneProtegee(zones, jeton) || voisinNumerique(jetons, position, entree)) {
      continue;
    }
    const expansion = resoudreExpansion(entree, jetons, position, fenetre);
    if (expansion === null) {
      continue;
    }
    const remplacement = options.conserverOriginale === true
      ? `${jeton.prefixe}${expansion} (${jeton.brut})`
      : `${jeton.prefixe}${expansion}`;
    resultat += `${texte.slice(curseur, jeton.index)}${remplacement}`;
    curseur = jeton.index + jeton.brut.length;
  }
  resultat += texte.slice(curseur);
  return resultat;
}

/**
 * Indique si le message contient au moins une abréviation réellement
 * développable (hors zones protégées et ambiguïtés non tranchées).
 */
export function estMessageAbrege(texte: string): boolean {
  return detecterAbreviations(texte).some((occurrence) => occurrence.expansion !== null);
}
