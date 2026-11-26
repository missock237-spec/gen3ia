/**
 * TEMPORAL ANALYZER — mémoire temporelle visuelle (mission Phase 3-C) :
 * comparaison des frames successives retenues, zones de modification par
 * grille 3×3, direction grossière du changement (barycentre des zones
 * modifiées), conservation du contexte visuel pour le cerveau. Aucun
 * « suivi d'objets » fabriqué : seul le changement MESURÉ est déclaré.
 */

import type { FrameAnalysable } from "./frame-selector";

export interface ZoneModifiee {
  /** Grille 3×3 : ligne et colonne du changement dominant (0..2). */
  ligne: number;
  colonne: number;
  /** Proportion de pixels changés dans cette zone [0..1]. */
  intensite: number;
}

export interface AnalyseTemporelle {
  /** Nombre de frames retenues dans la mémoire (contexte conservé). */
  framesConservees: number;
  /** Zones 3×3 modifiées entre les deux dernières frames retenues. */
  zones: ZoneModifiee[];
  /** Direction grossière du barycentre de changement (ou "immobile"). */
  direction: "haut" | "bas" | "gauche" | "droite" | "immobile" | "dispersé";
  /**
   * Signature de déplacement mesurée : un objet qui SE DÉPLACE laisse deux
   * zones extrêmes symétriques (disparition + apparition) — le barycentre
   * s'annule alors : déclarer « horizontal/vertical » est honnête, inventer
   * « droite » ne le serait pas.
   */
  deplacement: "horizontal" | "vertical" | "aucun";
  /** Amplitude globale du changement [0..1]. */
  amplitude: number;
  /** Contexte : résumé honnête pour le cerveau. */
  contexte: string;
}

export function analyserTemporalite(frames: readonly FrameAnalysable[]): AnalyseTemporelle {
  if (frames.length < 2) {
    return {
      framesConservees: frames.length,
      zones: [],
      direction: "immobile",
      deplacement: "aucun",
      amplitude: 0,
      contexte: frames.length === 1 ? "une seule frame retenue : aucun point de comparaison temporelle" : "aucune frame : contexte vide",
    };
  }
  const a = frames[frames.length - 2];
  const b = frames[frames.length - 1];
  const zones: ZoneModifiee[] = [];
  const intensites = new Array(9).fill(0);
  const n = Math.min(a.grille.length, b.grille.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(b.grille[i] - a.grille[i]);
    if (d > 18) {
      const x = i % a.largeur;
      const y = Math.floor(i / a.largeur);
      const colonne = Math.min(2, Math.floor((x / a.largeur) * 3));
      const ligne = Math.min(2, Math.floor((y / a.hauteur) * 3));
      intensites[ligne * 3 + colonne] += d;
    }
  }
  const max = Math.max(...intensites, 1);
  for (let z = 0; z < 9; z++) {
    if (intensites[z] > max * 0.3) {
      zones.push({ ligne: Math.floor(z / 3), colonne: z % 3, intensite: intensites[z] / max });
    }
  }

  let sx = 0;
  let sy = 0;
  let poids = 0;
  for (const z of zones) {
    sx += (z.colonne - 1) * z.intensite;
    sy += (z.ligne - 1) * z.intensite;
    poids += z.intensite;
  }
  const amplitude = b.proportionChangee;
  let direction: AnalyseTemporelle["direction"] = "immobile";
  if (zones.length >= 5) direction = "dispersé";
  else if (poids > 0.2) {
    if (Math.abs(sx) > Math.abs(sy)) direction = sx > 0 ? "droite" : "gauche";
    else direction = sy > 0 ? "bas" : "haut";
  }

  // Déplacement mesuré : deux zones dominantes (>0,5) symétriques sur la
  // même ligne (cols 0 et 2) ou même colonne (lignes 0 et 2), intensités
  // proches (±25 %) — signature réelle d'un objet qui se déplace.
  let deplacement: AnalyseTemporelle["deplacement"] = "aucun";
  const fortes = zones.filter((z) => z.intensite > 0.5);
  const symHor = fortes.some((a2) => fortes.some((b2) => a2 !== b2 && a2.ligne === b2.ligne && a2.colonne === 0 && b2.colonne === 2 && Math.abs(a2.intensite - b2.intensite) <= 0.25));
  const symVer = fortes.some((a2) => fortes.some((b2) => a2 !== b2 && a2.colonne === b2.colonne && a2.ligne === 0 && b2.ligne === 2 && Math.abs(a2.intensite - b2.intensite) <= 0.25));
  if (symHor) deplacement = "horizontal";
  else if (symVer) deplacement = "vertical";

  const contexte = zones.length
    ? `changement ${direction} (amplitude ${(amplitude * 100).toFixed(1)} % des pixels), zones modifiées : ${zones.map((z) => `[l${z.ligne}c${z.colonne}]`).join(", ")} — ${frames.length} frames de contexte`
    : `écran stable sur les dernières frames (amplitude ${(amplitude * 100).toFixed(1)} %) — ${frames.length} frames de contexte`;

  return { framesConservees: frames.length, zones, direction, deplacement, amplitude, contexte };
}
