/**
 * COUCHE D'ONDES NEURONALES (RPIA) — LE PONT entre le moteur
 * d'entraînement par résonance (lib/ondes/entrainement-rpia.ts) et le
 * SYSTÈME NEURONAL GEN3 (network.ts, 100 neurones accumulate-and-fire).
 *
 * Principe : chaque neurone du cerveau reçoit un nœud d'onde associé
 * [amplitude, fréquence, phase, amortissement]. L'entraînement RPIA
 * fait résonner cette couche vers l'onde cible d'une requête (texte,
 * image, son — via le conditionneur). L'état résonnant obtenu est
 * ensuite INJECTÉ dans le cerveau sous forme d'énergies neuronales :
 *
 *   · l'apprentissage par résonance complète la plasticité synaptique
 *     (réseau.step) : elle façonne l'ENTRÉE, la plasticité façonne les
 *     connexions ;
 *   · deux requêtes différentes produisent deux motifs d'énergie
 *     distincts — le cerveau « ressent » la différence avant même de
 *     décoder ;
 *   · les énergies sont bornées [0, 0.5] : l'homéostasie du noyau
 *     central (alerte au-delà de 0.75 de moyenne) n'est jamais
 *     déclenchée par la couche (moyenne typique ≈ 0.2).
 *
 * Module PUR — aucune dépendance Node ; déterministe (graine 42).
 */

import { EntraineurRPIA } from "@/lib/ondes/entrainement-rpia";
import { encoderTexteEnOndeCible } from "@/lib/ondes/conditionneur";
import { RPIA_DEFAUTS } from "@/lib/ondes/types-entrainement";
import type { ConfigRPIA, NoeudOnde, OndeCible, RapportEntrainement } from "@/lib/ondes/types-entrainement";

/** bornes d'injection dans le cerveau (voir en-tête). */
const ENERGIE_MAX = 0.5;
const GAIN_ENERGIE = 0.2;

/** État sérialisable de la couche (persistance du cerveau). */
export interface EtatRPIA {
  taille: number;
  pasTotaux: number;
  poids: number[];
}

/** Options de la couche (transmises à l'entraîneur interne). */
export interface OptionsCoucheRPIA {
  /** Graine déterministe (défaut 42). */
  graine?: number;
}

export class CoucheOndesNeuronales {
  /** Taille = nombre de neurones couverts (1 nœud d'onde par neurone). */
  readonly taille: number;
  private entraineur: EntraineurRPIA;

  constructor(taille = 100, options?: OptionsCoucheRPIA) {
    if (!Number.isInteger(taille) || taille < 1 || taille > 4096) {
      throw new Error(`Taille de couche invalide : ${taille} (1 – 4096).`);
    }
    this.taille = taille;
    this.entraineur = new EntraineurRPIA(taille, { graine: options?.graine ?? 42 });
  }

  /** État des nœuds d'onde (copie défensive), indexés comme les neurones. */
  noeuds(): NoeudOnde[] {
    return this.entraineur.etat();
  }

  /** Temps global d'interférence accumulé (télémétrie de la couche). */
  get pasTotaux(): number {
    return this.entraineur.pasTotaux;
  }

  /**
   * RÉSONANCE DE CHAT — un appel unique pour le flux conversationnel :
   * entraîne la couche vers l'onde cible du message PUIS retourne les
   * énergies prêtes à fusionner dans les entrées du cycle 1. Nombre
   * d'époques borné par l'appelant (latence du tour de chat).
   */
  resonnerVersTexte(texte: string, epoques = 12): ResultatPontRPIA {
    const rapport = this.entrainerVersTexte(texte, epoques);
    return { rapport, energies: this.energiesResonance() };
  }

  /** Onde cible d'un texte (conditionneur déterministe, longueur = taille). */
  cibleDepuisTexte(texte: string): Float32Array {
    return encoderTexteEnOndeCible(texte, this.taille);
  }

  /**
   * Entraîne la couche vers l'onde cible du texte : la résonance apprend
   * la requête. @returns le rapport honnête (courbe d'erreur complète).
   */
  entrainerVersTexte(
    texte: string,
    epoques = 120,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): RapportEntrainement {
    if (typeof texte !== "string" || texte.length === 0) {
      throw new Error("Texte de requête vide — rien à mettre en résonance.");
    }
    return this.entraineur.entrainer(this.cibleDepuisTexte(texte), epoques, config);
  }

  /** Variante directe : entraînement vers une onde cible fournie. */
  entrainerVersOnde(
    cible: OndeCible,
    epoques = 120,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): RapportEntrainement {
    return this.entraineur.entrainer(cible, epoques, config);
  }

  /** Erreur d'interférence courante contre une cible (diagnostic honnête). */
  entraineurErreurCourante(cible: OndeCible): number {
    return this.entraineur.erreurCourante(cible, 0.1 * this.entraineur.pasTotaux);
  }

  /**
   * Convertit l'état résonnant appris en énergies d'injection pour le
   * réseau neuronal { idNeurone: énergie } — le format EXACT de
   * `reseau.step(externalInputs, time)` (et de `inputsDirects` du noyau
   * central). Les nœuds qui résonnent fort excitent leur neurone.
   */
  energiesResonance(): Record<number, number> {
    const etat = this.entraineur.etat();
    const energies: Record<number, number> = {};
    for (let i = 0; i < etat.length; i++) {
      const energie = Math.min(ENERGIE_MAX, etat[i].amplitude * GAIN_ENERGIE);
      if (energie > 0) energies[i] = energie;
    }
    return energies;
  }

  /**
   * Qualité de résonance d'un neurone contre la cible courante :
   * 1.0 = interférence constructive (|onde − cible| < seuil), sinon
   * décroît avec l'erreur locale. Diagnostic fin post-entraînement.
   */
  resonanceDe(idNeurone: number, texte: string): number {
    const noeud = this.entraineur.etat()[idNeurone];
    if (!noeud) return 0;
    const cible = this.cibleDepuisTexte(texte);
    const onde = noeud.amplitude * Math.cos(noeud.frequence * 0.1 * this.entraineur.pasTotaux + noeud.phase);
    const interference = Math.abs(onde - cible[idNeurone]);
    return Math.max(0, 1 - interference);
  }

  /**
   * État sérialisable (JSON-safe) pour la persistance : poids arrondis
   * (6 décimales) — même contrat que training/persistence.ts.
   */
  exporterEtat(): EtatRPIA {
    const poids = Array.from(this.entraineur.exporterPoids()).map(
      (v) => Math.round(v * 1e6) / 1e6,
    );
    return { taille: this.taille, pasTotaux: this.entraineur.pasTotaux, poids };
  }

  /** Réinjecte un état exporté (même taille) — reprise sans ré-entraînement. */
  importerEtat(etat: EtatRPIA & { pasTotaux?: number }): void {
    if (etat.taille !== this.taille) {
      throw new Error(`État incompatible : taille ${etat.taille} ≠ ${this.taille}.`);
    }
    if (!Array.isArray(etat.poids) || etat.poids.length !== this.taille * 4) {
      throw new Error(
        `Poids incompatibles : ${Array.isArray(etat.poids) ? etat.poids.length : "format invalide"} valeurs reçues, ${this.taille * 4} attendues.`,
      );
    }
    // JSON.stringify transforme NaN/Infinity en null. Valider les types
    // AVANT Float32Array, qui convertirait silencieusement null en zéro.
    if (!etat.poids.every((poids) => Number.isFinite(poids))) {
      throw new Error("État RPIA invalide : chaque poids doit être un nombre fini.");
    }
    // Vérifier le compteur avant l'import des poids évite de laisser un
    // réseau partiellement restauré si le checkpoint est incohérent.
    if (
      etat.pasTotaux !== undefined &&
      (!Number.isInteger(etat.pasTotaux) || etat.pasTotaux < 0)
    ) {
      throw new Error(`Compteur de pas invalide : ${etat.pasTotaux} (entier ≥ 0 requis).`);
    }
    const poids = new Float32Array(etat.poids);
    // Float32Array peut convertir des nombres finis mais trop grands en
    // Infinity : le validateur du moteur rejette aussi ce cas avant mutation.
    this.entraineur.importerPoids(poids);
    // Le temps global fait partie de l'état : sans lui, la reprise
    // évaluerait les ondes à un autre instant que la source.
    if (etat.pasTotaux !== undefined) {
      this.entraineur.restaurerPas(etat.pasTotaux);
    }
  }
}

/** Résultat du pont complet (entraînement + injection). */
export interface ResultatPontRPIA {
  /** Rapport d'entraînement honnête (courbe d'erreur). */
  rapport: RapportEntrainement;
  /** Énergies à injecter dans reseau.step (ou inputsDirects du noyau). */
  energies: Record<number, number>;
}

/**
 * PONT HAUT NIVEAU : entraîne la couche d'ondes d'un cerveau vers une
 * requête et retourne les énergies prêtes pour `reseau.step`. Sans
 * effet de bord : l'injection reste à la charge de l'appelant (le
 * moteur neuronal décide du moment du cycle).
 */
export function entrainerCerveauParResonance(
  tailleReseau: number,
  texte: string,
  options?: { epoques?: number; config?: ConfigRPIA; graine?: number },
): ResultatPontRPIA {
  const couche = new CoucheOndesNeuronales(tailleReseau, { graine: options?.graine });
  const rapport = couche.entrainerVersTexte(texte, options?.epoques ?? 120, options?.config);
  return { rapport, energies: couche.energiesResonance() };
}
