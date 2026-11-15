/**
 * Types du Monde — le contrat entre la physique, l'IA et l'interface.
 *
 * Toute simulation, quel que soit son domaine, renvoie le même
 * `ResultatSimulation` : des séries temporelles (courbes), des champs 2D
 * (cartes de chaleur), des scalaires (grandeurs clés) et des
 * diagnostics honnêtes (erreurs, conservations, stabilité). L'interface
 * n'a donc qu'UN seul format à dessiner, et l'IA un seul format à
 * expliquer en langage naturel.
 */

/** Un domaine de la nature pris en charge par le Monde. */
export type DomaineMonde =
  | "mecanique"
  | "ondulaire"
  | "quantique"
  | "thermique"
  | "electromagnetique"
  | "relativiste"
  | "fluidique"
  | "equations";

/** Courbe temporelle ou paramétrique traçable. */
export interface Serie {
  /** Nom lisible (légende). */
  nom: string;
  /** Abscisses (souvent le temps, en s). */
  abscisses: number[];
  /** Ordonnées. */
  valeurs: number[];
  /** Unité SI des ordonnées. */
  unite: string;
  /** Couleur suggérée (hex) pour la légende. */
  couleur: string;
}

/** Champ scalaire 2D (carte de chaleur). */
export interface Champ2D {
  largeur: number;
  hauteur: number;
  /** Valeurs rangées ligne par ligne (j * largeur + i). */
  valeurs: Float64Array;
  unite: string;
  /** Nom lisible du champ. */
  nom: string;
}

/** Grandeur numérique clé du résultat. */
export interface Scalaire {
  nom: string;
  valeur: number;
  unite: string;
  /** Explication courte affichée en survol. */
  note: string;
}

/** Diagnostic de qualité numérique — l'honnêteté du Monde. */
export interface Diagnostic {
  nom: string;
  valeur: string;
  /** true si le diagnostic est rassurant (vert), false sinon (orange). */
  sain: boolean;
}

/** Résultat universel de toute simulation du Monde. */
export interface ResultatSimulation {
  /** Domaine physique qui a résolu. */
  domaine: DomaineMonde;
  /** Modèle précis utilisé (ex. « projectile avec traînée quadratique »). */
  modele: string;
  /** Titre court affiché. */
  titre: string;
  /** Explication en langage naturel de CE QUE le Monde a calculé. */
  explication: string;
  /** Les équations résolues (affichées en TeX-like texte). */
  equations: string[];
  series: Serie[];
  champ: Champ2D | null;
  scalaires: Scalaire[];
  diagnostics: Diagnostic[];
  avertissements: string[];
  /** Durée du calcul côté machine (ms). */
  dureeMs: number;
}

/** Cap stricts du Monde — jamais un calcul illimité, ni client ni serveur. */
export const CAPS_MONDE = {
  /** Taille de grille maximale par dimension (128² = 16 384 cellules). */
  grilleMax: 128,
  /** Pas d'intégration max par simulation. */
  pasMax: 200_000,
  /** Échantillons max d'une série renvoyée. */
  echantillonsMax: 2048,
  /** Particules max d'un problème à N corps. */
  corpsMax: 24,
  /** Échantillons Monte-Carlo max. */
  monteCarloMax: 1_000_000,
} as const;

/** Vérifie qu'une valeur numérique est exploitable (finie). */
export function fin(v: number, nom: string): number {
  if (!Number.isFinite(v)) {
    throw new Error(`Paramètre « ${nom} » non fini : ${v}.`);
  }
  return v;
}

/** Contraint une valeur dans un intervalle borné. */
export function borner(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
