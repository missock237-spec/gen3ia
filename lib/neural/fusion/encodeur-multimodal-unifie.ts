/**
 * ENCODEUR MULTIMODAL UNIFIÉ (méthode d'amélioration 2 de l'analyse experte).
 *
 * Toutes les modalités (texte, image, audio) sont projetées dans UN SEUL
 * espace latent d'ondes : un concept canonique (« pomme » vue, lue ou
 * entendue) produit la MÊME signature d'ondes — même position dans la
 * grille, même fréquence propre, même phase — quel que soit le canal
 * d'entrée. Seul le gain de modalité module l'amplitude, puis les gains
 * sont normalisés (énergie totale identique par modalité).
 *
 * Le hachage canonique utilise les CONSTANTES du SNN réel du cerveau
 * (FNV-1a, lib/neural/encoding/text-encoder.ts) : la fusion est cohérente
 * avec l'encodage d'énergie existant — pas un espace parallèle.
 *
 * Module PUR — aucune dépendance Node, testable unitairement.
 */

import type { Impulsion } from "@/lib/ondes/types";

/** Constantes FNV-1a du SNN réel (text-encoder.ts) — cohérence du cerveau. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export type Modalite = "texte" | "image" | "audio";

/** Gains de modalité — normalisés ensuite (énergie totale identique). */
const GAINS_MODALITE: Record<Modalite, number> = { texte: 1.0, image: 0.9, audio: 0.85 };

export const FREQUENCE_MIN = 0.02;
export const FREQUENCE_MAX = 0.2;

/** Canonicalisation : casse, accents, séparateurs — le concept, pas la forme. */
export function canonicaliserConcept(concept: string): string {
  return concept
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** FNV-1a 32 bits — mêmes constantes que le SNN du cerveau. */
export function hacherConcept(canonical: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Position dans la grille d'ondes — déterministe depuis le hachage. */
export function positionDepuisHachage(hash: number, largeur: number, hauteur: number): { x: number; y: number } {
  const x = hash % largeur;
  const y = Math.floor(hash / largeur) % hauteur;
  return { x, y };
}

/** Fréquence propre bornée aux BORNES_PHYSIQUES du champ. */
export function frequenceDepuisHachage(hash: number): number {
  const u = (hash >>> 8) / 0x1000000; // [0, 1)
  return FREQUENCE_MIN + u * (FREQUENCE_MAX - FREQUENCE_MIN);
}

/** Phase initiale — déterministe. */
export function phaseDepuisHachage(hash: number): number {
  return ((hash >>> 16) / 0x10000) * Math.PI * 2;
}

/** Entrée multimodale : concepts canoniques par canal. */
export interface EntreeMultimodale {
  modalite: Modalite;
  /** Concepts extraits du canal (tokens texte, labels image, événements audio). */
  concepts: string[];
}

/** Signature d'ondes d'un concept : la MÊME quelle que soit la modalité. */
export interface SignatureConcept {
  concept: string;
  hash: number;
  impulsions: Impulsion[];
}

/** Projette UN concept (toute modalité) dans l'espace latent d'ondes partagé. */
export function projeterConcept(concept: string, largeur: number, hauteur: number): SignatureConcept {
  const canonical = canonicaliserConcept(concept);
  if (!canonical) return { concept, hash: 0, impulsions: [] };
  const hash = hacherConcept(canonical);
  const { x, y } = positionDepuisHachage(hash, largeur, hauteur);
  return {
    concept: canonical,
    hash,
    impulsions: [
      {
        x,
        y,
        amplitude: 1.0,
        frequence: frequenceDepuisHachage(hash),
        phase: phaseDepuisHachage(hash),
        rayon: 1.5,
      },
    ],
  };
}

/**
 * Projette une entrée multimodale COMPLÈTE : mêmes impulsions de concepts +
 * gain de modalité NORMALISÉ (l'énergie totale injectée est identique
 * quelle que soit la modalité — comparabilité des résonances).
 */
export function encoderEntreeMultimodale(entree: EntreeMultimodale, largeur: number, hauteur: number): Impulsion[] {
  const conceptsUniques = [...new Set(entree.concepts.map(canonicaliserConcept).filter(Boolean))];
  if (conceptsUniques.length === 0) return [];
  const gain = GAINS_MODALITE[entree.modalite];
  // Normalisation : l'énergie totale injectée est la même pour toute modalité.
  const amplitude = gain / Math.sqrt(conceptsUniques.length);
  const impulsions: Impulsion[] = [];
  for (const concept of conceptsUniques) {
    const signature = projeterConcept(concept, largeur, hauteur);
    for (const impulsion of signature.impulsions) {
      impulsions.push({ ...impulsion, amplitude });
    }
  }
  return impulsions;
}

/** Empreinte d'un paquet d'ondes (journalisation sans donnée sensible). */
export function empreinteImpulsions(impulsions: Impulsion[]): string {
  return impulsions.map((i) => `${i.x},${i.y},${i.frequence.toFixed(4)}`).join("|");
}
