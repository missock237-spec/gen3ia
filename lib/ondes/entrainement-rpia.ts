/**
 * ENTRAÎNEUR RPIA — implémentation CPU de référence de
 * `SHADER_ENTRAINEMENT_RPIA` (shaders-rpia.ts), portage fidèle de
 * waveTrainer.wgsl.
 *
 * Un réseau de N nœuds d'onde [amplitude, fréquence, phase,
 * amortissement] apprend à résonner vers une onde cible : à chaque
 * pas, l'interférence (onde produite − cible) pilote la règle RPIA :
 *
 *   · |interférence| < 0.05  → constructive : phase += lr·(1−cos φ),
 *     amortissement relâché (−0.002, plancher 0.001) ;
 *   · sinon                  → destructive : phase −= lr·sin(interf),
 *     amortissement renforcé (+0.005, plafond 0.5) ;
 *   · amplitude −= lr·interférence·0.1, bornée [0, 2].
 *
 * C'est le MIRROIR exact du compute shader : mêmes formules, mêmes
 * clamps. Il sert de repli universel (navigateurs sans WebGPU), de
 * moteur serveur (route /api/ondes/rpia) et de spécification exécutable
 * testée unitairement. Déterministe : la graine 42 reproduit le même
 * réseau initial à chaque création.
 */

import {
  BORNES_RPIA,
  RPIA_DEFAUTS,
  borner,
  calculerTempsGlobalRPIA,
  erreurInterference,
  rapportDepuisHistorique,
  validerCibleRPIA,
  validerConfigRPIA,
} from "./types-entrainement";
import type { ConfigRPIA, NoeudOnde, OndeCible, RapportEntrainement } from "./types-entrainement";

/** Options de création de l'entraîneur. */
export interface OptionsEntraineurRPIA {
  /** Graine du générateur déterministe (défaut 42, comme le champ). */
  graine?: number;
  /** Amplitude initiale commune (défaut 1.0). */
  amplitudeInitiale?: number;
}

export class EntraineurRPIA {
  readonly nbNoeuds: number;
  private noeuds: NoeudOnde[];
  private compteurPas = 0;

  constructor(nbNoeuds: number, options?: OptionsEntraineurRPIA) {
    if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1) {
      throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (entier ≥ 1 requis).`);
    }
    this.nbNoeuds = nbNoeuds;
    this.noeuds = new Array<NoeudOnde>(nbNoeuds);

    // RNG déterministe (LCG, même famille que le champ d'ondes).
    let graine = (options?.graine ?? 42) >>> 0;
    const alea = () => {
      graine = (graine * 1664525 + 1013904223) >>> 0;
      return graine / 0xffffffff;
    };

    const amplitude = options?.amplitudeInitiale ?? 1.0;
    if (
      !Number.isFinite(amplitude) ||
      amplitude < BORNES_RPIA.amplitudeMin ||
      amplitude > BORNES_RPIA.amplitudeMax
    ) {
      throw new Error(
        `Amplitude initiale invalide : ${amplitude} (valeur finie entre ${BORNES_RPIA.amplitudeMin} et ${BORNES_RPIA.amplitudeMax} requise).`,
      );
    }
    for (let i = 0; i < nbNoeuds; i++) {
      this.noeuds[i] = {
        amplitude,
        // Bande utile du champ W-DNN (cf. encodeur.ts : 0.03 – 0.17 rad/pas),
        // légèrement élargie pour laisser de la marge de convergence.
        frequence: 0.03 + alea() * 0.14,
        phase: alea() * Math.PI * 2,
        amortissement: 0.05,
      };
    }
  }

  /** Copie défensive de l'état courant des nœuds. */
  etat(): NoeudOnde[] {
    return this.noeuds.map((n) => ({ ...n }));
  }

  /** Nombre total de pas d'entraînement exécutés. */
  get pasTotaux(): number {
    return this.compteurPas;
  }

  /**
   * UN pas d'entraînement — MIRROIR exact du shader RPIA. La cible doit
   * couvrir les N nœuds (le shader lit ondeCible[idx] pour chaque idx).
   *
   * @returns L'erreur d'interférence moyenne APRÈS le pas.
   */
  pasEntrainement(cible: OndeCible, config: ConfigRPIA = RPIA_DEFAUTS): number {
    this.verifierCible(cible);
    this.verifierConfig(config);
    const lr = config.tauxApprentissage;
    // Le shader évalue l'onde avec le pasDeTemps passé en uniforme — le
    // miroir utilise le même temps pour l'évaluation et la correction du
    // pas, puis mesure l'erreur APRÈS correction au même temps : la
    // courbe d'erreur reflète l'apprentissage seul (pas la dérive du temps).
    const tempsOnde = calculerTempsGlobalRPIA(config, this.compteurPas);

    for (let i = 0; i < this.nbNoeuds; i++) {
      const noeud = this.noeuds[i];
      const ondeAvant = noeud.amplitude * Math.cos(noeud.frequence * tempsOnde + noeud.phase);
      const interference = ondeAvant - cible[i];

      if (Math.abs(interference) < BORNES_RPIA.seuilConstructif) {
        // Interférence constructive : renforcement de la résonance.
        noeud.phase += lr * (1.0 - Math.cos(noeud.phase));
        noeud.amortissement = Math.max(
          BORNES_RPIA.amortissementMin,
          noeud.amortissement - 0.002,
        );
      } else {
        // Interférence destructive : déphasage adaptatif anti-bruit.
        noeud.phase -= lr * Math.sin(interference);
        noeud.amortissement = Math.min(
          BORNES_RPIA.amortissementMax,
          noeud.amortissement + 0.005,
        );
      }

      noeud.amplitude = borner(
        noeud.amplitude - lr * interference * 0.1,
        BORNES_RPIA.amplitudeMin,
        BORNES_RPIA.amplitudeMax,
      );
    }

    this.compteurPas++;
    return erreurInterference(this.noeuds, cible, tempsOnde);
  }

  /**
   * Entraînement complet : `epoques` pas vers la cible, avec courbe
   * d'erreur. HONNÊTETÉ : le rapport ne déclare la convergence que si
   * l'erreur finale est STRICTEMENT inférieure à l'erreur initiale.
   */
  entrainer(
    cible: OndeCible,
    epoques: number,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): RapportEntrainement {
    this.verifierCible(cible);
    if (!Number.isInteger(epoques) || epoques < 1) {
      throw new Error(`Nombre d'époques invalide : ${epoques} (entier ≥ 1 requis).`);
    }
    this.verifierConfig(config);
    // Mesurer le point de départ avant toute mise à jour. L'ancien code
    // prenait historique[0], donc l'erreur APRÈS le premier pas, comme
    // "erreur initiale" : le rapport pouvait masquer une régression au
    // premier pas et ne représentait pas réellement l'état de départ.
    const tempsInitial = calculerTempsGlobalRPIA(config, this.compteurPas);
    const erreurAvantEntrainement = erreurInterference(this.noeuds, cible, tempsInitial);
    const historique: number[] = [];
    for (let e = 0; e < epoques; e++) {
      historique.push(this.pasEntrainement(cible, config));
    }
    return rapportDepuisHistorique(historique, erreurAvantEntrainement);
  }

  /**
   * Exporte les poids appris — format fidèle à l'export GPU :
   * [amplitude, fréquence, phase, amortissement] × N (longueur 4·N),
   * prêt à être packagé (« poids d'ondes prêts pour le packaging »).
   */
  exporterPoids(): Float32Array {
    const poids = new Float32Array(this.nbNoeuds * 4);
    for (let i = 0; i < this.nbNoeuds; i++) {
      const n = this.noeuds[i];
      poids[i * 4] = n.amplitude;
      poids[i * 4 + 1] = n.frequence;
      poids[i * 4 + 2] = n.phase;
      poids[i * 4 + 3] = n.amortissement;
    }
    return poids;
  }

  /** Réinjecte des poids exportés (même taille 4·N) — reprise d'entraînement. */
  importerPoids(poids: Float32Array): void {
    if (poids.length !== this.nbNoeuds * 4) {
      throw new Error(
        `Poids incompatibles : ${poids.length} valeurs reçues, ${this.nbNoeuds * 4} attendues.`,
      );
    }
    // Valider l'intégralité du buffer AVANT de muter le réseau : un seul
    // NaN/Infinity venant d'un checkpoint corrompu rendrait toute la
    // dynamique d'ondes inutilisable et pourrait contaminer les métriques.
    for (let i = 0; i < poids.length; i++) {
      if (!Number.isFinite(poids[i])) {
        throw new Error(`Poids RPIA non fini à l'index ${i}.`);
      }
    }
    for (let i = 0; i < this.nbNoeuds; i++) {
      this.noeuds[i] = {
        amplitude: borner(poids[i * 4], BORNES_RPIA.amplitudeMin, BORNES_RPIA.amplitudeMax),
        frequence: poids[i * 4 + 1],
        phase: poids[i * 4 + 2],
        amortissement: borner(
          poids[i * 4 + 3],
          BORNES_RPIA.amortissementMin,
          BORNES_RPIA.amortissementMax,
        ),
      };
    }
  }

  /**
   * Restaure le compteur de pas d'un état exporté — indispensable pour
   * que la reprise évalue les ondes au MÊME temps que la source (la
   * physique dépend du temps global, pas seulement des poids).
   */
  restaurerPas(pas: number): void {
    if (!Number.isSafeInteger(pas) || pas < 0) {
      throw new Error(`Compteur de pas invalide : ${pas} (entier sûr ≥ 0 requis).`);
    }
    this.compteurPas = pas;
  }

  /** Erreur d'interférence moyenne courante contre une cible. */
  erreurCourante(cible: OndeCible, temps: number): number {
    this.verifierCible(cible);
    return erreurInterference(this.noeuds, cible, temps);
  }

  private verifierConfig(config: ConfigRPIA): void {
    validerConfigRPIA(config);
  }

  private verifierCible(cible: OndeCible): void {
    validerCibleRPIA(cible, this.nbNoeuds);
  }
}
