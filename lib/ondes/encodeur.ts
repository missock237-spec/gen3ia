/**
 * Encodeur fréquentiel — convertit le texte en impulsions d'ondes.
 *
 * Chaque mot reçoit une signature [position, fréquence propre, phase]
 * DÉTERMINISTE (hash FNV-1a double sel) : le même mot excite toujours la
 * même région du champ avec la même fréquence — c'est ce qui rend la
 * carte inverse possible (un pic de résonance stabilisé à une position
 * re-devient un mot via `carteInverse`). La position est quantifiée sur
 * la grille courante ; la signature est recalculable pour toute
 * dimension de grille.
 */

import type { Impulsion } from "./types";

/** Hash FNV-1a 32 bits (stable, rapide, sans dépendance). */
export function fnv1a(chaine: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    // Multiplication 32 bits sans Math.imul pour rester exact : FNV prime.
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Tokenisation du texte en mots (unicode, apostrophes et traits
 * d'union conservés) : « l'IA nouvelle-génération » → 3 jetons.
 */
export function tokenizeTexte(texte: string): string[] {
  const brut = texte.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? [];
  return brut.map((mot) => mot.toLocaleLowerCase("fr")).filter((mot) => mot.length > 0);
}

export interface SignatureOnde {
  /** Position quantifiée dans une grille `dim`×`dim`. */
  x: number;
  y: number;
  /** Fréquence propre (rad/pas), bornée à la bande audible du champ. */
  frequence: number;
  /** Phase initiale (rad). */
  phase: number;
}

const BANDE_FREQ_MIN = 0.03;
const BANDE_FREQ_MAX = 0.17;
const DEUX_PI = Math.PI * 2;

/**
 * Signature d'onde d'un mot pour une grille `dim`×`dim` : deux hashes
 * indépendants (sel distinct) décident de la position, la fréquence est
 * répartie sur la bande utile, la phase sur le cercle complet.
 */
export function signatureMot(mot: string, dim: number): SignatureOnde {
  const h1 = fnv1a(mot);
  const h2 = fnv1a(`ondes·${mot}`);
  const h3 = fnv1a(`phase·${mot}`);
  // Jitter déterministe léger pour éviter que deux mots voisins de hash
  // tombent exactement sur la même cellule et s'annulent.
  const jitterX = ((h3 >>> 8) % 5) - 2;
  const jitterY = ((h3 >>> 16) % 5) - 2;
  const x = Math.min(dim - 1, Math.max(0, (h1 % dim) + jitterX));
  const y = Math.min(dim - 1, Math.max(0, (h2 % dim) + jitterY));
  const frequence =
    BANDE_FREQ_MIN + (((h3 >>> 0) % 1000) / 1000) * (BANDE_FREQ_MAX - BANDE_FREQ_MIN);
  const phase = ((h2 >>> 4) % 1000) / 1000 * DEUX_PI;
  return { x, y, frequence, phase };
}

/** Amplitude d'injection d'un mot (proportionnelle à sa longueur, bornée). */
export function amplitudeMot(mot: string): number {
  return Math.min(6, 2.4 + mot.length * 0.35);
}

/**
 * Encode un texte complet en impulsions d'ondes. Chaque mot unique
 * génère UNE impulsion (les répétitions renforcent l'amplitude au lieu
 * de multiplier les paquets). Ordre stable = propagation reproductible.
 */
export function encoderTexte(texte: string, dim: number, maxImpulsions = 64): Impulsion[] {
  const mots = tokenizeTexte(texte);
  const uniques: string[] = [];
  const force = new Map<string, number>();
  for (const mot of mots) {
    if (!force.has(mot)) uniques.push(mot);
    force.set(mot, (force.get(mot) ?? 0) + 1);
  }
  const retenus = uniques.slice(0, maxImpulsions);
  return retenus.map((mot) => {
    const sig = signatureMot(mot, dim);
    const repetitions = force.get(mot) ?? 1;
    return {
      x: sig.x,
      y: sig.y,
      amplitude: amplitudeMot(mot) * Math.min(2, 1 + (repetitions - 1) * 0.25),
      frequence: sig.frequence,
      phase: sig.phase,
      rayon: 2.5,
    } satisfies Impulsion;
  });
}

/**
 * Carte inverse (position → mot) : alimentée par chaque mot injecté,
 * elle permet au décodeur de reconvertir un pic de résonance stabilisé
 * en mot. Un mot peut être réenregistré pour une autre dimension de
 * grille sans conflit (les clés incluent la dimension).
 */
export class CarteInverse {
  private readonly positions = new Map<string, { mot: string; x: number; y: number }>();

  /** Enregistre la position d'un mot pour la grille courante. */
  enregistrer(mot: string, dim: number): void {
    const sig = signatureMot(mot, dim);
    this.positions.set(`${sig.x}:${sig.y}`, { mot, x: sig.x, y: sig.y });
  }

  /** Nombre de mots enregistrés (vocabulaire actif du champ). */
  get taille(): number {
    return this.positions.size;
  }

  /**
   * Retrouve le mot le plus proche d'un pic, ou null si aucun mot
   * n'habite le voisinage (rayon en cellules, proportionnel à la grille).
   */
  motLePlusProche(x: number, y: number, dim: number, rayonCellules?: number): string | null {
    const rayon = rayonCellules ?? Math.max(3, Math.round(dim * 0.035));
    let meilleur: string | null = null;
    let distanceMin = rayon * rayon + 1;
    for (const entree of this.positions.values()) {
      const dx = entree.x - x;
      const dy = entree.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < distanceMin) {
        distanceMin = d2;
        meilleur = entree.mot;
      }
    }
    return meilleur;
  }

  /** Vider la carte (nouvelle session de champ). */
  reinitialiser(): void {
    this.positions.clear();
  }
}
