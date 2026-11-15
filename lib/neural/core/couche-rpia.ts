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
 *   · les énergies injectées sont bornées [0, 0.5] ; seul le lobe
 *     excitateur de la valeur instantanée de l'onde alimente le SNN.
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
  /** Pas temporel de la simulation ; absent dans les checkpoints historiques (défaut 0.1). */
  pasDeTemps?: number;
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
  /** Dernier pas de temps appris : conserve le même rythme pour lire l'onde. */
  private dernierPasDeTemps = RPIA_DEFAUTS.pasDeTemps;

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
    // Le taux de temps devient l'horloge de lecture de l'onde jusqu'au
    // prochain entraînement ; sa validation est portée par l'entraîneur.
    const rapport = this.entraineur.entrainer(this.cibleDepuisTexte(texte), epoques, config);
    this.dernierPasDeTemps = config.pasDeTemps;
    return rapport;
  }

  /** Variante directe : entraînement vers une onde cible fournie. */
  entrainerVersOnde(
    cible: OndeCible,
    epoques = 120,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): RapportEntrainement {
    const rapport = this.entraineur.entrainer(cible, epoques, config);
    this.dernierPasDeTemps = config.pasDeTemps;
    return rapport;
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
    // Lire la valeur instantanée de l'onde à l'instant suivant : amplitude
    // seule ne distingue pas les phases apprises de deux requêtes différentes.
    // Math.fround reproduit la précision de l'horloge float32 envoyée au shader.
    const tempsGlobal = Math.fround(this.dernierPasDeTemps * this.entraineur.pasTotaux);
    if (!Number.isFinite(tempsGlobal)) {
      throw new Error("Temps de lecture RPIA non fini.");
    }
    for (let i = 0; i < etat.length; i++) {
      const noeud = etat[i];
      const ondeInstantanee =
        noeud.amplitude * Math.cos(noeud.frequence * tempsGlobal + noeud.phase);
      // Le noyau SNN reçoit des énergies excitatrices : les phases négatives
      // ne deviennent pas des inhibitions implicites. L'amplitude, la phase,
      // la fréquence et le temps déterminent néanmoins chaque excitation.
      const energie = Math.min(ENERGIE_MAX, Math.max(0, ondeInstantanee * GAIN_ENERGIE));
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
    const tempsGlobal = Math.fround(this.dernierPasDeTemps * this.entraineur.pasTotaux);
    const onde = noeud.amplitude * Math.cos(noeud.frequence * tempsGlobal + noeud.phase);
    const interference = Math.abs(onde - cible[idNeurone]);
    return Math.max(0, 1 - interference);
  }

  /**
   * Restaure un état ancien dans une couche plus grande sans perdre les
   * poids appris des neurones existants. Les neurones nouvellement ajoutés
   * gardent l'initialisation déterministe de la couche cible. Cette méthode
   * sert aux migrations de taille (par exemple 100 → 140 neurones).
   *
   * La couche source est validée dans une instance temporaire AVANT toute
   * mutation de la cible ; un checkpoint invalide ne laisse donc pas un
   * cerveau partiellement restauré.
   */
  importerEtatEtendu(etat: EtatRPIA): void {
    if (etat.taille > this.taille) {
      throw new Error(
        `Extension impossible : état de ${etat.taille} nœuds pour une couche de ${this.taille} nœuds.`,
      );
    }
    if (etat.taille === this.taille) {
      this.importerEtat(etat);
      return;
    }

    const source = new CoucheOndesNeuronales(etat.taille);
    source.importerEtat(etat);
    const poidsCibles = this.entraineur.exporterPoids();
    poidsCibles.set(source.entraineur.exporterPoids());

    // Les poids existants remplacent le préfixe correspondant ; le suffixe
    // de la couche cible reste dans son état initial/appris courant.
    this.entraineur.importerPoids(poidsCibles);
    this.entraineur.restaurerPas(etat.pasTotaux);
    this.dernierPasDeTemps = source.dernierPasDeTemps;
  }

  /**
   * État sérialisable (JSON-safe) pour la persistance.
   *
   * Conserver les valeurs float32 exactes garantit qu'une restauration ne
   * change pas silencieusement la phase ou l'amplitude des oscillateurs. Le
   * JSON conserve assez de chiffres pour reconstruire exactement chaque
   * valeur float32, contrairement à un arrondi arbitraire à six décimales.
   */
  exporterEtat(): EtatRPIA {
    const poids = Array.from(this.entraineur.exporterPoids());
    return {
      taille: this.taille,
      pasTotaux: this.entraineur.pasTotaux,
      pasDeTemps: this.dernierPasDeTemps,
      poids,
    };
  }

  /** Réinjecte un état exporté (même taille) — reprise sans ré-entraînement. */
  importerEtat(etat: Omit<EtatRPIA, "pasTotaux"> & { pasTotaux?: number }): void {
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
      (!Number.isSafeInteger(etat.pasTotaux) || etat.pasTotaux < 0)
    ) {
      throw new Error(`Compteur de pas invalide : ${etat.pasTotaux} (entier ≥ 0 requis).`);
    }
    const pasDeTemps = etat.pasDeTemps ?? RPIA_DEFAUTS.pasDeTemps;
    if (
      !Number.isFinite(pasDeTemps) ||
      !Number.isFinite(Math.fround(pasDeTemps)) ||
      pasDeTemps <= 0 ||
      Math.fround(pasDeTemps) <= 0
    ) {
      throw new Error("Pas de temps RPIA invalide : valeur positive et représentable en float32 requise.");
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
    this.dernierPasDeTemps = pasDeTemps;
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
