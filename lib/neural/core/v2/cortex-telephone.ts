/**
 * CORTEX TÉLÉPHONE (it.73 — demande propriétaire : « que gen3 puisse
 * fonctionner même sur un téléphone tout en gardant sa qualité de
 * compétences »).
 *
 * Moteur SNN COMPACT EMBARQUÉ : le même modèle mathématique que
 * `CortexColumnnaire` (accumulate-and-fire, CSR événementiel, décroissance
 * paresseuse exacte, lecture graduée par bande), mais sous la configuration
 * de sobriété embarquée :
 *  - 2^17 colonnes (131 072 — mémoire totale ~9 Mo au lieu de ~122 Mo) ;
 *  - POIDS U8 : les poids quantifiés (erreur ≤ 1/510 par poids, mesurée
 *    par la campagne it.73) sont DÉQUANTIFIÉS À LA VOLÉE — aucune copie
 *    f32 résidente ; l'horloge de dernier spike n'existe pas (lecture
 *    seule : la plasticité qui la lirait n'écrit jamais) — −4 o/colonne ;
 *  - HORLOGES U32 (exact < 2^32 — une session de navigation reste des
 *    millions de cycles sous le plafond) ;
 *  - LECTURE SEULE PAR CONCEPTION : le téléphone répond, il ne s'entraîne
 *    pas (les poids viennent du snapshot entraîné côté serveur — la
 *    qualité apprise est celle du serveur, pas une ré-approximation) ;
 *  - structure CSR générée par la fonction PURE PARTAGÉE
 *    (`remplirStructureCSR`) — même câblage bit à bit que la production.
 *
 * L'ÉQUIVALENCE MOTEUR est prouvée par la garde 42ᵉ : chargé avec des
 * poids f32 exacts, ce moteur produit des spikes BIT À BIT identiques à
 * `CortexColumnnaire` en lecture seule sur la même séquence — la seule
 * différence du mode téléphone est la quantification u8, mesurée
 * séparément (accord des sondes commis dans l'artefact it.73).
 *
 * Module PUR — aucune dépendance Node, aucune I/O — importable par le
 * navigateur (page /mobile) comme par Node (campagne, tests, garde).
 */

import { remplirStructureCSR } from "./structure-csr";
import {
  hashTokenVersColonne,
  INTENSITE_MAX_CORTEX,
  INTENSITE_TOKEN_CORTEX,
} from "./cortex-columnnaire";
import type { MetabolismePasV2 } from "./cortex-columnnaire";
import type { EnteteSnapshotTelephone } from "./energie";

/** Configuration d'un cortex téléphone (déduite de l'en-tête du snapshot). */
export interface ConfigCortexTelephone {
  colonnes: number;
  voisins: number;
  bandes: number;
  bandesLecture: number;
  seed: number;
  seuil: number;
  decroissance: number;
  plasticiteFenetre: number;
}

/**
 * Construit la config depuis l'en-tête d'un snapshot (source unique —
 * le navigateur n'invente aucun paramètre).
 */
export function configDepuisEntete(
  entete: EnteteSnapshotTelephone,
): ConfigCortexTelephone {
  return {
    colonnes: entete.colonnes,
    voisins: entete.voisins,
    bandes: entete.bandes,
    bandesLecture: entete.bandesLecture,
    seed: entete.seed,
    seuil: entete.seuil,
    decroissance: entete.decroissance,
    plasticiteFenetre: entete.plasticiteFenetre,
  };
}

/** Statistiques du moteur compact (mémoire RÉELLE, octets mesurés). */
export interface StatsCortexTelephone {
  colonnes: number;
  aretes: number;
  bandes: number;
  /** Mémoire résidente totale en octets (typed arrays réels). */
  octetsResidentiels: number;
  /** Détail par tampon (octets mesurés). */
  detail: {
    energies: number;
    horloges: number;
    drapeaux: number;
    structure: number;
    poidsU8: number;
  };
  /** Mode des poids (toujours u8 dans ce moteur). */
  poids: "u8";
  /** Lecture seule (toujours — le téléphone ne s'entraîne pas). */
  lectureSeule: true;
}

const PLAFOND_U32 = 4294967295;

/**
 * CORTEX TÉLÉPHONE — réservoir columnnaire compact, lecture seule.
 */
export class CortexTelephone {
  readonly config: ConfigCortexTelephone;

  readonly energies: Float32Array;
  private readonly dernierTouche: Uint32Array;
  private readonly flagSpike: Uint8Array;
  private readonly enFile: Uint8Array;
  private enAttente: number[] = [];

  private readonly csrOffset: Uint32Array;
  private readonly csrCible: Uint32Array;
  /** Poids quantifiés (source unique — déquant à la volée × 1/255). */
  private readonly poidsU8: Uint8Array;

  private readonly dernierResonance: Float32Array;
  private readonly energieBandes: Float32Array;

  readonly metabolismeDernierPas: MetabolismePasV2 = {
    evaluees: 0,
    reposes: 0,
    transmissions: 0,
    ms: 0,
    normalisations: 0,
  };

  private msCycle = 0;

  constructor(
    config: ConfigCortexTelephone,
    poidsU8: Uint8Array,
  ) {
    this.config = config;
    const n = config.colonnes;
    const aretes = n * config.voisins;
    // it.73 — refus honnête AVANT toute allocation (config d'abord).
    if (n > PLAFOND_U32) {
      throw new Error(
        `CortexTelephone : ${n} colonnes hors capacité u32 (plafond ${PLAFOND_U32}).`,
      );
    }
    if (poidsU8.length !== aretes) {
      throw new Error(
        `CortexTelephone : ${poidsU8.length} poids ≠ ${aretes} arêtes.`,
      );
    }

    this.energies = new Float32Array(n);
    this.dernierTouche = new Uint32Array(n);
    this.flagSpike = new Uint8Array(n);
    this.enFile = new Uint8Array(n);
    this.csrOffset = new Uint32Array(n + 1);
    this.csrCible = new Uint32Array(aretes);
    this.poidsU8 = poidsU8;
    this.dernierResonance = new Float32Array(config.bandes);
    this.energieBandes = new Float32Array(config.bandes);

    // MÊME câblage que la production (fonction pure partagée) — les poids
    // viennent du snapshot (les initiaux f32 ne sont pas générés : zéro
    // allocation temporaire — voir remplirStructureCSR, poids optionnels).
    remplirStructureCSR(config, this.csrOffset, this.csrCible);
  }

  /** Déquantification à la volée (× 1/255 — aucune copie résidente). */
  private poidsDe(p: number): number {
    return this.poidsU8[p]! / 255;
  }

  private avancerDecroissance(c: number, t: number): void {
    const dt = t - this.dernierTouche[c]!;
    if (dt <= 0) return;
    const facteur =
      dt === 1
        ? 1 - this.config.decroissance
        : Math.pow(1 - this.config.decroissance, dt);
    this.energies[c] *= facteur;
    this.dernierTouche[c] = t;
  }

  private evaluerColonne(c: number, injection: number, t: number): boolean {
    if (this.flagSpike[c] === 1) return false; // déjà spiké ce cycle
    this.avancerDecroissance(c, t);
    if (injection !== 0) {
      this.energies[c] += injection * (1 - this.config.decroissance);
    }
    if (this.energies[c] >= this.config.seuil) {
      this.energies[c] = 0;
      this.flagSpike[c] = 1;
      return true;
    }
    return false;
  }

  /** Refus honnête au-delà de la capacité u32 (session hors sol). */
  private verifierHorloge(t: number): void {
    if (t > PLAFOND_U32) {
      throw new Error(
        `Horloge ${t} hors capacité u32 (moteur téléphone) — ` +
        "réinitialisez les énergies (reinitialiserEnergies) pour une session fraîche.",
      );
    }
  }

  /**
   * Pas complet — sémantique EXACTE de `CortexColumnnaire.pas` en lecture
   * seule (équivalence prouvée par la garde 42ᵉ avec poids f32 exacts) :
   * évaluation des transmissions en attente + injections, un spike max par
   * colonne et par cycle, transmission CSR après l'update, lecture graduée
   * par bande, déduplication de la file d'attente, métabolisme mesuré.
   * ZÉRO écriture de poids (lecture seule par conception).
   */
  pas(injections: Array<[number, number]> | null, t: number): number[] {
    const debut = performance.now();
    this.verifierHorloge(t);
    const spikes: number[] = [];
    const { voisins, bandes, colonnes } = this.config;
    let evaluees = 0;

    // ---- (1)+(2) Évaluation : transmissions en attente + injections ------
    if (this.enAttente.length > 0) {
      const attente = this.enAttente;
      this.enAttente = [];
      evaluees += attente.length;
      for (const c of attente) {
        this.enFile[c] = 0;
        if (this.evaluerColonne(c, 0, t)) spikes.push(c);
      }
    }
    if (injections && injections.length > 0) {
      evaluees += injections.length;
      for (const [c, valeur] of injections) {
        if (c < 0 || c >= colonnes) continue;
        if (this.evaluerColonne(c, valeur, t)) spikes.push(c);
      }
    }

    // ---- (3) Transmission CSR le long des colonnes qui ont spiké ---------
    const parBande = Math.floor(colonnes / bandes);
    this.energieBandes.fill(0);
    for (const s of spikes) {
      const base = s * voisins;
      for (let k = 0; k < voisins; k++) {
        const p = base + k;
        const cible = this.csrCible[p]!;
        this.avancerDecroissance(cible, t);
        const poids = this.poidsDe(p);
        this.energies[cible] += poids;
        this.energieBandes[Math.min(bandes - 1, Math.floor(cible / parBande))] +=
          poids;
        if (this.enFile[cible] === 0) {
          this.enFile[cible] = 1;
          this.enAttente.push(cible);
        }
        // Lecture seule : la plasticité n'écrit jamais (conception).
      }
    }

    // Résonance SPIKE par bande (fraction de la bande ayant spiké ce cycle).
    this.dernierResonance.fill(0);
    for (const s of spikes) {
      this.dernierResonance[Math.min(bandes - 1, Math.floor(s / parBande))] += 1;
    }
    for (let b = 0; b < bandes; b++) {
      this.dernierResonance[b] /= parBande;
    }

    for (const s of spikes) this.flagSpike[s] = 0;

    const cout = performance.now() - debut;
    this.msCycle = this.msCycle === 0 ? cout : this.msCycle * 0.9 + cout * 0.1;

    this.metabolismeDernierPas.evaluees = evaluees;
    this.metabolismeDernierPas.reposes = colonnes - evaluees;
    this.metabolismeDernierPas.transmissions = spikes.length * voisins;
    this.metabolismeDernierPas.ms = cout;
    this.metabolismeDernierPas.normalisations = 0;

    return spikes;
  }

  /**
   * Projection texte → colonnes : MÊMES règles que la production (hash
   * FNV-1a partagé, mêmes intensités, même cap) — l'onde d'une question
   * est identique sur le téléphone et sur le serveur.
   */
  projetterTokens(tokens: string[]): Array<[number, number]> {
    const accumule = new Map<number, number>();
    for (const token of tokens) {
      if (token.length === 0) continue;
      const colonne = hashTokenVersColonne(token, this.config.colonnes);
      const suivant = Math.min(
        INTENSITE_MAX_CORTEX,
        (accumule.get(colonne) ?? 0) + INTENSITE_TOKEN_CORTEX,
      );
      accumule.set(colonne, suivant);
    }
    return Array.from(accumule.entries());
  }

  /** Bande d'appartenance d'une colonne. */
  bandeDe(colonne: number): number {
    const parBande = Math.floor(this.config.colonnes / this.config.bandes);
    return Math.min(this.config.bandes - 1, Math.floor(colonne / parBande));
  }

  /** Résonance par bande du dernier pas (copie défensive). */
  resonanceBandes(): number[] {
    return Array.from(this.dernierResonance);
  }

  /**
   * LECTURE GRADUÉE normalisée par bande — même lecture que la production
   * (part de l'énergie reçue par bande via les transmissions du dernier pas).
   */
  activationBandes(): number[] {
    let somme = 0;
    for (let b = 0; b < this.energieBandes.length; b++) somme += this.energieBandes[b];
    const sortie = new Array<number>(this.energieBandes.length);
    if (somme <= 0) {
      sortie.fill(0);
      return sortie;
    }
    for (let b = 0; b < this.energieBandes.length; b++) {
      sortie[b] = this.energieBandes[b] / somme;
    }
    return sortie;
  }

  /** Remet à zéro l'état transitoire (nouvelle session d'inférence) —
   *  miroir EXACT de `CortexColumnnaire.reinitialiserEnergies` (les
   *  horloges de dernier touché sont remises à zéro ; pas de dernierSpike
   *  dans ce moteur : lecture seule, la plasticité n'existe pas). */
  reinitialiserEnergies(): void {
    this.energies.fill(0);
    this.dernierTouche.fill(0);
    this.enAttente = [];
    this.enFile.fill(0);
    this.dernierResonance.fill(0);
    this.energieBandes.fill(0);
  }

  /** Stats descriptives — mémoire RÉELLE mesurée sur les typed arrays. */
  stats(): StatsCortexTelephone {
    const n = this.config.colonnes;
    const aretes = n * this.config.voisins;
    const detail = {
      energies: this.energies.byteLength,
      horloges: this.dernierTouche.byteLength,
      drapeaux: this.flagSpike.byteLength + this.enFile.byteLength,
      structure: this.csrOffset.byteLength + this.csrCible.byteLength,
      poidsU8: this.poidsU8.byteLength,
    };
    const octetsResidentiels =
      detail.energies + detail.horloges + detail.drapeaux + detail.structure + detail.poidsU8;
    return {
      colonnes: n,
      aretes,
      bandes: this.config.bandes,
      octetsResidentiels,
      detail,
      poids: "u8",
      lectureSeule: true,
    };
  }

  /** Coût EMA d'un pas (ms) — télémétrie honnête. */
  get msCycleEma(): number {
    return Math.round(this.msCycle * 1000) / 1000;
  }
}

/**
 * Construit un cortex téléphone depuis un snapshot binaire validé
 * (importerSnapshotTelephone) — le chemin unique du navigateur.
 */
export function cortexDepuisSnapshot(
  entete: EnteteSnapshotTelephone,
  poidsU8: Uint8Array,
): CortexTelephone {
  return new CortexTelephone(configDepuisEntete(entete), poidsU8);
}
