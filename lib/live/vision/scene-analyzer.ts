/**
 * SCENE ANALYZER — perception structurelle RÉELLE sur les pixels décodés
 * (mission GEN3IA LIVE Phase 3-A/B) : au-delà des en-têtes JPEG de
 * vision-decider, mesure des BANDES D'ACTIVITÉ (lignes de texte probables
 * via densité de transitions horizontales), des COLONNES D'INTERFACE
 * (panneau latéral : zone à activité persistante vs zone vide) et de la
 * luminance par tiers. Aucune reconnaissance sémantique fabriquée : chaque
 * mesure est déclarée pour ce qu'elle est — l'OCR réel est indisponible
 * (aucun moteur local dans le dépôt, service IA externe interdit par la
 * règle plateforme) : voir ocr-engine.ts pour l'honnêteté complète.
 */

import type { FrameAnalysable } from "./frame-selector";

export interface BandeActivite {
  /** Indice de bande (0..BANDES-1, du haut vers le bas). */
  indice: number;
  /** Densité de transitions clair/sombre [0..1] — texture type texte. */
  densiteTransitions: number;
  /** Luminance moyenne de la bande [0..255]. */
  luminance: number;
  /** true si la bande ressemble à une ligne de texte (texture + contraste). */
  probableTexte: boolean;
}

export interface SceneStructurelle {
  bandes: BandeActivite[];
  /** Colonnes avec activité (interface à panneau latéral probable). */
  colonneActiveDroite: boolean;
  colonneActiveGauche: boolean;
  /** Luminance par tiers vertical (haut/milieu/bas) — thème clair/sombre. */
  luminanceTiers: { haut: number; milieu: number; bas: number };
  /** Interprétation bornée à partir des mesures, rien d'autre. */
  interpretation: string;
}

const BANDES = 12;
const SEUIL_TEXTE_TRANSITIONS = 0.02;
const SEUIL_TEXTE_CONTRASTE = 12;

export function analyserScene(frame: FrameAnalysable): SceneStructurelle {
  const { grille, largeur } = frame;
  const pasLigne = Math.max(1, Math.floor(grille.length / BANDES / largeur));

  const bandes: BandeActivite[] = [];
  for (let b = 0; b < BANDES; b++) {
    let transitions = 0;
    let somme = 0;
    let total = 0;
    const debut = b * pasLigne * largeur;
    const fin = Math.min(grille.length, debut + pasLigne * largeur);
    for (let i = Math.max(1, debut); i < fin; i++) {
      if (Math.abs(grille[i] - grille[i - 1]) > 40) transitions++;
      somme += grille[i];
      total++;
    }
    const densiteTransitions = total ? transitions / total : 0;
    const luminance = total ? somme / total : 0;
    bandes.push({
      indice: b,
      densiteTransitions,
      luminance,
      probableTexte: densiteTransitions >= SEUIL_TEXTE_TRANSITIONS && Math.min(luminance, 255 - luminance) >= SEUIL_TEXTE_CONTRASTE,
    });
  }

  // Colonnes : tiers gauche/droite vs centre (interface à panneaux).
  const activiteColonne = (debutFrac: number, finFrac: number): number => {
    let t = 0;
    for (let y = 0; y < frame.hauteur; y++) {
      for (let x = Math.floor(debutFrac * largeur); x < Math.floor(finFrac * largeur); x++) {
        const i = y * largeur + x;
        if (i + 1 < grille.length && Math.abs(grille[i] - grille[i + 1]) > 40) t++;
      }
    }
    const total = Math.max(1, Math.floor((finFrac - debutFrac) * largeur) * frame.hauteur);
    return t / total;
  };
  const actG = activiteColonne(0, 0.2);
  const actD = activiteColonne(0.8, 1);
  const actC = activiteColonne(0.4, 0.6);
  // Plancher absolu : sans lui, toute zone non vide sur un centre vide
  // paraîtrait « panneau latéral » (mesuré réel : le centre peut être à 0).
  const plancher = 0.01;

  const luminanceTiers = {
    haut: bandes.slice(0, 4).reduce((s, b) => s + b.luminance, 0) / 4,
    milieu: bandes.slice(4, 8).reduce((s, b) => s + b.luminance, 0) / 4,
    bas: bandes.slice(8).reduce((s, b) => s + b.luminance, 0) / 4,
  };

  const lignesTexte = bandes.filter((b) => b.probableTexte).length;
  const interpretation = [
    `${lignesTexte} bande(s) d'activité type texte sur ${BANDES}`,
    actD > plancher && actD > actC * 1.5 ? "colonne droite active (panneau latéral probable)" : actG > plancher && actG > actC * 1.5 ? "colonne gauche active (panneau latéral probable)" : "contenu central dominant",
    luminanceTiers.milieu < 80 ? "thème sombre" : luminanceTiers.milieu > 160 ? "thème clair" : "thème intermédiaire",
  ].join(" — ");

  return {
    bandes,
    colonneActiveDroite: actD > plancher && actD > actC * 1.5,
    colonneActiveGauche: actG > plancher && actG > actC * 1.5,
    luminanceTiers,
    interpretation,
  };
}

