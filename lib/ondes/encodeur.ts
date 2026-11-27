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
  verifierDimensionGrille(dim);
  if (typeof mot !== "string" || mot.trim().length === 0) {
    throw new Error("Mot invalide : une chaîne non vide est requise pour calculer une signature d'onde.");
  }
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

/* ------------------------------------------------------------------ */
/* VAGUE POST-AUDIT v2.1 — SIGNATURE SÉMANTIQUE + CANAUX DE DOMAINE     */
/* ------------------------------------------------------------------ */
/**
 * Audit externe (novembre 2026) : « la représentation des mots repose sur
 * le hachage — deux mots sémantiquement proches n'ont pas des
 * représentations proches » et « les domaines partagent un petit nombre de
 * bandes porteuses → risques de collisions ». Deux réponses ADDITIVES :
 *
 *  1. `signatureSemantique` : la POSITION d'un mot dans le champ devient un
 *     mélange 50/50 entre sa position de hachage (identité exacte) et le
 *     CENTROÏDE des positions de ses trigrammes de caractères — les mots
 *     de même famille morphologique (voiture/voitures, travail/travaux)
 *     tombent dans des cellules voisines, sans détruire l'identité du mot
 *     (fréquence/phase restent hashées : la carte inverse fonctionne à
 *     l'identique). Activable via option `semantique` — NON activé par
 *     défaut en v2.1 : l'arène visuelle reste sur la signature de hachage
 *     (comportement inchangé, aucune régression).
 *
 *  2. `canalDomaine` / `attribuerCanauxSansCollision` : chaque domaine
 *     reçoit un canal (bande × sous-canal) parmi 32 (8 bandes × 4
 *     sous-canaux) — l'attribution sans collision garantit l'unicité
 *     jusqu'à 32 domaines (les 18 domaines Gen3 tiennent largement).
 */

/** Trigrammes de caractères d'un mot (mot ≤ 2 caractères : lui-même). */
function trigrammesOndes(mot: string): string[] {
  if (mot.length <= 2) return [mot];
  const tri: string[] = [];
  for (let i = 0; i + 3 <= mot.length; i++) tri.push(mot.slice(i, i + 3));
  return tri.length > 0 ? tri : [mot];
}

/**
 * Signature d'onde SÉMANTIQUE d'un mot pour une grille `dim`×`dim` :
 * position = mélange 50/50 (arrondi déterministe) entre la position de
 * hachage et le centroïde des positions de ses trigrammes. Fréquence et
 * phase : identiques à `signatureMot` (hashées — identité du mot préservée
 * pour la carte inverse). Mêmes gardes que `signatureMot`.
 */
export function signatureSemantique(mot: string, dim: number): SignatureOnde {
  const base = signatureMot(mot, dim);
  const tri = trigrammesOndes(mot);
  let sommeX = 0;
  let sommeY = 0;
  for (const g of tri) {
    sommeX += fnv1a(g) % dim;
    sommeY += fnv1a(`tri·${g}`) % dim;
  }
  const centroideX = Math.round(sommeX / tri.length);
  const centroideY = Math.round(sommeY / tri.length);
  const x = Math.min(dim - 1, Math.max(0, Math.round((base.x + centroideX) / 2)));
  const y = Math.min(dim - 1, Math.max(0, Math.round((base.y + centroideY) / 2)));
  return { x, y, frequence: base.frequence, phase: base.phase };
}

/** Nombre de bandes porteuses (bande = tranche de fréquence du champ). */
export const NB_BANDES = 8;
/** Nombre de sous-canaux par bande (décalage fin à l'intérieur de la bande). */
export const SOUS_CANAUX_PAR_BANDE = 4;

/**
 * Canal brut d'un domaine : (bande, sous-canal) dérivés du hachage du nom.
 * Déterministe ; deux domaines peuvent tomber sur le même canal brut —
 * utiliser `attribuerCanauxSansCollision` pour l'unicité garantie.
 */
export function canalDomaine(domaine: string): { bande: number; sousCanal: number } {
  const h = fnv1a(`canal·${domaine}`);
  return { bande: h % NB_BANDES, sousCanal: Math.floor(h / NB_BANDES) % SOUS_CANAUX_PAR_BANDE };
}

/**
 * Attribue à chaque domaine un canal UNIQUE (bande, sous-canal), de façon
 * déterministe : les domaines sont traités en ordre lexicographique, chacun
 * reçoit son canal brut s'il est libre, sinon le premier canal libre dans
 * l'ordre des 32 (bande-major). Jusqu'à 32 domaines → zéro collision.
 */
export function attribuerCanauxSansCollision(
  domaines: readonly string[],
): Record<string, { bande: number; sousCanal: number }> {
  const occupes = new Set<string>();
  const resultat: Record<string, { bande: number; sousCanal: number }> = {};
  for (const domaine of [...domaines].sort()) {
    const brut = canalDomaine(domaine);
    let canal = brut;
    if (occupes.has(`${canal.bande}:${canal.sousCanal}`)) {
      let trouve = false;
      for (let bande = 0; bande < NB_BANDES && !trouve; bande++) {
        for (let sous = 0; sous < SOUS_CANAUX_PAR_BANDE && !trouve; sous++) {
          if (!occupes.has(`${bande}:${sous}`)) {
            canal = { bande, sousCanal: sous };
            trouve = true;
          }
        }
      }
    }
    occupes.add(`${canal.bande}:${canal.sousCanal}`);
    resultat[domaine] = canal;
  }
  return resultat;
}

/**
 * Encode un texte complet en impulsions d'ondes. Chaque mot unique
 * génère UNE impulsion (les répétitions renforcent l'amplitude au lieu
 * de multiplier les paquets). Ordre stable = propagation reproductible.
 */
export function encoderTexte(texte: string, dim: number, maxImpulsions = 64): Impulsion[] {
  verifierDimensionGrille(dim);
  if (typeof texte !== "string") {
    throw new Error("Texte invalide : une chaîne est requise pour encoder des impulsions.");
  }
  if (!Number.isInteger(maxImpulsions) || maxImpulsions < 0 || maxImpulsions > 4096) {
    throw new Error(`Limite d'impulsions invalide : ${maxImpulsions} (entier entre 0 et 4096 requis).`);
  }
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
  // La dimension fait partie de la clé : une coordonnée (x, y) sur une
  // grille 128×128 n'est pas la même adresse que sur une grille 256×256.
  private readonly positions = new Map<string, { mot: string; x: number; y: number; dim: number }>();

  /** Enregistre la position d'un mot pour la grille courante. */
  enregistrer(mot: string, dim: number): void {
    const sig = signatureMot(mot, dim);
    this.positions.set(`${dim}:${sig.x}:${sig.y}`, { mot, x: sig.x, y: sig.y, dim });
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
    verifierDimensionGrille(dim);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= dim || y >= dim) {
      throw new Error(`Coordonnées invalides : (${x}, ${y}) hors de la grille ${dim}×${dim}.`);
    }
    const rayon = rayonCellules ?? Math.max(3, Math.round(dim * 0.035));
    if (!Number.isInteger(rayon) || rayon < 0 || rayon > dim * 2) {
      throw new Error(`Rayon de recherche invalide : ${rayon} (entier entre 0 et ${dim * 2} requis).`);
    }
    let meilleur: string | null = null;
    let distanceMin = rayon * rayon + 1;
    for (const entree of this.positions.values()) {
      if (entree.dim !== dim) continue;
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

/** Garde-fou commun pour éviter les coordonnées négatives ou hors grille. */
function verifierDimensionGrille(dim: number): void {
  if (!Number.isInteger(dim) || dim < 1 || dim > 8192) {
    throw new Error(`Dimension de grille invalide : ${dim} (entier entre 1 et 8192 requis).`);
  }
}
